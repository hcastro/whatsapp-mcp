import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import qrcode from "qrcode-terminal";
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
    const socket = {
      ev,
      ws: new EventEmitter(),
      options,
      end: () => endAction(),
    };
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
let versionAction = async () => [2, 3000, 1234567890];
mock.module("../dist/wa-version.js", {
  namedExports: { resolveWebVersion: (signal) => versionAction(signal) },
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
    JSON.stringify({ registered: false, me: { id: "999@s.whatsapp.net" } }),
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(running, /Socket shutdown failed/);
  process.emit("SIGTERM");
  await rejected;
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});

test("link diagnostics retain only stages and numeric disconnect reasons; fresh QR replaces terminal contents", async (t) => {
  const { dir, policy } = setup(t);
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    value: true,
    configurable: true,
  });
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else delete process.stderr.isTTY;
  });
  const displayed = [];
  const output = mock.method(process.stderr, "write", (chunk) => {
    displayed.push(chunk);
    return true;
  });
  const qr = mock.method(qrcode, "generate", (_value, _options, done) =>
    done("synthetic display"),
  );
  t.after(() => {
    output.mock.restore();
    qr.mock.restore();
  });
  const running = sync(policy, true);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = sockets.at(-1);
  const reader = new DatabaseSync(join(dir, "archive.sqlite"), {
    readOnly: true,
  });
  const diagnostics = () =>
    Object.fromEntries(
      reader
        .prepare(
          "SELECT key,value FROM status WHERE key IN ('linking','lastDisconnect','pairingProtocol')",
        )
        .all()
        .map(({ key, value }) => [key, JSON.parse(value)]),
    );
  try {
    socket.ev.emit("connection.update", { qr: "SECRET-QR-SENTINEL" });
    assert.equal(diagnostics().linking.stage, "qr-ready");
    assert.equal(qr.mock.calls[0].arguments[0], "SECRET-QR-SENTINEL");
    assert.deepEqual(socket.options.version, [2, 3000, 1234567890]);
    socket.ws.emit("CB:notification,type:companion_reg_refresh", {
      attrs: { from: "SECRET-IDENTITY-SENTINEL" },
      content: "SECRET-REFRESH-SENTINEL",
    });
    assert.equal(
      typeof diagnostics().pairingProtocol.companionRefreshAt,
      "number",
    );
    assert.equal(diagnostics().pairingProtocol.pairSuccessAt, null);
    socket.ws.emit("CB:iq,,pair-success", { content: "SECRET-PAIR-SENTINEL" });
    assert.equal(typeof diagnostics().pairingProtocol.pairSuccessAt, "number");
    assert.ok(displayed.includes("\u001b[3J\u001b[2J\u001b[H"));
    assert.ok(displayed.some((value) => value.includes("Fresh QR generated")));
    socket.ev.emit("connection.update", { isNewLogin: true });
    assert.equal(diagnostics().linking.stage, "paired");
    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: {
          output: { statusCode: 408 },
          message: "SECRET-ERROR-SENTINEL",
        },
      },
    });
    const status = diagnostics();
    assert.equal(status.lastDisconnect.code, 408);
    assert.equal(status.linking.stage, "disconnected");
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.notEqual(sockets.at(-1), socket);
    assert.deepEqual(diagnostics().pairingProtocol, status.pairingProtocol);
    socket.ws.emit("CB:notification,type:companion_reg_refresh", {});
    assert.deepEqual(diagnostics().pairingProtocol, status.pairingProtocol);
  } finally {
    process.emit("SIGTERM");
    await running;
    reader.close();
  }
});

test("version lookup failure opens no socket and releases the writer lock", async (t) => {
  const { dir, policy } = setup(t);
  const count = sockets.length;
  versionAction = async () => {
    throw new Error("Could not verify Web version");
  };
  t.after(() => {
    versionAction = async () => [2, 3000, 1234567890];
  });
  await assert.rejects(sync(policy, false), /Could not verify Web version/);
  assert.equal(sockets.length, count);
  assert.equal(existsSync(join(dir, "sync.lock")), false);
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(reader.coverage().sync.connection.state, "error");
  reader.close();
});

