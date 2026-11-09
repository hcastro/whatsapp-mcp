import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
import { proto } from "@whiskeysockets/baileys";
let download = async () => Buffer.from("attachment contents");
mock.module("../dist/media.js", {
  namedExports: { fetchMedia: (...args) => download(...args) },
});
const { connectedReader } = await import("../dist/connected.js");
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-connected-"));
  const path = join(dir, "config.json");
  const config = { dataDir: dir, allowedChats: ["111@s.whatsapp.net"] };
  writeFileSync(path, JSON.stringify(config));
  const archive = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  t.after(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const item = {
    id: messageId(config.allowedChats[0], "a", false),
    chatId: config.allowedChats[0],
    sourceId: "a",
    fromMe: false,
    senderId: null,
    timestamp: 100,
    text: "live fixture",
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: null,
    mimeType: null,
  };
  const socket = {
    query: async () => ({ attrs: { type: "result" } }),
    fetchMessageHistory: async () => {
      archive.ingest(item);
      archive.recordHistory([item.chatId]);
    },
    sendPeerDataOperationMessage: async () => {},
  };
  let connected = true;
  const controller = new AbortController();
  const reader = connectedReader(
    archive,
    () => {
      if (!connected) throw new Error("disconnected");
      return socket;
    },
    controller.signal,
  );
  return {
    archive,
    item,
    reader,
    socket,
    config,
    path,
    disconnect: () => {
      connected = false;
      controller.abort();
    },
  };
}
const request = {
  operation: "read",
  chatId: "111@s.whatsapp.net",
  limit: 50,
  requestHistory: true,
};
test("live reader verifies a server round-trip and includes messages received while querying", async (t) => {
  const { archive, item, reader, socket, disconnect } = setup(t);
  socket.query = async () => {
    archive.ingest(item);
    return { attrs: { type: "result" } };
  };
  const result = await reader(request);
  assert.equal(result.messages[0].text, "live fixture");
  assert.equal(result.freshness.connected, true);
  disconnect();
  await assert.rejects(reader(request), /disconnected|aborted/);
});
test("empty selected chat requests history and then returns actual delivered messages", async (t) => {
  const { reader, socket } = setup(t);
  const original = socket.fetchMessageHistory;
  const calls = [];
  socket.fetchMessageHistory = async (...args) => {
    calls.push(args);
    await original();
  };
  const result = await reader(request);
  assert.equal(result.history.state, "history-observed");
  assert.equal(result.messages.length, 1);
  assert.equal(calls[0][1].remoteJid, request.chatId);
  assert.equal(calls[0][1].id, undefined);
});
test("revocation during server probe blocks both content return and history requests", async (t) => {
  const { reader, socket, config, path } = setup(t);
  let requests = 0;
  socket.query = async () => {
    config.allowedChats = [];
    writeFileSync(path, JSON.stringify(config));
    return { attrs: { type: "result" } };
  };
  socket.fetchMessageHistory = async () => {
    requests++;
  };
  await assert.rejects(reader(request), /not selected/);
  assert.equal(requests, 0);
});
test("attachment contents are fetched on demand even when eager media caching is disabled", async (t) => {
  const { reader, archive, item } = setup(t);
  const record = { ...item, mediaType: "document", mimeType: "text/plain" };
  archive.ingest(record);
  const raw = {
    key: { remoteJid: item.chatId, id: item.sourceId, fromMe: false },
    message: {
      documentMessage: {
        fileName: "note.txt",
        mimetype: "text/plain",
        mediaKey: Buffer.alloc(32),
      },
    },
  };
  archive.saveAttachmentSource(
    item.id,
    0,
    proto.WebMessageInfo.encode(raw).finish(),
    "note.txt",
  );
  const result = await reader({
    operation: "attachment",
    messageId: item.id,
    page: 1,
    startRow: 1,
  });
  assert.equal(result.text, "attachment contents");
  assert.equal(result.fileName, "note.txt");
});
test("attachment authorization is checked again after download and parsing", async (t) => {
  const { reader, archive, item, config, path } = setup(t);
  archive.ingest({ ...item, mediaType: "document" });
  archive.saveAttachmentSource(
    item.id,
    0,
    proto.WebMessageInfo.encode({
      key: { remoteJid: item.chatId, id: item.sourceId },
      message: { documentMessage: { fileName: "note.txt" } },
    }).finish(),
    "note.txt",
  );
  download = async () => {
    config.allowedChats = [];
    writeFileSync(path, JSON.stringify(config));
    return Buffer.from("private");
  };
  t.after(() => {
    download = async () => Buffer.from("attachment contents");
  });
  await assert.rejects(
    reader({
      operation: "attachment",
      messageId: item.id,
      page: 1,
      startRow: 1,
    }),
    /unavailable or not selected/,
  );
});

