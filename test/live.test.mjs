import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { readAttachment } from "../dist/attachments.js";
import { listenLive, requestLive, LiveError } from "../dist/live.js";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
const options = { page: 1, startRow: 1 };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-live-"));
  const config = { dataDir: dir, allowedChats: ["111@s.whatsapp.net"] };
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const archive = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  t.after(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, path, archive };
}
function message(n) {
  return {
    id: messageId("111@s.whatsapp.net", String(n), false),
    chatId: "111@s.whatsapp.net",
    sourceId: String(n),
    fromMe: false,
    senderId: null,
    timestamp: 100 + n,
    text: "fixture " + n,
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: "document",
    mimeType: "application/pdf",
  };
}
test("latest conversation pages preserve chronological order, ties and authorization", (t) => {
  const { archive, config, path } = fixture(t);
  for (let i = 0; i < 6; i++) archive.ingest(message(i));
  const page = archive.recent("111@s.whatsapp.net", 2);
  assert.deepEqual(
    page.messages.map((x) => x.text),
    ["fixture 4", "fixture 5"],
  );
  const older = archive.recent("111@s.whatsapp.net", 2, page.nextCursor);
  assert.deepEqual(
    older.messages.map((x) => x.text),
    ["fixture 2", "fixture 3"],
  );
  assert.throws(() => archive.recent("222@s.whatsapp.net", 2, page.nextCursor));
  config.allowedChats = [];
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => archive.recent("111@s.whatsapp.net"));
});
test("attachment descriptors cannot survive edits, deletion or selection revocation", (t) => {
  const { archive, config, path } = fixture(t);
  const m = message(1);
  archive.ingest(m);
  archive.saveAttachmentSource(
    m.id,
    0,
    Buffer.from("descriptor"),
    "report.pdf",
  );
  assert.equal(archive.attachmentSource(m.id).fileName, "report.pdf");
  archive.ingest({ ...m, revision: 3, edited: true });
  assert.throws(() => archive.attachmentSource(m.id));
  archive.saveAttachmentSource(m.id, 0, Buffer.from("stale"), "report.pdf");
  assert.throws(() => archive.attachmentSource(m.id));
  archive.saveAttachmentSource(m.id, 3, Buffer.from("current"), "report.pdf");
  config.allowedChats = [];
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => archive.attachmentSource(m.id));
  config.allowedChats = [m.chatId];
  writeFileSync(path, JSON.stringify(config));
  archive.deleteMessage(m.chatId, m.sourceId, false);
  assert.throws(() => archive.attachmentSource(m.id));
});
test("private live IPC returns bounded results and explicit errors instead of stale data", async (t) => {
  const { dir } = fixture(t);
  const close = await listenLive(dir, async (request) => {
    if (request.chatId !== "111@s.whatsapp.net")
      throw new LiveError("Chat not selected.");
    return { messages: [{ text: "current" }] };
  });
  const request = {
    operation: "read",
    chatId: "111@s.whatsapp.net",
    limit: 1,
    requestHistory: false,
  };
  assert.equal((await requestLive(dir, request)).messages[0].text, "current");
  await assert.rejects(
    requestLive(dir, { ...request, chatId: "222@s.whatsapp.net" }),
    /not selected/,
  );
  await close();
  await assert.rejects(requestLive(dir, request), /unavailable/);
});
test("image attachment produces actual visual content", async () => {
  const canvas = createCanvas(12, 12);
  canvas.getContext("2d").fillRect(0, 0, 12, 12);
  const result = await readAttachment(
    canvas.toBuffer("image/png"),
    "test.png",
    options,
  );
  assert.equal(result.kind, "image");
  assert.equal(result.image.mimeType, "image/png");
  assert.ok(Buffer.from(result.image.data, "base64").length > 30);
});
test("spreadsheet returns sheets, rows, cached formula values without evaluation", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Budget");
  sheet.addRow(["Item", "Cost"]);
  sheet.addRow(["Elevator", 125]);
  sheet.addRow(["Total", { formula: "B2", result: 125 }]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await readAttachment(bytes, "budget.xlsx", options);
  assert.equal(result.sheets[0].name, "Budget");
  assert.match(result.text, /Elevator/);
  assert.match(result.text, /125/);
  await assert.rejects(
    readAttachment(bytes, "budget.xlsx", { ...options, sheet: "missing" }),
    /does not exist/,
  );
});
test("DOCX extracts text and excludes external relationships", async () => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Owners meeting</w:t></w:r></w:p></w:body></w:document>',
  );
  const result = await readAttachment(
    await zip.generateAsync({ type: "nodebuffer" }),
    "meeting.docx",
    options,
  );
  assert.match(result.text, /Owners meeting/);
});
test("PDF returns extracted page text and a visual page", async () => {
  const content = "BT /F1 18 Tf 20 70 Td (Synthetic attachment fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 6\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result = await readAttachment(Buffer.from(pdf), "notice.pdf", options);
  assert.equal(result.pages, 1);
  assert.match(result.text, /Synthetic attachment fixture/);
  assert.ok(result.image.data);
});
test("unsupported and oversized attachments fail explicitly", async () => {
  await assert.rejects(
    readAttachment(Buffer.from("not a file"), "old.xls", options),
    /Unsupported/,
  );
  assert.throws(
    () =>
      readAttachment(Buffer.alloc(25 * 1024 * 1024 + 1), "large.pdf", options),
    /25 MiB/,
  );
});

