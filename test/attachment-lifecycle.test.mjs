import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const workers = [];
class Worker extends EventEmitter {
  constructor() {
    super();
    workers.push(this);
  }
  terminate() {
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
}
mock.module("node:worker_threads", { namedExports: { Worker } });
const { readAttachment } = await import("../dist/attachments.js");
test("attachment read waits for worker termination before releasing its result", async () => {
  const running = readAttachment(Buffer.from("text"), "file.txt", {
    page: 1,
    startRow: 1,
  });
  let finished = false;
  running.then(() => {
    finished = true;
  });
  workers.at(-1).emit("message", {
    value: { kind: "text", fileName: "file.txt", text: "content" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  workers.at(-1).release(0);
  assert.equal((await running).text, "content");
});
test("parser cancellation also waits for worker termination", async () => {
  const controller = new AbortController();
  const running = readAttachment(
    Buffer.from("text"),
    "file.txt",
    { page: 1, startRow: 1 },
    controller.signal,
  );
  let finished = false;
  const rejected = assert.rejects(running, /cancelled/).then(() => {
    finished = true;
  });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  workers.at(-1).release(0);
  await rejected;
});
