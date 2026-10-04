import { readFileSync, writeFileSync } from "node:fs";
const guards = [
  {
    file: "Socket/chats.js",
    original:
      "sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error => onUnexpectedError(error, 'presence update requests'));",
    replacement:
      "/* whatsapp-readonly-mcp: suppress automatic presence broadcasts, including unavailable. */",
  },
  {
    file: "Utils/messages-media.js",
    original:
      "const response = await fetch(url.toString(), {\n        dispatcher: options.dispatcher,",
    replacement:
      "const response = await fetch(url.toString(), {\n        ...options, // whatsapp-readonly-mcp: preserve redirect and abort policy.\n        dispatcher: options.dispatcher,",
  },
  {
    file: "Socket/socket.js",
    original: "const sendNode = (frame) => {",
    replacement:
      "const sendNode = (frame) => {\n        // whatsapp-readonly-mcp: prevent automatic presence updates and read receipts before encoding.\n        if (frame.tag === 'presence' || frame.tag === 'chatstate' || (frame.tag === 'receipt' && ['read', 'read-self', 'played', 'played-self'].includes(frame.attrs?.type))) return Promise.resolve();",
  },
  {
    file: "Utils/messages-media.js",
    original: "import { Readable, Transform } from 'stream';",
    replacement: "import { Readable, Transform, pipeline } from 'stream';",
  },
  {
    file: "Utils/messages-media.js",
    original: "return fetched.pipe(output, { end: true });",
    replacement:
      "pipeline(fetched, output, () => {}); // whatsapp-readonly-mcp: link errors and cancellation across both streams.\n    return output;",
  },
];
// Only patch the reviewed upstream text; fail on any changed implementation.
for (const guard of guards) {
  const target = new URL(
    "../node_modules/@whiskeysockets/baileys/lib/" + guard.file,
    import.meta.url,
  );
  const source = readFileSync(target, "utf8");
  if (source.split(guard.replacement).length === 2) continue;
  if (
    process.argv.includes("--check") ||
    source.split(guard.original).length !== 2
  )
    throw new Error(
      "Baileys guard missing or upstream changed: review before connecting (" +
        guard.file +
        ")",
    );
  writeFileSync(target, source.replace(guard.original, guard.replacement));
}
