import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";

test("installed transport boundary suppresses all presence/chatstate/read stanzas but retains sync delivery traffic", async () => {
  const source = readFileSync(
    "node_modules/@whiskeysockets/baileys/lib/Socket/socket.js",
    "utf8",
  );
  const start = source.indexOf("const sendNode = (frame) => {");
  const end = source.indexOf("\n    };", start) + 7;
  const sent = [];
  const sendNode = runInNewContext(source.slice(start, end) + "\nsendNode;", {
    logger: { level: "silent" },
    encodeBinaryNode: (x) => x,
    sendRawMessage: async (x) => {
      sent.push(x);
    },
  });
  for (const tag of ["presence", "chatstate"])
    await sendNode({ tag, attrs: {} });
  for (const type of ["read", "read-self", "played", "played-self"])
    await sendNode({ tag: "receipt", attrs: { type } });
  assert.equal(sent.length, 0);
  await sendNode({ tag: "receipt", attrs: { type: "inactive" } });
  await sendNode({ tag: "iq", attrs: { type: "get" } });
  assert.equal(sent.length, 2);
  const pairingFrames = [
    {
      tag: "iq",
      attrs: { type: "result", to: "s.whatsapp.net", id: "fixture-pair" },
    },
    {
      tag: "iq",
      attrs: { type: "result", id: "fixture-success" },
      content: [
        {
          tag: "pair-device-sign",
          attrs: {},
          content: Buffer.from("synthetic-signature"),
        },
      ],
    },
    {
      tag: "ack",
      attrs: {
        class: "notification",
        type: "companion_reg_refresh",
        id: "fixture-refresh",
      },
    },
  ];
  for (const frame of pairingFrames) await sendNode(frame);
  assert.deepEqual(sent.slice(2), pairingFrames);
  // Credential updates can trigger presence even when automatic online status is disabled.
  sent.length = 0;
  const listenerStart = source.indexOf("ev.on('creds.update', update => {");
  const listenerEnd = source.indexOf("\n    });", listenerStart) + 8;
  const ev = new EventEmitter();
  const creds = { me: { name: "Synthetic" } };
  runInNewContext(source.slice(listenerStart, listenerEnd), {
    ev,
    creds,
    sendNode,
    logger: { debug() {}, warn() {} },
  });
  ev.emit("creds.update", { accountSyncCounter: 1 });
  ev.emit("creds.update", { me: { name: "Changed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(creds.me.name, "Changed");
});
