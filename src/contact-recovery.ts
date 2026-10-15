import {
  decodePatches,
  decodeSyncdSnapshot,
  extractSyncdPatches,
  type ChatMutation,
  type Contact,
} from "@whiskeysockets/baileys";
import type makeWASocket from "@whiskeysockets/baileys";

/** Extracts contact metadata without replaying read-state, privacy or other app-state actions. */
export function contactMutations(
  mutations: ChatMutation[],
): Partial<Contact>[] {
  return mutations.flatMap(({ index, syncAction }) => {
    const id = index[1];
    const value = syncAction.value;
    const action = value?.contactAction ?? value?.lidContactAction;
    if (!id || !action) return [];
    return [
      {
        id,
        name: action.fullName || action.firstName || "",
        username: action.username || "",
        ...("lidJid" in action &&
        typeof action.lidJid === "string" &&
        action.lidJid
          ? { lid: action.lidJid }
          : {}),
        ...("pnJid" in action &&
        typeof action.pnJid === "string" &&
        action.pnJid
          ? { phoneNumber: action.pnJid }
          : {}),
      },
    ];
  });
}

const strictIntegrity: NonNullable<Parameters<typeof decodeSyncdSnapshot>[5]> =
  {
    level: "silent",
    child: () => strictIntegrity,
    trace() {},
    debug() {},
    info() {},
    warn() {
      throw new Error("Contact snapshot integrity check failed");
    },
    error() {
      throw new Error("Contact snapshot integrity check failed");
    },
  };

/** Reads contact metadata without resetting credentials, uploading patches or replaying app-state actions. */
export async function recoverContacts(
  socket: ReturnType<typeof makeWASocket>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const name = "critical_unblock_low";
  const response = await socket.query(
    {
      tag: "iq",
      attrs: { to: "s.whatsapp.net", xmlns: "w:sync:app:state", type: "set" },
      content: [
        {
          tag: "sync",
          attrs: {},
          content: [
            {
              tag: "collection",
              attrs: { name, version: "0", return_snapshot: "true" },
            },
          ],
        },
      ],
    },
    10000,
  );
  signal.throwIfAborted();
  const options = { signal, redirect: "error" as const };
  const collection = (await extractSyncdPatches(response!, options))[name];
  if (!collection?.snapshot || collection.hasMorePatches)
    throw new Error("Contact snapshot unavailable or incomplete");
  const getKey = async (id: string) =>
    (await socket.authState.keys.get("app-state-sync-key", [id]))[id];
  const snapshot = await decodeSyncdSnapshot(
    name,
    collection.snapshot,
    getKey,
    undefined,
    true,
    strictIntegrity,
  );
  const changes = collection.patches.length
    ? await decodePatches(
        name,
        collection.patches,
        snapshot.state,
        getKey,
        options,
        undefined,
        strictIntegrity,
        true,
      )
    : undefined;
  signal.throwIfAborted();
  return contactMutations(
    Object.values({ ...snapshot.mutationMap, ...changes?.mutationMap }),
  );
}
