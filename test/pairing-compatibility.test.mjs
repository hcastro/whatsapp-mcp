import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInNewContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { Boom } from "@hapi/boom";
import {
  BufferJSON,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  S_WHATSAPP_NET,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { buildPairingQRData } from "../node_modules/@whiskeysockets/baileys/lib/Utils/companion-reg-client-utils.js";
import { buildAckStanza } from "../node_modules/@whiskeysockets/baileys/lib/Utils/stanza-ack.js";
import { openAuth } from "../dist/auth.js";

const refreshEvent = "CB:notification,type:companion_reg_refresh";

test("QR credentials resume by paired identity without a registration flag; provisional credentials cannot sync", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-qr-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.sqlite");
  const provisional = openAuth(path, true);
  provisional.close();
  assert.throws(() => openAuth(path, false), /Session is not linked/);
  const pairing = openAuth(path, true);
  pairing.state.creds.me = { id: "synthetic-account@s.whatsapp.net" };
  pairing.save();
  pairing.close();
  const resumed = openAuth(path, false);
  try {
    assert.equal(resumed.state.creds.registered, false);
    assert.equal(resumed.state.creds.me.id, "synthetic-account@s.whatsapp.net");
  } finally {
    resumed.close();
  }
});
const refreshNode = (child = "companion_reg_refresh") => ({
  tag: "notification",
  attrs: {
    from: S_WHATSAPP_NET,
    id: "synthetic-refresh",
    type: "companion_reg_refresh",
  },
  content: [{ tag: child, attrs: {} }],
});

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-pairing-"));
  const path = join(dir, "auth.sqlite");
  const auth = openAuth(path, true);
  t.after(() => {
    auth.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ws = new EventEmitter();
  ws.isOpen = true;
  const ev = new EventEmitter();
  const qrs = [],
    sequence = [],
    timers = [],
    sent = [],
    ended = [];
  ev.on("creds.update", (update) => {
    Object.assign(auth.state.creds, update);
    auth.save();
    sequence.push("persisted");
  });
  ev.on("connection.update", ({ qr }) => {
    qrs.push(qr);
    sequence.push("qr");
  });
  const context = {
    ws,
    ev,
    creds: auth.state.creds,
    closed: false,
    randomBytes,
    Buffer,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    buildPairingQRData,
    browser: ["Mac OS", "Chrome", "14.4.1"],
    S_WHATSAPP_NET,
    qrTimeout: undefined,
    qrTimer: undefined,
    DisconnectReason,
    Boom,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    sendNode: async (frame) => {
      sent.push(frame);
    },
    end: (error) => {
      context.closed = true;
      ended.push(error);
    },
  };
  const source = readFileSync(
    "node_modules/@whiskeysockets/baileys/lib/Socket/socket.js",
    "utf8",
  );
  const start = source.indexOf("// A registration refresh retires");
  const end = source.indexOf("// device paired for the first time", start);
  assert.ok(start > 0 && end > start);
  runInNewContext(source.slice(start, end), context);
  return {
    ...context,
    context,
    auth,
    path,
    qrs,
    sequence,
    timers,
    sent,
    ended,
    issueQR: () =>
      ws.listeners("CB:iq,type:set,pair-device")[0]({
        tag: "iq",
        attrs: { type: "set", id: "synthetic-pair" },
        content: [
          {
            tag: "pair-device",
            attrs: {},
            content: ["ref-one", "ref-two"].map((ref) => ({
              tag: "ref",
              attrs: {},
              content: Buffer.from(ref),
            })),
          },
        ],
      }),
  };
}

test("installed pairing handlers persist refreshed secrets before QR display, retain refs and keys, and keep timer cadence", async (t) => {
  const h = harness(t);
  const keys = structuredClone({
    noise: h.creds.noiseKey,
    identity: h.creds.signedIdentityKey,
    prekey: h.creds.signedPreKey,
  });
  await h.issueQR();
  const fields = (qr) => qr.split("#")[1].split(",");
  const original = fields(h.qrs[0]);
  const secrets = new Set([original[3]]);
  for (let i = 0; i < 50; i++) {
    h.ws.emit(
      refreshEvent,
      refreshNode(i % 2 ? "pair-device-rotate-qr" : "companion_reg_refresh"),
    );
    const current = fields(h.qrs.at(-1));
    assert.deepEqual(current.slice(0, 3), original.slice(0, 3));
    assert.equal(current[4], original[4]);
    assert.equal(Buffer.from(current[3], "base64").length, 32);
    assert.equal(current[3], h.creds.advSecretKey);
    secrets.add(current[3]);
    assert.deepEqual(h.sequence.slice(-2), ["persisted", "qr"]);
  }
  assert.equal(secrets.size, 51);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 60000);
  const reader = new DatabaseSync(h.path, { readOnly: true });
  try {
    const saved = JSON.parse(
      reader.prepare("SELECT value FROM auth WHERE key='creds'").get().value,
      BufferJSON.reviver,
    );
    assert.equal(saved.advSecretKey, h.creds.advSecretKey);
  } finally {
    reader.close();
  }
  h.timers[0].callback();
  assert.equal(fields(h.qrs.at(-1))[0], "ref-two");
  assert.equal(fields(h.qrs.at(-1))[3], h.creds.advSecretKey);
  assert.equal(h.timers[1].delay, 20000);
  assert.deepEqual(
    structuredClone({
      noise: h.creds.noiseKey,
      identity: h.creds.signedIdentityKey,
      prekey: h.creds.signedPreKey,
    }),
    keys,
  );
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].tag, "iq");
  h.timers[1].callback();
  assert.equal(h.ended[0].output.statusCode, 408);
});

