import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Archive } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
import { contactMutations } from "../dist/contact-recovery.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-contacts-"));
  const path = join(dir, "config.json");
  const config = {
    dataDir: dir,
    access: "account",
    allowedChats: [],
    cacheMedia: false,
  };
  const save = () => writeFileSync(path, JSON.stringify(config));
  save();
  const archive = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  t.after(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { archive, config, save, path, dir };
}
test("saved names, alternate names, accents and explicit identities survive reopen without granting chat access", (t) => {
  const { archive: a, config, save, path, dir } = fixture(t);
  a.discover([
    { id: "111@lid" },
    { id: "222@s.whatsapp.net" },
    { id: "333@s.whatsapp.net", name: "Jordan Example" },
  ]);
  a.updateContacts([
    {
      id: "222@s.whatsapp.net",
      name: "Jórdan  Example",
      notify: "Jay",
      verifiedName: "Example Studio",
      username: "jexample",
      lid: "111@lid",
    },
  ]);
  assert.equal(a.findChats("JORDAN EXAMPLE").length, 3);
  assert.deepEqual(
    a.findChats("jay").map((x) => x.identityId),
    ["111@lid", "111@lid"],
  );
  assert.equal(a.findChats("example studio").length, 2);
  a.updateContacts([{ id: "222@s.whatsapp.net", notify: "New nickname" }]);
  assert.equal(a.findChats("jordan").length, 3);
  assert.equal(a.findChats("jay").length, 0);
  a.updateContacts([{ id: "222@s.whatsapp.net", name: "" }]);
  assert.equal(a.findChats("jordan").length, 1);
  const reader = new Archive(
    join(dir, "archive.sqlite"),
    configPolicy(path),
    true,
  );
  assert.equal(reader.findChats("jexample").length, 2);
  reader.close();
  config.access = "selected";
  config.allowedChats = ["111@lid"];
  save();
  assert.deepEqual(
    a.findChats("jexample").map((x) => x.id),
    ["111@lid"],
  );
  assert.throws(() => a.search({ chatId: "222@s.whatsapp.net" }));
  config.allowedChats = [];
  save();
  assert.deepEqual(a.findChats("jexample"), []);
});
test("group titles never acquire participant names; conflicting identity mappings are replaced", (t) => {
  const { archive: a } = fixture(t);
  a.discover([
    { id: "100@g.us", name: "Group" },
    { id: "111@lid" },
    { id: "333@s.whatsapp.net" },
  ]);
  a.updateContacts([
    { id: "100@g.us", name: "Jordan Example" },
    { id: "222@s.whatsapp.net", name: "Old name", lid: "111@lid" },
    { id: "333@s.whatsapp.net", name: "Current", lid: "111@lid" },
  ]);
  assert.deepEqual(a.findChats("Jordan"), []);
  assert.deepEqual(a.findChats("Old name"), []);
  assert.equal(a.findChats("current").length, 2);
  a.mapContact({ pn: "100@g.us", lid: "111@lid" });
  assert.equal(a.findChats("Group")[0].name, "Group");
});
test("schema two upgrades preserve message storage and enable durable contacts", (t) => {
  const { dir, path } = fixture(t);
  const db = new DatabaseSync(join(dir, "archive.sqlite"));
  db.exec(
    "DROP TABLE contacts; DROP TABLE contact_aliases; PRAGMA user_version=2;",
  );
  db.close();
  const reader = new Archive(
    join(dir, "archive.sqlite"),
    configPolicy(path),
    true,
  );
  assert.deepEqual(reader.findChats("Jordan"), []);
  reader.close();
  const writer = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  writer.discover([{ id: "222@s.whatsapp.net" }]);
  writer.updateContacts([{ id: "222@s.whatsapp.net", name: "Jordan Example" }]);
  assert.equal(writer.findChats("Jordan").length, 1);
  writer.close();
});
test("snapshot processing extracts contacts only and ignores read/privacy settings", () => {
  const input = [
    {
      index: ["contact", "222@s.whatsapp.net"],
      syncAction: {
        value: {
          contactAction: { fullName: "Jordan Example", lidJid: "111@lid" },
        },
      },
    },
    {
      index: ["markChatAsRead", "222@s.whatsapp.net"],
      syncAction: { value: { markChatAsReadAction: { read: true } } },
    },
    {
      index: ["privacy"],
      syncAction: {
        value: { privacySettingReadReceiptsAction: { value: true } },
      },
    },
    {
      index: ["contact", "333@lid"],
      syncAction: { value: { lidContactAction: { firstName: "Other" } } },
    },
  ];
  const out = contactMutations(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Jordan Example");
  assert.equal(out[0].lid, "111@lid");
  assert.equal(out[1].id, "333@lid");
});

test("delayed snapshot cannot overwrite a newer contact rename or cleared field", (t) => {
  const { archive: a } = fixture(t);
  a.discover([
    { id: "111@lid" },
    { id: "222@s.whatsapp.net" },
    { id: "333@s.whatsapp.net" },
  ]);
  a.mapContact({ pn: "222@s.whatsapp.net", lid: "111@lid" });
  const generation = a.contactGeneration();
  a.updateContacts([{ id: "111@lid", name: "New name" }]);
  a.recoverContacts(
    [
      { id: "222@s.whatsapp.net", lid: "111@lid", name: "Stale name" },
      { id: "333@s.whatsapp.net", name: "Unchanged person" },
    ],
    generation,
  );
  assert.equal(a.findChats("Stale name").length, 0);
  assert.equal(a.findChats("New name").length, 2);
  assert.equal(a.findChats("Unchanged person").length, 1);
  const next = a.contactGeneration();
  a.updateContacts([{ id: "111@lid", name: "" }]);
  a.recoverContacts([{ id: "111@lid", name: "Old name" }], next);
  assert.equal(a.findChats("Old name").length, 0);
});
test("contact recovery status survives restart independently of public coverage", (t) => {
  const { archive: a, dir, path } = fixture(t);
  a.setStatus("contactRecovery", { state: "complete", at: 123 });
  const reopened = new Archive(
    join(dir, "archive.sqlite"),
    configPolicy(path),
    true,
  );
  assert.deepEqual(reopened.contactRecovery(), { state: "complete", at: 123 });
  reopened.close();
});
