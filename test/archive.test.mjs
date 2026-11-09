import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
const A = "111@s.whatsapp.net",
  B = "222@s.whatsapp.net";
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-test-"));
  const path = join(dir, "config.json");
  const config = {
    dataDir: dir,
    allowedChats: [A],
    cacheMedia: true,
    maxMediaBytes: 1024,
  };
  const save = () => writeFileSync(path, JSON.stringify(config));
  save();
  const archive = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  t.after(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { archive, config, save, dir, path };
}
export function record(n, extra = {}) {
  const r = {
    chatId: A,
    sourceId: String(n),
    fromMe: false,
    senderId: A,
    timestamp: 100 + n,
    text: `hello ${n}`,
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: null,
    mimeType: null,
    ...extra,
  };
  return { ...r, id: messageId(r.chatId, r.sourceId, r.fromMe) };
}
test("allowlist enforced at ingestion and every retrieval; live config revocation", (t) => {
  const { archive, config, save } = fixture(t);
  const a = record(1, { mediaType: "image" });
  assert.equal(archive.ingest(record(2, { chatId: B, text: "secret" })), false);
  archive.ingest(a);
  archive.cacheMedia(a.id, Buffer.from("safe"), 0);
  assert.equal(archive.media(a.id).available, true);
  config.allowedChats = [];
  save();
  assert.equal(archive.search({}).messages.length, 0);
  assert.equal(archive.coverage().storedMessages, 0);
  assert.deepEqual(archive.availableChats(), []);
  assert.throws(() => archive.context(a.id));
  assert.throws(() => archive.media(a.id));
  assert.throws(() => archive.search({ chatId: A }));
  assert.throws(() => archive.coverage(A));
});
test("malformed policy fails closed", (t) => {
  const { archive, path } = fixture(t);
  archive.ingest(record(1));
  writeFileSync(path, "{");
  assert.throws(() => archive.search({}));
  assert.throws(() => archive.ingest(record(2)));
});
test("duplicates, monotonic edits and tombstones survive replay and reopen", (t) => {
  const { archive, dir, path } = fixture(t);
  const a = record(1);
  archive.ingest(a);
  archive.ingest(a);
  archive.ingest({ ...a, text: "new edit", edited: true, revision: 200 });
  archive.ingest({ ...a, text: "old edit", edited: true, revision: 150 });
  archive.ingest(a);
  assert.equal(archive.search({}).messages[0].text, "new edit");
  archive.deleteMessage(A, "1", false);
  archive.ingest(a);
  assert.equal(archive.search({}).messages.length, 0);
  assert.equal(archive.context(a.id).messages[0].text, "");
  const reader = new Archive(
    join(dir, "archive.sqlite"),
    configPolicy(path),
    true,
  );
  assert.equal(reader.context(a.id).messages[0].deleted, true);
  reader.close();
});
test("deletion before history prevents resurrection and fills timestamp", (t) => {
  const { archive } = fixture(t);
  const a = record(4);
  archive.deleteMessage(A, "4", false);
  archive.ingest(a);
  assert.equal(archive.context(a.id).messages[0].deleted, true);
  assert.equal(archive.context(a.id).messages[0].timestamp, 104);
});
test("cursor paginates timestamp ties, rejects changed filters and malicious payloads", (t) => {
  const { archive, config, save } = fixture(t);
  for (let i = 1; i < 6; i++) archive.ingest(record(i, { timestamp: 100 }));
  const first = archive.search({ limit: 2 });
  const second = archive.search({ limit: 2, cursor: first.nextCursor });
  const third = archive.search({ limit: 2, cursor: second.nextCursor });
  assert.equal(
    new Set(
      [...first.messages, ...second.messages, ...third.messages].map(
        (x) => x.id,
      ),
    ).size,
    5,
  );
  assert.equal(third.nextCursor, null);
  assert.throws(() =>
    archive.search({ query: "changed", cursor: first.nextCursor }),
  );
  assert.throws(() => archive.search({ cursor: "not a cursor" }));
  config.allowedChats = [B];
  save();
  assert.throws(() => archive.search({ cursor: first.nextCursor }));
});
test("literal search resists SQL and wildcard injection; filters and context boundaries", (t) => {
  const { archive } = fixture(t);
  for (let i = 1; i < 6; i++) archive.ingest(record(i));
  assert.equal(archive.search({ query: "' OR 1=1 --" }).messages.length, 0);
  assert.equal(archive.search({ query: "%" }).messages.length, 0);
  assert.equal(
    archive.search({ query: "HELLO", after: 102, before: 103 }).messages.length,
    2,
  );
  assert.equal(archive.context(record(3).id, 1).messages.length, 3);
  assert.equal(archive.context(record(1).id, 10).messages.length, 5);
});
test("zero matches carries explicit incomplete coverage", (t) => {
  const { archive } = fixture(t);
  const result = archive.search({ query: "absent" });
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.notice, /zero matches never/);
  assert.equal(result.coverage.oldestTimestamp, null);
});
test("media cannot cross revisions, survive deletion, exceed limits, or expose a path", (t) => {
  const { archive } = fixture(t);
  const a = record(1, { mediaType: "document", mimeType: "text/plain" });
  archive.ingest(a);
  assert.throws(() => archive.cacheMedia(a.id, Buffer.alloc(1025), 0));
  archive.ingest({ ...a, edited: true, revision: 120 });
  archive.cacheMedia(a.id, Buffer.from("stale"), 0);
  assert.equal(archive.media(a.id).available, false);
  archive.cacheMedia(a.id, Buffer.from("good"), 120);
  assert.equal(
    archive.media(a.id).data,
    Buffer.from("good").toString("base64"),
  );
  archive.deleteMessage(A, "1", false);
  assert.throws(() => archive.media(a.id));
  assert.throws(() => archive.media("../../etc/passwd"));
});
test("discovery is human-only; MCP selected list excludes unselected metadata", (t) => {
  const { archive } = fixture(t);
  archive.discover([
    { id: A, name: "Selected" },
    { id: B, name: "Private" },
  ]);
  assert.equal(archive.discoveredChats().length, 2);
  assert.deepEqual(archive.availableChats(), [{ id: A, name: "Selected" }]);
});
test("offline archive never creates credentials", (t) => {
  const { dir } = fixture(t);
  assert.equal(existsSync(join(dir, "auth.sqlite")), false);
});