test("refresh is inert before QR, for malformed nodes, during closed transport and after identity assignment", async (t) => {
  const h = harness(t);
  const initial = h.creds.advSecretKey;
  h.ws.emit(refreshEvent, refreshNode());
  assert.equal(h.creds.advSecretKey, initial);
  await h.issueQR();
  h.ws.emit(refreshEvent, refreshNode("unknown"));
  h.context.closed = true;
  h.ws.emit(refreshEvent, refreshNode());
  h.context.closed = false;
  h.ws.isOpen = false;
  h.ws.emit(refreshEvent, refreshNode());
  h.ws.isOpen = true;
  h.creds.me = { id: "synthetic-account@s.whatsapp.net" };
  h.ws.emit(refreshEvent, refreshNode());
  delete h.creds.me;
  h.creds.registered = true;
  h.ws.emit(refreshEvent, refreshNode());
  assert.equal(h.creds.advSecretKey, initial);
  assert.equal(h.qrs.length, 1);
  assert.deepEqual(h.sequence, ["qr"]);
});

test("installed ACK path works before login and retains message sender after login", async () => {
  const source = readFileSync(
    "node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
    "utf8",
  );
  const start = source.indexOf("const sendMessageAck = async");
  const end = source.indexOf("const rejectCall =", start);
  const sent = [];
  const authState = { creds: {} };
  const ack = runInNewContext(source.slice(start, end) + "\nsendMessageAck;", {
    buildAckStanza,
    authState,
    logger: { debug() {} },
    sendNode: async (frame) => {
      sent.push(frame);
    },
  });
  await ack(refreshNode());
  assert.deepEqual(sent[0], {
    tag: "ack",
    attrs: {
      id: "synthetic-refresh",
      to: S_WHATSAPP_NET,
      class: "notification",
      type: "companion_reg_refresh",
    },
  });
  authState.creds.me = { id: "synthetic-account@s.whatsapp.net" };
  await ack({
    tag: "message",
    attrs: { from: "synthetic-sender@s.whatsapp.net", id: "synthetic-message" },
  });
  assert.equal(sent[1].attrs.from, authState.creds.me.id);
});
