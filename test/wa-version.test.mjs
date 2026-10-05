import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWebVersion } from "../dist/wa-version.js";

test("Web version uses the official endpoint, bounds the request and forbids redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://web.whatsapp.com/sw.js");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('{"client_revision":1234567890}');
  });
  assert.deepEqual(
    await resolveWebVersion(new AbortController().signal),
    [2, 3000, 1234567890],
  );
});

test("failed, malformed and unsafe version responses never use the bundled fallback", async (t) => {
  for (const response of [
    new Response("unavailable", { status: 503 }),
    new Response("no revision here"),
    new Response('{"client_revision":0}'),
    new Response('{"client_revision":999999999999999999999}'),
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(
      resolveWebVersion(new AbortController().signal),
      /Could not verify/,
    );
    fetch.mock.restore();
  }
});

test("version lookup contains raw network errors and propagates cancellation to fetch", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    throw new Error("SECRET-NETWORK-PAYLOAD");
  });
  await assert.rejects(resolveWebVersion(controller.signal), (error) => {
    assert.match(error.message, /Could not verify/);
    assert.equal(error.message.includes("SECRET"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