test("discovered chats accept tombstones and post-clear deletion; old content stays cleared", (t) => {
  const { archive } = fixture(t);
  archive.discover([{ id: A, name: "Selected" }]);
  const a = record(1, { mediaType: "image" });
  archive.ingest(a);
  archive.cacheMedia(a.id, Buffer.from("secret"), 0);
  archive.deleteMessage(A, "1", false);
  assert.equal(archive.search({}).messages.length, 0);
  assert.throws(() => archive.media(a.id));
  archive.clearChat(A);
  archive.ingest(record(2));
  assert.equal(archive.search({}).messages.length, 0);
  const newMessage = record(3, {
    timestamp: Math.floor(Date.now() / 1000) + 5,
  });
  archive.ingest(newMessage);
  archive.deleteMessage(A, "3", false);
  assert.equal(archive.context(newMessage.id).messages.at(-1).deleted, true);
});
test("unknown or unrelated schema is rejected without changes in both modes", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { dir, path } = fixture(t);
  const dbPath = join(dir, "future.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE unrelated(secret TEXT); INSERT INTO unrelated VALUES('preserved'); PRAGMA user_version=99;",
  );
  for (const readOnly of [false, true])
    assert.throws(() => new Archive(dbPath, configPolicy(path), readOnly));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 99);
  assert.deepEqual(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((x) => x.name),
    ["unrelated"],
  );
  db.exec("PRAGMA user_version=0");
  assert.throws(() => new Archive(dbPath, configPolicy(path)));
  assert.equal(
    db.prepare("SELECT secret FROM unrelated").get().secret,
    "preserved",
  );
  db.close();
});

test("changing dataDir fails closed for already-open archive", (t) => {
  const { archive, config, save, dir } = fixture(t);
  archive.ingest(record(1));
  config.dataDir = join(dir, "different");
  save();
  assert.throws(() => archive.search({}), /restart/);
  assert.throws(() => archive.ingest(record(2)), /restart/);
});
test("archive account binding is immutable and populated unbound archives cannot be adopted", (t) => {
  const { archive } = fixture(t);
  archive.bindAccount("999@s.whatsapp.net");
  archive.ingest(record(1));
  archive.bindAccount("999@s.whatsapp.net");
  assert.throws(
    () => archive.bindAccount("888@s.whatsapp.net"),
    /Different account/,
  );
  assert.equal(archive.search({}).messages.length, 1);
});
test("unbound populated archive requires a fresh directory", (t) => {
  const { archive } = fixture(t);
  archive.ingest(record(1));
  assert.throws(
    () => archive.bindAccount("999@s.whatsapp.net"),
    /Populated archive/,
  );
});

test("search cursors tolerate selection reordering but reject empty and negative cursors", (t) => {
  const { archive, config, save } = fixture(t);
  config.allowedChats = [A, B];
  save();
  for (let i = 1; i < 6; i++) archive.ingest(record(i));
  const first = archive.search({ limit: 2 });
  config.allowedChats = [B, A];
  save();
  const next = archive.search({ limit: 2, cursor: first.nextCursor });
  assert.equal(next.messages.length, 2);
  assert.equal(
    new Set([...first.messages, ...next.messages].map((m) => m.id)).size,
    4,
  );
  assert.throws(() => archive.search({ cursor: "" }), /Invalid cursor/);
  const bad = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
  bad.timestamp = -1;
  assert.throws(
    () =>
      archive.search({
        cursor: Buffer.from(JSON.stringify(bad)).toString("base64url"),
      }),
    /Invalid cursor/,
  );
});
