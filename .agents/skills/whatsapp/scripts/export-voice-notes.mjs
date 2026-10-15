import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeMessageContent, proto } from "@whiskeysockets/baileys";
import { Archive } from "../../../../dist/archive.js";
import { configPolicy, privateDirectory } from "../../../../dist/config.js";
import { fetchMedia } from "../../../../dist/media.js";

/** Export an authorized batch without opening a session; failed batches leave no partial export. */
export async function exportVoiceNotes(
  { configPath, messageIds },
  { download = fetchMedia } = {},
) {
  if (
    !messageIds.length ||
    messageIds.length > 100 ||
    messageIds.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
    new Set(messageIds).size !== messageIds.length
  )
    throw new Error("Supply 1–100 distinct stable message IDs.");
  const policy = configPolicy(configPath);
  const archive = new Archive(
    join(policy().dataDir, "archive.sqlite"),
    policy,
    true,
  );
  const assertUnchanged = ({ source, message }) => {
    const latest = archive.attachmentSource(message.id);
    if (
      latest.revision !== source.revision ||
      !Buffer.from(latest.payload).equals(source.payload)
    )
      throw new Error("Audio changed during retrieval; retry the request.");
  };
  let directory;
  try {
    const sources = messageIds.map((id) => {
      const source = archive.attachmentSource(id);
      const message = archive.context(id, 0).messages[0];
      const raw = proto.WebMessageInfo.decode(source.payload);
      const audio = normalizeMessageContent(raw.message)?.audioMessage;
      if (!audio || message.mediaType !== "audio")
        throw new Error(
          "Selected message is not an available audio recording.",
        );
      return { source, message, raw, audio };
    });
    const parent = join(policy().dataDir, "voice-notes");
    privateDirectory(parent);
    directory = mkdtempSync(join(parent, "export-"));
    const manifest = [];
    for (const { source, message, raw, audio } of sources) {
      let bytes;
      try {
        bytes = await download(raw, 25 * 1024 * 1024);
      } catch {
        throw new Error(
          "Audio download failed: unavailable, expired, or above 25 MiB.",
        );
      }
      assertUnchanged({ source, message });
      if (bytes.length > 25 * 1024 * 1024)
        throw new Error("Audio exceeds 25 MiB.");
      const path = `${message.id}.audio`;
      writeFileSync(join(directory, path), bytes, { flag: "wx", mode: 0o600 });
      manifest.push({
        messageId: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        fromMe: message.fromMe,
        sentAt: new Date(message.timestamp * 1000).toISOString(),
        seconds: Number(audio.seconds ?? 0),
        mimeType: message.mimeType,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    // Later downloads can outlive a selection change or deletion of an earlier item.
    sources.forEach(assertUnchanged);
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return { manifestPath, count: manifest.length };
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    archive.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values, positionals } = parseArgs({
      options: { config: { type: "string" }, help: { type: "boolean" } },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(
        "Usage: node export-voice-notes.mjs --config CONFIG MESSAGE_ID [MESSAGE_ID ...]",
      );
    } else {
      if (!values.config) throw new Error("--config is required.");
      console.log(
        JSON.stringify(
          await exportVoiceNotes({
            configPath: values.config,
            messageIds: positionals,
          }),
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
