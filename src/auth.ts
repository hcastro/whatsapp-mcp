import { DatabaseSync } from "node:sqlite";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

/**
 * Credentials stay outside the retrieval database. Key batches commit atomically;
 * credential records are saved in separate durable transactions.
 */
export function openAuth(path: string, allowLink: boolean) {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS auth(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM auth WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
  };
  const write = (key: string, value: unknown) =>
    db
      .prepare(
        "INSERT INTO auth VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value, BufferJSON.replacer));
  let creds = read("creds") as AuthenticationCreds | undefined;
  if (!creds) {
    if (!allowLink) {
      db.close();
      throw new Error("No credentials. Explicit account linking is required");
    }
    creds = initAuthCreds();
    write("creds", creds);
  }
  if (!creds.registered && !allowLink) {
    db.close();
    throw new Error("Session is not linked; use explicit link command");
  }
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const value = read(`${type}:${id}`);
          if (value)
            result[id] = (
              type === "app-state-sync-key"
                ? proto.Message.AppStateSyncKeyData.fromObject(
                    value as Record<string, unknown>,
                  )
                : value
            ) as SignalDataTypeMap[T];
        }
        return result;
      },
      set: async (data) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const [type, entries] of Object.entries(data))
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value) write(`${type}:${id}`, value);
              else
                db.prepare("DELETE FROM auth WHERE key=?").run(`${type}:${id}`);
            }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  return {
    state,
    save: () => write("creds", state.creds),
    close: () => db.close(),
  };
}
