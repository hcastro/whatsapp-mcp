import {
  proto,
  jidNormalizedUser,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { messageId, type IncomingMessage } from "./archive.js";

function number(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
/** Phone-number and opaque WhatsApp IDs remain separate; selecting one never grants access to the other. */
export function normalize(
  raw: WAMessage,
  edit = false,
): IncomingMessage | null {
  const chatId = raw.key.remoteJid ? jidNormalizedUser(raw.key.remoteJid) : "";
  const sourceId = raw.key.id;
  if (!chatId || !sourceId) return null;
  const fromMe = !!raw.key.fromMe;
  const original = raw.message;
  let body = original;
  let edited = edit;
  // Exclude view-once messages at every nesting depth so wrappers cannot make them permanent.
  for (let depth = 0; body && depth < 10; depth++) {
    if (
      body.viewOnceMessage ||
      body.viewOnceMessageV2 ||
      body.viewOnceMessageV2Extension
    )
      return null;
    edited ||= !!body.editedMessage;
    const wrapper =
      body.ephemeralMessage ??
      body.documentWithCaptionMessage ??
      body.editedMessage ??
      body.associatedChildMessage;
    if (!wrapper) break;
    body = wrapper.message;
    if (depth === 9) return null;
  }
  if (body?.protocolMessage) return null;
  const deleted = raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE;
  if (!body && !deleted) return null;
  const media =
    body?.imageMessage ??
    body?.videoMessage ??
    body?.audioMessage ??
    body?.documentMessage ??
    body?.stickerMessage;
  if (media && "viewOnce" in media && media.viewOnce) return null;
  const mediaType = body?.imageMessage
    ? "image"
    : body?.videoMessage
      ? "video"
      : body?.audioMessage
        ? "audio"
        : body?.documentMessage
          ? "document"
          : body?.stickerMessage
            ? "sticker"
            : null;
  const text =
    body?.conversation ??
    body?.extendedTextMessage?.text ??
    body?.imageMessage?.caption ??
    body?.videoMessage?.caption ??
    body?.documentMessage?.caption ??
    "";
  const timestamp = number(raw.messageTimestamp);
  return {
    id: messageId(chatId, sourceId, fromMe),
    chatId,
    sourceId,
    fromMe,
    senderId: raw.key.participant
      ? jidNormalizedUser(raw.key.participant)
      : fromMe
        ? null
        : chatId,
    timestamp,
    text: text.slice(0, 100_000),
    deleted,
    edited,
    revision: edited ? timestamp : 0,
    mediaType,
    mimeType: media?.mimetype ?? null,
  };
}
