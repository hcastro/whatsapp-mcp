import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";

const baileys = await import("@whiskeysockets/baileys");
const sockets = [];
let failConnect = false;
let endAction = () => Promise.resolve();
mock.module("@whiskeysockets/baileys", {
  namedExports: Object.fromEntries(
    Object.entries(baileys).filter(([key]) => key !== "default"),
  ),
  defaultExport: (options) => {
    if (failConnect) throw new Error("synthetic connect failure");
    const ev = new EventEmitter();
    const socket = { ev, options, end: () => endAction() };
    sockets.push(socket);
    return socket;
  },
});
let mediaStarted = false;
mock.module("../dist/media.js", {
  namedExports: {
    fetchMedia: async (_raw, _limit, signal) => {
      mediaStarted = true;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  },
});
const { sync } = await import("../dist/sync.js");
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-lifecycle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      dataDir: dir,
      allowedChats: ["111@s.whatsapp.net"],
      cacheMedia: true,
      maxMediaBytes: 1024,
    }),
  );
  const db = new DatabaseSync(join(dir, "auth.sqlite"));
  db.exec("CREATE TABLE auth(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.prepare("INSERT INTO auth VALUES(?,?)").run(
    "creds",
    JSON.stringify({ registered: true, me: { id: "999@s.whatsapp.net" } }),
  );
  db.close();
  return { dir, policy: configPolicy(path) };
}
const message = {
  key: { remoteJid: "111@s.whatsapp.net", id: "fixture", fromMe: false },
  messageTimestamp: 100,
  message: {
    imageMessage: { caption: "durable fixture", mimetype: "image/jpeg" },
  },
};
test("actual sync lifecycle persists credentials and tombstones while media is stalled, aborts cleanly", async (t) => {
  const { dir, policy } = setup(t);
  mediaStarted = false;
  const running = sync(policy, false);
  const socket = sockets.at(-1);
  socket.ev.emit("chats.upsert", [
    { id: "111@s.whatsapp.net", name: "Selected" },
  ]);
  socket.ev.emit("messages.upsert", { messages: [message], type: "notify" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mediaStarted, true);
  socket.options.auth.creds.fixtureRevision = 42;
  socket.ev.emit("creds.update", {});
  socket.ev.emit("messages.delete", { keys: [message.key] });
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(
    reader.context(messageId("111@s.whatsapp.net", "fixture", false))
      .messages[0].deleted,
    true,
  );
  process.emit("SIGTERM");
  await running;
  const auth = new DatabaseSync(join(dir, "auth.sqlite"), { readOnly: true });
  assert.equal(
    JSON.parse(
      auth.prepare("SELECT value FROM auth WHERE key='creds'").get().value,
    ).fixtureRevision,
    42,
  );
  auth.close();
  assert.equal(reader.coverage().sync.connection.state, "stopped");
  reader.close();
  assert.equal(existsSync(join(dir, "sync.lock")), false);
  socket.ev.emit("messages.upsert", { messages: [message], type: "notify" });
});
test("terminal disconnect remains visible after cleanup", async (t) => {
  const { dir, policy } = setup(t);
  const running = sync(policy, false);
  const socket = sockets.at(-1);
  socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await assert.rejects(running, /Session ended/);
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(reader.coverage().sync.connection.state, "needs-relink");
  reader.close();
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});
test("reconnect factory failure is contained, preserved, and releases writer lock", async (t) => {
  const { dir, policy } = setup(t);
  const running = sync(policy, false);
  const rejected = assert.rejects(running, /Sync failed/);
  const socket = sockets.at(-1);
  failConnect = true;
  t.after(() => {
    failConnect = false;
  });
  socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 408 } } },
  });
  await rejected;
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(reader.coverage().sync.connection.state, "error");
  reader.close();
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});

test("reconnect ignores stale socket events and keeps account binding across device suffixes", async (t) => {
  const { dir, policy } = setup(t);
  const running = sync(policy, false);
  const old = sockets.at(-1);
  old.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 408 } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const current = sockets.at(-1);
  assert.notEqual(current, old);
  current.options.auth.creds.me.id = "999:7@s.whatsapp.net";
  current.ev.emit("creds.update", {});
  old.ev.emit("messages.upsert", {
    messages: [{ ...message, message: { conversation: "stale" } }],
    type: "notify",
  });
  current.ev.emit("messages.upsert", {
    messages: [{ ...message, message: { conversation: "current" } }],
    type: "notify",
  });
  process.emit("SIGTERM");
  await running;
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(reader.search({}).messages[0].text, "current");
  reader.close();
});
test("different authenticated account cannot reuse the archive or open a socket", async (t) => {
  const { dir, policy } = setup(t);
  const archive = new Archive(join(dir, "archive.sqlite"), policy);
  archive.bindAccount("888@s.whatsapp.net");
  archive.close();
  const count = sockets.length;
  await assert.rejects(sync(policy, false), /Different account/);
  assert.equal(sockets.length, count);
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});

test("shutdown awaits one async socket end before saving credentials and releasing handles/lock", async (t) => {
  const { dir, policy } = setup(t);
  let release;
  let endCalls = 0;
  endAction = () => {
    endCalls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  t.after(() => {
    endAction = () => Promise.resolve();
  });
  const running = sync(policy, false);
  let resolved = false;
  running.then(() => {
    resolved = true;
  });
  const socket = sockets.at(-1);
  process.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(endCalls, 1);
  assert.equal(existsSync(join(dir, "sync.lock")), true);
  socket.options.auth.creds.finalCleanupMarker = "saved after end";
  await socket.options.auth.keys.set({
    "pre-key": { synthetic: Buffer.from("marker") },
  });
  release();
  await running;
  assert.equal(existsSync(join(dir, "sync.lock")), false);
  assert.equal(endCalls, 1);
  const db = new DatabaseSync(join(dir, "auth.sqlite"), { readOnly: true });
  assert.equal(
    JSON.parse(
      db.prepare("SELECT value FROM auth WHERE key='creds'").get().value,
    ).finalCleanupMarker,
    "saved after end",
  );
  db.close();
});
test("async shutdown rejection is contained and local lock still releases", async (t) => {
  const { dir, policy } = setup(t);
  endAction = async () => {
    throw new Error("synthetic end error");
  };
  t.after(() => {
    endAction = () => Promise.resolve();
  });
  const running = sync(policy, false);
  const rejected = assert.rejects(running, /Socket shutdown failed/);
  process.emit("SIGTERM");
  await rejected;
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});