test("ordinary live updates and cached messages do not establish history delivery", async (t) => {
  const { archive, item, reader, socket } = setup(t);
  archive.ingest(item);
  socket.fetchMessageHistory = async () => {
    archive.ingest({
      ...item,
      sourceId: "b",
      id: messageId(item.chatId, "b", false),
      timestamp: 200,
    });
  };
  const result = await reader(request);
  assert.equal(result.messages.length, 2);
  assert.equal(result.history.state, "waiting-for-phone");
});

test("account access permits any named conversation and enables approved history recovery", async (t) => {
  const { config, path, archive, reader, socket } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  const chatId = "222@s.whatsapp.net";
  archive.discover([{ id: chatId, name: "Other directed conversation" }]);
  assert.equal(
    archive.availableChats().some((chat) => chat.id === chatId),
    true,
  );
  let fullRequests = 0;
  socket.fetchMessageHistory = async () => {};
  socket.sendPeerDataOperationMessage = async (payload) => {
    assert.equal(
      payload.peerDataOperationRequestType,
      proto.Message.PeerDataOperationRequestType.FULL_HISTORY_SYNC_ON_DEMAND,
    );
    fullRequests++;
  };
  const result = await reader({ ...request, chatId });
  assert.equal(result.history.state, "full-history-requested");
  assert.equal(fullRequests, 1);
  await reader({ ...request, chatId });
  assert.equal(fullRequests, 1);
  config.access = "selected";
  writeFileSync(path, JSON.stringify(config));
  await assert.rejects(reader({ ...request, chatId }), /not selected/);
});

test("client cancellation aborts attachment transfer and releases the live reader", async (t) => {
  const { reader, archive, item } = setup(t);
  archive.ingest({ ...item, mediaType: "document" });
  archive.saveAttachmentSource(
    item.id,
    0,
    proto.WebMessageInfo.encode({
      key: { remoteJid: item.chatId, id: item.sourceId },
      message: { documentMessage: { fileName: "note.txt" } },
    }).finish(),
    "note.txt",
  );
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  download = async (_raw, _limit, signal) => {
    started();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  };
  t.after(() => {
    download = async () => Buffer.from("attachment contents");
  });
  const controller = new AbortController();
  const pending = reader(
    { operation: "attachment", messageId: item.id, page: 1, startRow: 1 },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending, /download failed/);
  await ready;
  controller.abort();
  await rejected;
  assert.equal(
    (await reader({ ...request, requestHistory: false })).messages.length,
    1,
  );
});

test("account recovery handles an anchorless refusal and notices delayed history", async (t) => {
  const { reader, socket, config, path, archive, item } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  socket.fetchMessageHistory = async () => {
    throw new Error("phone rejected anchorless request");
  };
  let fullRequests = 0;
  socket.sendPeerDataOperationMessage = async () => {
    fullRequests++;
  };
  assert.equal((await reader(request)).history.state, "full-history-requested");
  assert.equal(fullRequests, 1);
  archive.ingest(item);
  archive.recordHistory([item.chatId]);
  const later = await reader({ ...request, requestHistory: false });
  assert.equal(later.history.state, "history-observed");
  assert.equal(later.messages.length, 1);
  assert.equal(fullRequests, 1);
});

test("selected scope and revoked account scope cannot recover full history after refusal", async (t) => {
  const { reader, socket, config, path } = setup(t);
  let fullRequests = 0;
  socket.sendPeerDataOperationMessage = async () => {
    fullRequests++;
  };
  socket.fetchMessageHistory = async () => {
    throw new Error("phone refusal");
  };
  await assert.rejects(reader(request), /phone refusal/);
  config.access = "account";
  config.allowedChats.push("222@s.whatsapp.net");
  writeFileSync(path, JSON.stringify(config));
  socket.fetchMessageHistory = async () => {
    config.access = "selected";
    writeFileSync(path, JSON.stringify(config));
    throw new Error("revoked before fallback");
  };
  await assert.rejects(
    reader({ ...request, chatId: "222@s.whatsapp.net" }),
    /revoked before fallback/,
  );
  assert.equal(fullRequests, 0);
});

test("cancelled anchorless request cannot start recovery", async (t) => {
  const { reader, socket, config, path } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  const controller = new AbortController();
  let fullRequests = 0;
  socket.sendPeerDataOperationMessage = async () => {
    fullRequests++;
  };
  socket.fetchMessageHistory = async () => {
    controller.abort();
    throw new Error("cancelled");
  };
  await assert.rejects(reader(request, { signal: controller.signal }));
  assert.equal(fullRequests, 0);
});

