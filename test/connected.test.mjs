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
