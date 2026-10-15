import { test, mock } from "node:test";
import assert from "node:assert/strict";
const real = await import("@whiskeysockets/baileys");
let incomplete = false;
let verifyFails = false;
let actualDecoder = false;
const mutationMap = {
  contact: {
    index: ["contact", "111@s.whatsapp.net"],
    syncAction: { value: { contactAction: { fullName: "Jordan Example" } } },
  },
  read: {
    index: ["read", "111@s.whatsapp.net"],
    syncAction: { value: { markChatAsReadAction: { read: true } } },
  },
};
mock.module("@whiskeysockets/baileys", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(real).filter(([name]) => name !== "default"),
    ),
    extractSyncdPatches: async (_response, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      return {
        critical_unblock_low: {
          snapshot: actualDecoder
            ? {
                version: { version: 1 },
                records: [],
                keyId: { id: Buffer.from("synthetic") },
                mac: Buffer.alloc(32),
              }
            : {},
          patches: [],
          hasMorePatches: incomplete,
        },
      };
    },
    decodeSyncdSnapshot: async (
      collection,
      _snapshot,
      getKey,
      _minimum,
      verify,
      logger,
    ) => {
      if (actualDecoder)
        return real.decodeSyncdSnapshot(
          collection,
          _snapshot,
          getKey,
          _minimum,
          verify,
          logger,
        );
      assert.equal(collection, "critical_unblock_low");
      assert.equal(verify, true);
      await getKey("synthetic");
      if (verifyFails) throw new Error("bad MAC");
      return { state: { version: 1 }, mutationMap };
    },
  },
  defaultExport: real.default,
});
const { recoverContacts } = await import("../dist/contact-recovery.js");
test("recovery requests only contact snapshot, validates MACs, reads keys without resets and fails closed", async () => {
  let queries = 0;
  let reads = 0;
  const socket = {
    query: async (node, timeout) => {
      queries++;
      assert.equal(timeout, 10000);
      assert.deepEqual(node.content, [
        {
          tag: "sync",
          attrs: {},
          content: [
            {
              tag: "collection",
              attrs: {
                name: "critical_unblock_low",
                version: "0",
                return_snapshot: "true",
              },
            },
          ],
        },
      ]);
      return { tag: "iq", attrs: { type: "result" } };
    },
    authState: {
      keys: {
        get: async (type, ids) => {
          reads++;
          assert.equal(type, "app-state-sync-key");
          if (!actualDecoder) assert.deepEqual(ids, ["synthetic"]);
          return { [ids[0]]: { keyData: Buffer.alloc(32, 1) } };
        },
        set: () => assert.fail("must not reset app-state or credentials"),
      },
    },
  };
  const out = await recoverContacts(socket, new AbortController().signal);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Jordan Example");
  assert.equal(queries, 1);
  assert.equal(reads, 1);
  incomplete = true;
  await assert.rejects(
    recoverContacts(socket, new AbortController().signal),
    /incomplete/,
  );
  incomplete = false;
  verifyFails = true;
  await assert.rejects(
    recoverContacts(socket, new AbortController().signal),
    /bad MAC/,
  );
  verifyFails = false;
  actualDecoder = true;
  await assert.rejects(
    recoverContacts(socket, new AbortController().signal),
    /integrity/,
  );
  actualDecoder = false;
  const abort = new AbortController();
  abort.abort();
  const before = queries;
  await assert.rejects(recoverContacts(socket, abort.signal));
  assert.equal(queries, before);
});