test("shutdown cancels version lookup without opening a socket or retaining a lock", async (t) => {
  const { dir, policy } = setup(t);
  const count = sockets.length;
  let lookupSignal;
  versionAction = (signal) =>
    new Promise((_resolve, reject) => {
      lookupSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  t.after(() => {
    versionAction = async () => [2, 3000, 1234567890];
  });
  const running = sync(policy, false);
  assert.equal(lookupSignal.aborted, false);
  process.emit("SIGTERM");
  await running;
  assert.equal(lookupSignal.aborted, true);
  assert.equal(sockets.length, count);
  assert.equal(existsSync(join(dir, "sync.lock")), false);
});

test("pairing restart immediately opens a new socket with saved credentials and a secret-free ordered trace", async (t) => {
  const { dir, policy } = setup(t);
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    value: true,
    configurable: true,
  });
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else delete process.stderr.isTTY;
  });
  const running = sync(policy, true);
  await new Promise((resolve) => setImmediate(resolve));
  const old = sockets.at(-1);
  old.options.auth.creds.secret = "SECRET-SENTINEL";
  old.ev.emit("creds.update", { secret: "SECRET-SENTINEL" });
  old.ev.emit("connection.update", { isNewLogin: true });
  old.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 515 } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const current = sockets.at(-1);
  assert.notEqual(current, old);
  assert.equal(current.options.auth.creds.secret, "SECRET-SENTINEL");
  old.ws.emit("CB:failure", { secret: "SECRET-SENTINEL" });
  current.ev.emit("connection.update", { connection: "open" });
  process.emit("SIGTERM");
  await running;
  const db = new DatabaseSync(join(dir, "archive.sqlite"), { readOnly: true });
  const trace = JSON.parse(
    db.prepare("SELECT value FROM status WHERE key='pairingTrace'").get().value,
  );
  db.close();
  assert.equal(JSON.stringify(trace).includes("SECRET"), false);
  assert.equal(
    trace.some((entry) => entry.event === "CB:failure"),
    false,
  );
  assert.deepEqual(
    trace.map((entry) => entry.event),
    [
      "session-start",
      "socket-create",
      "credentials-saved",
      "paired",
      "disconnected",
      "socket-create",
      "authenticated-open",
    ],
  );
  assert.equal(
    trace.find((entry) => entry.event === "disconnected").retryMs,
    0,
  );
  assert.equal(trace.at(-1).socket, 2);
});

test("contact events, history contacts and direct-message push names persist without group name pollution", async (t) => {
  const { dir, policy } = setup(t);
  const running = sync(policy, false);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = sockets.at(-1);
  socket.ev.emit("chats.upsert", [
    { id: "111@s.whatsapp.net" },
    { id: "123@g.us", name: "Fixture group" },
  ]);
  socket.ev.emit("contacts.upsert", [
    { id: "111@s.whatsapp.net", name: "Jordan Example" },
  ]);
  socket.ev.emit("contacts.update", [
    { id: "111@s.whatsapp.net", notify: "Jay" },
  ]);
  socket.ev.emit("messaging-history.set", {
    chats: [],
    messages: [],
    contacts: [{ id: "111@s.whatsapp.net", username: "jexample" }],
    lidPnMappings: [{ pn: "111@s.whatsapp.net", lid: "555@lid" }],
  });
  const reader = new Archive(join(dir, "archive.sqlite"), policy, true);
  assert.equal(reader.findChats("Jordan")[0].identityId, "555@lid");
  assert.equal(reader.findChats("jay").length, 1);
  assert.equal(reader.findChats("jexample").length, 1);
  socket.ev.emit("messages.upsert", {
    messages: [
      {
        key: { remoteJid: "111@s.whatsapp.net", fromMe: false, id: "push" },
        pushName: "Updated nickname",
        messageTimestamp: 123,
        message: { conversation: "synthetic" },
      },
      {
        key: {
          remoteJid: "123@g.us",
          participant: "111@s.whatsapp.net",
          fromMe: false,
          id: "group",
        },
        pushName: "Not a group title",
        messageTimestamp: 124,
        message: { conversation: "synthetic" },
      },
    ],
    type: "notify",
  });
  assert.equal(reader.findChats("Updated nickname").length, 1);
  assert.deepEqual(reader.findChats("Not a group title"), []);
  reader.close();
  process.emit("SIGTERM");
  await running;
});
