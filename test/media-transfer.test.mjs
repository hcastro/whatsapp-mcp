import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import {
  getMediaKeys,
  downloadEncryptedContent,
} from "@whiskeysockets/baileys";
import { fetchMedia } from "../dist/media.js";

const mediaKey = Buffer.alloc(32, 7);
const raw = {
  key: { remoteJid: "111@s.whatsapp.net", id: "media" },
  message: {
    imageMessage: {
      url: "https://mmg.whatsapp.net/synthetic",
      mediaKey,
      mimetype: "image/jpeg",
    },
  },
};
async function encrypted(bytes) {
  const { cipherKey, iv } = await getMediaKeys(mediaKey, "image");
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  return Buffer.concat([
    cipher.update(bytes),
    cipher.final(),
    Buffer.alloc(10),
  ]);
}
test("actual media transfer decrypts synthetic bytes and enforces streaming byte limit", async () => {
  const originalFetch = globalThis.fetch;
  const payload = await encrypted(Buffer.from("synthetic media bytes"));
  globalThis.fetch = async () => new Response(payload);
  try {
    assert.equal(
      (await fetchMedia(raw, 100)).toString(),
      "synthetic media bytes",
    );
    await assert.rejects(fetchMedia(raw, 5), /exceeds configured limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("abort after response headers reaches decrypted stream without hanging or unhandled source error", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        start(source) {
          options.signal.addEventListener(
            "abort",
            () => source.error(new Error("synthetic abort")),
            { once: true },
          );
        },
      }),
    );
  try {
    const keys = await getMediaKeys(mediaKey, "image");
    const stream = await downloadEncryptedContent(
      "https://mmg.whatsapp.net/synthetic",
      keys,
      { options: { signal: controller.signal, redirect: "error" } },
    );
    const collecting = (async () => {
      for await (const _ of stream) {
        void _;
      }
    })();
    const rejected = assert.rejects(collecting, /synthetic abort/);
    controller.abort();
    await rejected;
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("stopping the decrypted stream cancels its upstream response body", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  try {
    const keys = await getMediaKeys(mediaKey, "image");
    const stream = await downloadEncryptedContent(
      "https://mmg.whatsapp.net/synthetic",
      keys,
    );
    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
