import type { DatabaseSync } from "node:sqlite";
import { jidNormalizedUser, type Contact } from "@whiskeysockets/baileys";

export const contactSchema = `
CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,name TEXT,notify TEXT,verifiedName TEXT,username TEXT);
CREATE TABLE IF NOT EXISTS contact_aliases(pn TEXT PRIMARY KEY,lid TEXT NOT NULL UNIQUE);
`;
const fields = ["name", "notify", "verifiedName", "username"] as const;
type Names = Pick<Contact, (typeof fields)[number]>;
const directId = (id: string) =>
  /^(?:[0-9]+)@(?:s\.whatsapp\.net|lid)$/.test(id);
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();

/** Contact aliases resolve names only; authorization and message identity remain chat-scoped. */
export class ContactDirectory {
  private revision = 0;
  private changed = new Map<string, number>();
  constructor(private db: DatabaseSync) {}
  get generation() {
    return this.revision;
  }
  recover(contacts: Partial<Contact>[], generation: number): void {
    const current = contacts.filter((contact) => {
      const ids = [contact.id, contact.lid, contact.phoneNumber]
        .filter((id): id is string => !!id)
        .map(jidNormalizedUser);
      const related = ids.flatMap(
        (id) =>
          this.db
            .prepare("SELECT pn,lid FROM contact_aliases WHERE pn=? OR lid=?")
            .all(id, id) as { pn: string; lid: string }[],
      );
      return [...ids, ...related.flatMap((pair) => [pair.pn, pair.lid])].every(
        (id) => (this.changed.get(id) ?? 0) <= generation,
      );
    });
    this.update(current);
  }
  update(contacts: Partial<Contact>[]): void {
    for (const contact of contacts) {
      if (!contact.id) continue;
      const id = jidNormalizedUser(contact.id);
      if (!directId(id)) continue;
      this.changed.set(id, ++this.revision);
      this.db.prepare("INSERT OR IGNORE INTO contacts(id) VALUES(?)").run(id);
      for (const field of fields) {
        if (contact[field] === undefined) continue;
        const value = contact[field];
        this.db
          .prepare(`UPDATE contacts SET ${field}=? WHERE id=?`)
          .run(
            typeof value === "string"
              ? value.trim().slice(0, 512) || null
              : null,
            id,
          );
      }
      const pn =
        contact.phoneNumber ||
        (id.endsWith("@s.whatsapp.net") ? id : undefined);
      const lid = contact.lid || (id.endsWith("@lid") ? id : undefined);
      if (pn && lid) this.map({ pn, lid });
    }
  }
  map(pair: { pn: string; lid: string }): void {
    const pn = jidNormalizedUser(pair.pn),
      lid = jidNormalizedUser(pair.lid);
    if (!/^\d+@s\.whatsapp\.net$/.test(pn) || !/^\d+@lid$/.test(lid)) return;
    this.db.exec("SAVEPOINT contact_mapping");
    try {
      this.db
        .prepare("DELETE FROM contact_aliases WHERE pn=? OR lid=?")
        .run(pn, lid);
      this.db.prepare("INSERT INTO contact_aliases VALUES(?,?)").run(pn, lid);
      this.db.exec("RELEASE contact_mapping");
      this.changed.set(pn, ++this.revision);
      this.changed.set(lid, this.revision);
    } catch (error) {
      this.db.exec("ROLLBACK TO contact_mapping; RELEASE contact_mapping");
      throw error;
    }
  }
  find(chats: { id: string; name: string | null }[], query = "") {
    const contacts = new Map(
      (
        this.db.prepare("SELECT * FROM contacts").all() as ({
          id: string;
        } & Names)[]
      ).map((c) => [c.id, c]),
    );
    const aliases = new Map<string, string>();
    for (const pair of this.db
      .prepare("SELECT pn,lid FROM contact_aliases")
      .all() as { pn: string; lid: string }[]) {
      aliases.set(pair.pn, pair.lid);
      aliases.set(pair.lid, pair.pn);
    }
    const tokens = fold(query).split(" ").filter(Boolean);
    return chats.flatMap((chat) => {
      const alias = aliases.get(chat.id);
      const records = [
        contacts.get(chat.id),
        alias ? contacts.get(alias) : undefined,
      ];
      const names = [
        ...new Set([
          ...records.flatMap((c) => (c?.name ? [c.name] : [])),
          ...(chat.name ? [chat.name] : []),
          ...["verifiedName", "notify", "username"].flatMap((field) =>
            records.flatMap((c) =>
              c?.[field as keyof Names] ? [c[field as keyof Names]!] : [],
            ),
          ),
        ]),
      ];
      const matchedNames = names.filter((name) =>
        tokens.every((token) => fold(name).includes(token)),
      );
      if (tokens.length && !matchedNames.length) return [];
      return [
        {
          id: chat.id,
          name: names[0] ?? null,
          identityId: chat.id.endsWith("@lid") ? chat.id : (alias ?? chat.id),
          matchedNames,
        },
      ];
    });
  }
}
