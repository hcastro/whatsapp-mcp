import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
} from "@whiskeysockets/baileys";

/** Only WhatsApp-hosted media, without redirects/reuploads, and bounded before buffering. */
export async function fetchMedia(
  raw: WAMessage,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const body = normalizeMessageContent(raw.message);
  const media =
    body?.imageMessage ??
    body?.videoMessage ??
    body?.audioMessage ??
    body?.documentMessage ??
    body?.stickerMessage;
  if (!media) throw new Error("No downloadable media");
  if (media.url) {
    const url = new URL(media.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".whatsapp.net") ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new Error("Unsupported media host");
  }
  if (
    media.directPath &&
    (!media.directPath.startsWith("/") || media.directPath.startsWith("//"))
  )
    throw new Error("Unsupported media path");
  if (Number(media.fileLength ?? 0) > limit)
    throw new Error("Media exceeds configured limit");
  const stream = await downloadMediaMessage(raw, "stream", {
    options: {
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    },
  });
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > limit) throw new Error("Media exceeds configured limit");
      parts.push(bytes);
    }
    return Buffer.concat(parts, total);
  } finally {
    stream.destroy();
  }
}