test("explicit recent recovery runs on a full cached page and can recover newer messages", async (t) => {
  const { archive, item, reader, socket, config, path } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  archive.ingest(item);
  let scoped = 0;
  let full = 0;
  socket.fetchMessageHistory = async (_count, key, timestamp) => {
    scoped++;
    assert.deepEqual(key, { remoteJid: item.chatId });
    assert.ok(timestamp > item.timestamp * 1000);
    throw new Error("phone refused anchorless request");
  };
  socket.sendPeerDataOperationMessage = async () => {
    full++;
    archive.ingest({
      ...item,
      id: messageId(item.chatId, "new", false),
      sourceId: "new",
      timestamp: 200,
      text: "recovered newer message",
    });
    archive.recordHistory([item.chatId]);
  };
  const result = await reader({
    operation: "history",
    chatId: item.chatId,
    direction: "recent",
    limit: 1,
  });
  assert.equal(scoped, 1);
  assert.equal(full, 1);
  assert.equal(result.messages[0].text, "recovered newer message");
  assert.equal(result.history.direction, "recent");
  assert.equal(result.history.requestedLimit, 1);
  assert.equal(result.history.state, "history-observed");
  assert.equal(result.history.addedMessages, 1);
  assert.equal(result.history.pageChanged, true);
  assert.equal(result.coverage.complete, false);
});

test("older recovery uses the supplied page boundary instead of the archive oldest", async (t) => {
  const { archive, item, reader, socket } = setup(t);
  archive.ingest(item);
  const newer = {
    ...item,
    id: messageId(item.chatId, "newer", false),
    sourceId: "newer",
    timestamp: 200,
  };
  archive.ingest(newer);
  const page = archive.recent(item.chatId, 1);
  socket.fetchMessageHistory = async (_count, key, timestamp) => {
    assert.equal(key.id, newer.sourceId);
    assert.equal(timestamp, 200000);
    archive.recordHistory([item.chatId]);
  };
  const result = await reader({
    operation: "history",
    chatId: item.chatId,
    direction: "older",
    cursor: page.nextCursor,
    limit: 10,
  });
  assert.equal(result.messages[0].id, item.id);
  assert.equal(result.history.state, "history-observed");
  assert.equal(result.history.addedMessages, 0);
  assert.equal(result.history.pageChanged, false);
});

test("selected-chat recent recovery never falls back to full-account history", async (t) => {
  const { reader, socket, item, archive } = setup(t);
  archive.ingest(item);
  socket.fetchMessageHistory = async () => {
    throw new Error("phone refusal");
  };
  let full = 0;
  socket.sendPeerDataOperationMessage = async () => {
    full++;
  };
  await assert.rejects(
    reader({
      operation: "history",
      chatId: item.chatId,
      direction: "recent",
      limit: 10,
    }),
  );
  assert.equal(full, 0);
});

test("concurrent identical recovery requests issue only one phone request", async (t) => {
  const { reader, socket, item, archive } = setup(t);
  archive.ingest(item);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  socket.fetchMessageHistory = async () => {
    calls++;
    await pending;
    archive.recordHistory([item.chatId]);
  };
  const args = {
    operation: "history",
    chatId: item.chatId,
    direction: "older",
    limit: 10,
  };
  const first = reader(args);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await reader(args);
  assert.equal(second.history.state, "requested");
  release();
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.history.state, "history-observed");
});

test("full-account recovery cooldown survives reader recreation", async (t) => {
  const { archive, item, reader, socket, config, path } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  archive.ingest(item);
  socket.fetchMessageHistory = async () => {
    throw new Error("phone refusal");
  };
  let calls = 0;
  socket.sendPeerDataOperationMessage = async () => {
    calls++;
  };
  const args = {
    operation: "history",
    chatId: item.chatId,
    direction: "recent",
    limit: 10,
  };
  assert.equal((await reader(args)).history.state, "full-history-requested");
  const restarted = connectedReader(
    archive,
    () => socket,
    new AbortController().signal,
  );
  const result = await restarted(args);
  assert.equal(result.history.state, "full-history-throttled");
  assert.ok(result.history.accountRetryAfterMs > 14 * 60 * 1000);
  assert.equal(calls, 1);
});

