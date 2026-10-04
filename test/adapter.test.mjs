import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize } from "../dist/normalize.js";
import { fetchMedia } from "../dist/media.js";
import { retryDelay } from "../dist/sync.js";
const raw = (message) => ({
  key: { remoteJid: "111:2@s.whatsapp.net", id: "A", fromMe: false },
  messageTimestamp: 100,
  message,
});
test("Baileys normalizer extracts text, captions, edits, ephemeral and preserves exact identities", () => {
  const a = normalize(raw({ conversation: "hello" }));
  assert.equal(a.chatId, "111@s.whatsapp.net");
  assert.equal(
    normalize(
      raw({ ephemeralMessage: { message: { conversation: "ephemeral" } } }),
    ).text,
    "ephemeral",
  );
  assert.equal(
    normalize(raw({ editedMessage: { message: { conversation: "edited" } } }))
      .edited,
    true,
  );
  assert.equal(
    normalize(
      raw({ imageMessage: { caption: "caption", mimetype: "image/jpeg" } }),
    ).mediaType,
    "image",
  );
  const lid = normalize({
    ...raw({ conversation: "same name" }),
    key: { remoteJid: "111@lid", id: "A" },
  });
  assert.notEqual(lid.id, a.id);
});
test("view-once and protocol payloads are not archived", () => {
  assert.equal(
    normalize(
      raw({
        viewOnceMessageV2: { message: { imageMessage: { caption: "secret" } } },
      }),
    ),
    null,
  );
  assert.equal(normalize(raw({ imageMessage: { viewOnce: true } })), null);
  assert.equal(normalize(raw({ protocolMessage: { type: 0 } })), null);
});
test("unsafe media URLs and declared oversize fail before network", async () => {
  await assert.rejects(
    fetchMedia(raw({ imageMessage: { url: "http://127.0.0.1/secret" } }), 100),
  );
  await assert.rejects(
    fetchMedia(raw({ imageMessage: { url: "https://evil.example/a" } }), 100),
  );
  await assert.rejects(
    fetchMedia(raw({ imageMessage: { directPath: "//evil.example/a" } }), 100),
  );
  await assert.rejects(
    fetchMedia(raw({ imageMessage: { fileLength: 101 } }), 100),
  );
});
test("retry backoff bounded; terminal disconnects stop; missing presence patch blocks connection", () => {
  assert.equal(retryDelay(0, 401), null);
  assert.equal(retryDelay(0, 440), null);
  assert.equal(retryDelay(0, 408), 1000);
  assert.equal(retryDelay(100, 408), 60000);
  const patched = readFileSync(
    "node_modules/@whiskeysockets/baileys/lib/Socket/chats.js",
    "utf8",
  );
  assert.match(
    patched,
    /whatsapp-readonly-mcp: suppress automatic presence broadcasts/,
  );
  assert.doesNotMatch(patched, /sendPresenceUpdate\(markOnlineOnConnect \?/);
});

test("nested view-once envelopes are excluded while nested edited documents normalize", () => {
  assert.equal(
    normalize(
      raw({
        ephemeralMessage: {
          message: {
            viewOnceMessageV2: {
              message: { imageMessage: { caption: "secret" } },
            },
          },
        },
      }),
    ),
    null,
  );
  assert.equal(
    normalize(
      raw({
        documentWithCaptionMessage: {
          message: {
            editedMessage: {
              message: { documentMessage: { caption: "edited" } },
            },
          },
        },
      }),
    ).edited,
    true,
  );
});
test("real Baileys HTTP boundary forwards redirect rejection and cancellation", async () => {
  const { getHttpStream } = await import("@whiskeysockets/baileys");
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let options;
  globalThis.fetch = async (_url, input) => {
    options = input;
    return new Response("synthetic bytes");
  };
  try {
    const stream = await getHttpStream("https://mmg.whatsapp.net/synthetic", {
      redirect: "error",
      signal: controller.signal,
    });
    for await (const chunk of stream) assert.ok(chunk.length);
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, controller.signal);
    controller.abort();
    assert.equal(options.signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