test("spreadsheet cell clipping is disclosed and oversized rows remain valid JSON", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Long cells");
  sheet.addRow(["x".repeat(2001)]);
  let bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  let result = await readAttachment(bytes, "long.xlsx", options);
  assert.equal(result.truncated, true);
  assert.equal(JSON.parse(result.text).cells[0].length, 2000);
  sheet.addRow(Array.from({ length: 50 }, () => "y".repeat(2000)));
  bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  result = await readAttachment(bytes, "long.xlsx", {
    ...options,
    startRow: 2,
  });
  assert.equal(result.truncated, true);
  assert.ok(JSON.parse(result.text).cells.length < 50);
});

test("attachment parser terminates on caller cancellation", async () => {
  const controller = new AbortController();
  const running = readAttachment(
    Buffer.alloc(10_000_000, 65),
    "text.txt",
    options,
    controller.signal,
  );
  const rejected = assert.rejects(running, /cancelled/);
  controller.abort();
  await rejected;
});

test("closing an IPC client cancels the accepted request", async (t) => {
  const { createConnection } = await import("node:net");
  const { dir } = fixture(t);
  let accepted;
  let cancelled = false;
  const ready = new Promise((resolve) => {
    accepted = resolve;
  });
  const close = await listenLive(dir, async (_request, context) => {
    accepted();
    await new Promise((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  });
  const client = createConnection(join(dir, "live.sock"));
  client.on("error", () => {});
  client.on("connect", () =>
    client.write(
      JSON.stringify({
        operation: "read",
        chatId: "111@s.whatsapp.net",
        requestHistory: false,
      }) + "\n",
    ),
  );
  await ready;
  client.destroy();
  await close();
  assert.equal(cancelled, true);
});

test("account discovery exposes only chat identifiers the reader can accept", (t) => {
  const { archive, config, path } = fixture(t);
  config.access = "account";
  writeFileSync(path, JSON.stringify(config));
  archive.discover([
    { id: "111@s.whatsapp.net", name: "Readable" },
    { id: "status@broadcast", name: "Status" },
    { id: "123@newsletter", name: "Unsupported channel" },
  ]);
  assert.equal(archive.discoveredChats().length, 3);
  assert.deepEqual(
    archive.availableChats().map((chat) => chat.id),
    ["111@s.whatsapp.net"],
  );
});

async function twoEntryDocx() {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    "<w:document xmlns:w='x'><w:p><w:r><w:t>VALIDATED</w:t></w:r></w:p></w:document>",
  );
  zip.file(
    "evil/document.xml",
    "<w:document xmlns:w='x'><w:p><w:r><w:t>UNVALIDATED</w:t></w:r></w:p></w:document>",
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
test("document ZIP rejects undercounts, hidden replacement entries and duplicate paths", async () => {
  const original = await twoEntryDocx();
  const duplicate = Buffer.from(original);
  const oldName = Buffer.from("evil/document.xml");
  let offset = 0;
  while ((offset = duplicate.indexOf(oldName, offset)) >= 0) {
    Buffer.from("word/document.xml").copy(duplicate, offset);
    offset += oldName.length;
  }
  await assert.rejects(
    readAttachment(duplicate, "duplicate.docx", options),
    /Duplicate|directory/,
  );
  const undercount = Buffer.from(duplicate);
  const end = undercount.length - 22;
  undercount.writeUInt16LE(1, end + 8);
  undercount.writeUInt16LE(1, end + 10);
  await assert.rejects(
    readAttachment(undercount, "hidden.docx", options),
    /count|directory/,
  );
});
test("document ZIP rejects bad directory bounds, multi-disk, ZIP64 and truncated end records", async () => {
  const original = await twoEntryDocx();
  const end = original.length - 22;
  for (const mutate of [
    (b) => b.writeUInt32LE(b.readUInt32LE(end + 12) - 1, end + 12),
    (b) => b.writeUInt16LE(1, end + 4),
    (b) => b.writeUInt16LE(65535, end + 10),
    (b) => b.writeUInt32LE(0xffffffff, end + 16),
  ]) {
    const bad = Buffer.from(original);
    mutate(bad);
    await assert.rejects(
      readAttachment(bad, "bad.docx", options),
      /ZIP|directory/,
    );
  }
  await assert.rejects(
    readAttachment(
      original.subarray(0, original.length - 10),
      "truncated.docx",
      options,
    ),
    /ZIP/,
  );
});

test("empty conversation pages preserve the boundary for delayed backfill", (t) => {
  const { archive } = fixture(t);
  archive.ingest(message(5));
  const first = archive.recent("111@s.whatsapp.net", 2);
  assert.equal(first.hasMoreLocal, false);
  const empty = archive.recent("111@s.whatsapp.net", 2, first.nextCursor);
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.nextCursor, first.nextCursor);
  archive.ingest(message(4));
  const recovered = archive.recent("111@s.whatsapp.net", 2, empty.nextCursor);
  assert.deepEqual(
    recovered.messages.map((m) => m.sourceId),
    ["4"],
  );
});

test("conversation pagination traverses ties and deletions exactly once", (t) => {
  const { archive } = fixture(t);
  const expected = [];
  for (let i = 0; i < 103; i++) {
    const m = { ...message(i), timestamp: 100 + Math.floor(i / 7) };
    archive.ingest(m);
    if (i % 11 === 0) archive.deleteMessage(m.chatId, m.sourceId, false);
    else expected.push(m.id);
  }
  let cursor;
  const seen = [];
  for (let i = 0; i < 30; i++) {
    const page = archive.recent("111@s.whatsapp.net", 6, cursor);
    assert.equal(
      new Set(page.messages.map((m) => m.id)).size,
      page.messages.length,
    );
    seen.push(...page.messages.map((m) => m.id));
    cursor = page.nextCursor;
    if (!page.hasMoreLocal) break;
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), expected.sort());
});

test("malformed conversation cursors fail consistently before use", (t) => {
  const { archive } = fixture(t);
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  for (const cursor of [
    "",
    "!",
    "x".repeat(1025),
    encode(null),
    encode([]),
    encode({ chatId: "111@s.whatsapp.net", timestamp: -1, id: "a".repeat(64) }),
  ]) {
    assert.throws(
      () => archive.recent("111@s.whatsapp.net", 2, cursor),
      /Invalid conversation cursor/,
    );
  }
});