test("different older page boundaries are not blocked by a chat-wide cooldown", async (t) => {
  const { archive, item, reader, socket } = setup(t);
  const later = {
    ...item,
    id: messageId(item.chatId, "later", false),
    sourceId: "later",
    timestamp: 200,
  };
  archive.ingest(item);
  archive.ingest(later);
  const a = archive.recent(item.chatId, 1);
  const b = archive.recent(item.chatId, 1, a.nextCursor);
  const anchors = [];
  socket.fetchMessageHistory = async (_count, key) => {
    anchors.push(key.id);
    archive.recordHistory([item.chatId]);
  };
  for (const cursor of [a.nextCursor, b.nextCursor]) {
    await reader({
      operation: "history",
      chatId: item.chatId,
      direction: "older",
      cursor,
      limit: 10,
    });
  }
  assert.deepEqual(anchors, [later.sourceId, item.sourceId]);
});

test("invented or deleted recovery anchors never reach the phone", async (t) => {
  const { archive, item, reader, socket } = setup(t);
  archive.ingest(item);
  const page = archive.recent(item.chatId, 1);
  let calls = 0;
  socket.fetchMessageHistory = async () => {
    calls++;
  };
  const cursor = Buffer.from(
    JSON.stringify({ chatId: item.chatId, timestamp: 100, id: "a".repeat(64) }),
  ).toString("base64url");
  const args = {
    operation: "history",
    chatId: item.chatId,
    direction: "older",
    limit: 10,
  };
  await assert.rejects(reader({ ...args, cursor }), /anchor unavailable/);
  archive.deleteMessage(item.chatId, item.sourceId, false);
  await assert.rejects(
    reader({ ...args, cursor: page.nextCursor }),
    /anchor unavailable/,
  );
  assert.equal(calls, 0);
});

test("cancellation and revocation during recent recovery prevent account fallback", async (t) => {
  const { archive, item, reader, socket, config, path } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  archive.ingest(item);
  let full = 0;
  socket.sendPeerDataOperationMessage = async () => {
    full++;
  };
  const args = {
    operation: "history",
    chatId: item.chatId,
    direction: "recent",
    limit: 10,
  };
  const controller = new AbortController();
  socket.fetchMessageHistory = async () => {
    controller.abort();
    throw new Error("cancelled");
  };
  await assert.rejects(reader(args, { signal: controller.signal }));
  socket.fetchMessageHistory = async () => {
    config.access = "selected";
    config.allowedChats = [];
    writeFileSync(path, JSON.stringify(config));
    throw new Error("revoked");
  };
  await assert.rejects(reader(args), /not selected/);
  assert.equal(full, 0);
});

test("an unrelated older batch cannot suppress a stalled recent catch-up", async (t) => {
  const { archive, item, reader, socket, config, path } = setup(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  archive.ingest(item);
  socket.fetchMessageHistory = async () => {
    archive.recordHistory([item.chatId]);
  };
  let full = 0;
  socket.sendPeerDataOperationMessage = async () => {
    full++;
  };
  const result = await reader({
    operation: "history",
    chatId: item.chatId,
    direction: "recent",
    limit: 10,
  });
  assert.equal(full, 1);
  assert.equal(result.history.state, "full-history-requested");
  assert.equal(result.history.historyObserved, false);
  assert.equal(result.history.addedMessages, 0);
  assert.equal(result.history.pageChanged, false);
});

test("a socket replacement during recovery invalidates its result", async (t) => {
  const { archive, item, socket } = setup(t);
  archive.ingest(item);
  let current = socket;
  const reader = connectedReader(
    archive,
    () => current,
    new AbortController().signal,
  );
  let full = 0;
  socket.sendPeerDataOperationMessage = async () => {
    full++;
  };
  socket.fetchMessageHistory = async () => {
    current = { ...socket };
    archive.recordHistory([item.chatId]);
  };
  await assert.rejects(
    reader({
      operation: "history",
      chatId: item.chatId,
      direction: "recent",
      limit: 10,
    }),
    /Connection changed/,
  );
  assert.equal(full, 0);
});

test("deletion tombstones are not reported as newly recovered readable messages", async (t) => {
  const { archive, item, reader, socket } = setup(t);
  archive.ingest(item);
  socket.fetchMessageHistory = async () => {
    archive.deleteMessage(item.chatId, "unseen-deleted", false);
    archive.recordHistory([item.chatId]);
  };
  const result = await reader({
    operation: "history",
    chatId: item.chatId,
    direction: "older",
    limit: 10,
  });
  assert.equal(result.history.addedMessages, 0);
  assert.equal(result.coverage.storedMessages, 2);
  assert.equal(result.coverage.readableMessages, 1);
  assert.equal(result.coverage.newestReadableTimestamp, item.timestamp);
});
