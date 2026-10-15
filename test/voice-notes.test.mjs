import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
import { exportVoiceNotes } from "../.agents/skills/whatsapp/scripts/export-voice-notes.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "wa-voice-test-"));
  const configPath = join(directory, "config.json");
  const config = { dataDir: directory, allowedChats: ["111@s.whatsapp.net"] };
  writeFileSync(configPath, JSON.stringify(config));
  const archive = new Archive(
    join(directory, "archive.sqlite"),
    configPolicy(configPath),
  );
  const items = ["a", "b"].map((sourceId) => ({
    id: messageId(config.allowedChats[0], sourceId, false),
    chatId: config.allowedChats[0],
    sourceId,
    fromMe: false,
    senderId: null,
    timestamp: 100,
    text: "",
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: "audio",
    mimeType: "audio/ogg",
  }));
  for (const item of items) {
    archive.ingest(item);
    archive.saveAttachmentSource(
      item.id,
      0,
      proto.WebMessageInfo.encode({
        key: { remoteJid: item.chatId, id: item.sourceId },
        message: { audioMessage: { seconds: 3, mimetype: "audio/ogg" } },
      }).finish(),
    );
  }
  t.after(() => {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, configPath, config, archive, items };
}

test("voice export preserves source identity and private original bytes", async (t) => {
  const { configPath, items } = setup(t);
  const bytes = Buffer.from("OggSfixture");
  const result = await exportVoiceNotes(
    { configPath, messageIds: [items[0].id] },
    { download: async () => bytes },
  );
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(result.count, 1);
  assert.equal(manifest[0].messageId, items[0].id);
  assert.equal(manifest[0].sentAt, "1970-01-01T00:01:40.000Z");
  assert.equal(
    manifest[0].sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const audioPath = join(result.manifestPath, "..", manifest[0].path);
  assert.deepEqual(readFileSync(audioPath), bytes);
  assert.equal(statSync(audioPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(result.manifestPath, "..")).mode & 0o777, 0o700);
  assert.equal(statSync(result.manifestPath).mode & 0o777, 0o600);
  assert.equal(manifest[0].senderId, null);
});

test("revoked selection aborts export and removes its partial files", async (t) => {
  const { directory, configPath, config, items } = setup(t);
  await assert.rejects(
    exportVoiceNotes(
      { configPath, messageIds: [items[0].id] },
      {
        download: async () => {
          writeFileSync(
            configPath,
            JSON.stringify({ ...config, allowedChats: [] }),
          );
          return Buffer.from("OggSfixture");
        },
      },
    ),
    /unavailable|selected/,
  );
  assert.deepEqual(readdirSync(join(directory, "voice-notes")), []);
});

test("an earlier recording edited during later download aborts the entire batch", async (t) => {
  const { directory, configPath, archive, items } = setup(t);
  let calls = 0;
  await assert.rejects(
    exportVoiceNotes(
      { configPath, messageIds: items.map((item) => item.id) },
      {
        download: async () => {
          if (++calls === 2)
            archive.ingest({ ...items[0], revision: 1, edited: true });
          return Buffer.from("OggSfixture");
        },
      },
    ),
    /unavailable|changed/,
  );
  assert.deepEqual(readdirSync(join(directory, "voice-notes")), []);
});

test("rejects non-audio and duplicate IDs without downloading", async (t) => {
  const { configPath, archive, items } = setup(t);
  let downloads = 0;
  const options = {
    download: async () => {
      downloads++;
      return Buffer.from("unused");
    },
  };
  await assert.rejects(
    exportVoiceNotes(
      { configPath, messageIds: [items[0].id, items[0].id] },
      options,
    ),
    /distinct/,
  );
  archive.ingest({ ...items[0], mediaType: "document", revision: 1 });
  archive.saveAttachmentSource(
    items[0].id,
    1,
    proto.WebMessageInfo.encode({
      key: { remoteJid: items[0].chatId, id: "a" },
      message: { documentMessage: { fileName: "x" } },
    }).finish(),
  );
  await assert.rejects(
    exportVoiceNotes({ configPath, messageIds: [items[0].id] }, options),
    /not an available audio/,
  );
  assert.equal(downloads, 0);
});
