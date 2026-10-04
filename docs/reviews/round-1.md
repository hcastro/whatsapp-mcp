# Independent review round 1

Reviewed 2026-10-04, before implementation fixes. Review-only; no account linking or external network requests. Applied the exact personal `strategic-code-design/SKILL.md`, `references/review-rubric.md`, `principles.md`, and `red-flags.md`; feedback follows `pr-comments/SKILL.md`. Read all eight source modules, all three tests, patch script, README and design contract. No applicable AGENTS.md was found in the project ancestry.

## Intended behavior and changed contracts

Codex must retrieve only explicitly selected local WhatsApp messages/media, while a separate deliberate sync command owns network/session access and a durable archive preserves edits/deletion tombstones without claiming exhaustive history.

New contracts include five stdio MCP tools with structured/text output parity; live local allowlist configuration; SQLite archive schema version 1 and separate credentials; Baileys message/history/delete events; bounded media downloads; and explicit interactive account linking. No prior schema migration is authorized.

## Verdict

**Block.** Two reproduced archive defects violate deletion and schema-ownership invariants, and the media transport does not enforce its advertised redirect/timeout boundary.

## Correctness and safety

- **[Blocker] Discovered chats silently discard every keyed deletion.**
  - Evidence: `src/archive.ts:116-119` rejects `timestamp <= clearedAt`; `discover` inserts chats with default `clearedAt=0`, while `deleteMessage` always supplies `timestamp=0` (`src/archive.ts:150-164`). Offline reproduction: discover the selected chat, ingest one image message, cache its bytes, call `deleteMessage`; search still returns `text: "deleted secret", deleted: false`, and media remains available. The same rejection affects new messages deleted after a chat clear.
  - Risk: revoked message bodies and attachments remain exposed even though the documented contract promises monotonic deletion tombstones. Existing deletion tests omit discovery, hiding the common production precondition.
  - Fix: make deletion application independent of history timestamp filtering. Apply clear watermarks to incoming historical content, never to keyed tombstones. Keep tombstones monotonic and clear media for existing rows. Add discovered-chat deletion, post-clear new-message deletion, and deletion-before-replay regressions.

- **[Blocker] Write-mode archive opening overwrites unsupported schema versions before checking them.**
  - Evidence: `src/archive.ts:58-74` executes creation statements and `PRAGMA user_version=1` before reading the version. Offline reproduction: create a version-1 archive, set `user_version=99`, reopen using `new Archive(path, policy)`; opening succeeds and version becomes 1. Read-only opening is guarded, but init/sync bypass the intended protection.
  - Risk: an older binary can silently downgrade or modify a newer/incompatible archive, violating the explicit fail-without-migration contract and potentially corrupting future data.
  - Fix: inspect application ownership/schema version before any schema-changing statement, accept only a genuinely empty new database or the supported schema, initialize new schema transactionally, and close the handle on constructor failure. Test unsupported read/write versions leave version/tables/content unchanged and version-zero nonempty unrelated databases are rejected.

- **[Blocker] Media download drops redirect and timeout options inside the pinned library.**
  - Evidence: `src/media.ts:40-42` passes `redirect: "error"` and `AbortSignal.timeout(30_000)`, but pinned `node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js:297-302` forwards only `dispatcher`, `method`, and `headers` to fetch. Confirmed by source inspection, not a live network test.
  - Risk: fetch uses default redirect following, allowing redirects outside the validated WhatsApp host boundary; requests can hang beyond the claimed timeout, stalling the serialized sync queue. Current tests only reject invalid initial inputs, so they cannot verify transport policy.
  - Fix: own the fetch boundary or apply a narrow pinned/fail-closed compatibility guard that actually preserves signal/redirect options. Verify via an offline mocked fetch boundary that redirects are rejected and cancellation reaches the real request. Update the dependency guard documentation if another patch is needed.

- **[High] Nested view-once envelopes bypass the exclusion rule.**
  - Evidence: `src/normalize.ts:25-33` checks only the outer message, then `normalizeMessageContent` unwraps up to five nested envelopes including view-once. A synthetic `ephemeralMessage → viewOnceMessageV2 → imageMessage` without a redundant leaf `viewOnce` flag returns an archivable record with caption `view once secret` and mediaType `image`; reproduced offline.
  - Risk: content whose protocol wrapper denotes view-once can be retained despite the documented exclusion. This is a demonstrated adapter contract failure; frequency in real traffic was not verified.
  - Fix: inspect each supported envelope while unwrapping, rejecting any view-once wrapper at any depth. Keep wrapper normalization knowledge in the adapter and add nested view-once tests alongside nested ephemeral/document wrappers.

## Design quality

- Archive ownership of authorization, IDs, ordering and tombstones is a useful deep boundary. The read-only MCP process excludes the Baileys import graph, and discovery is absent from the model-facing API. The SQL remains parameterized; scoped search/context/media and live revocation tests are present.
- **[Medium] The archive upsert path conflates content acceptance with deletion application.** The watermark bug results from forcing timestamp-free deletion events through a content history gate. Distinguish those concepts inside Archive rather than adding caller-side exceptions in sync.
- **[Medium] The media security contract depends on an unverified pass-through option.** A wrapper accepting a signal is not proof the transport honors it. Put the transport compatibility check and policy in one owner so future dependency upgrades cannot silently weaken the boundary.
- The auth interface comment says credentials and key batches commit atomically, but credentials save separately from key-batch transactions. Clarify the comment to promise atomic key batches and durable individual credential saves, unless cross-record atomicity is implemented. This is nonblocking documentation precision, not a demonstrated credential-loss bug.

## Tests and verification

- Executed `npm run check`: strict typecheck, ESLint, build, and **16/16** tests passed, including real official SDK client to child-process stdio server.
- Ran isolated SQLite fixtures under a temporary directory for discovered-chat deletion and unknown-schema reopening; both reproduced failures described above. Temporary databases were removed.
- Ran a synthetic nested view-once adapter fixture; normalization returned content instead of null.
- Inspected installed Baileys transport implementation and event definitions directly. No WhatsApp socket/account/credentials were created; no live network/older-history behavior was validated.
- Add the regression cases above, then rerun the full check before independent round 2. Later review rounds should also exercise shutdown/reconnect event ordering and error visibility; current retry tests only test delay arithmetic.

## Suggested next patch

Fix archive initialization and tombstone acceptance first, then enforce the actual media transport boundary and nested view-once exclusion. Keep fixes in their owning modules, add regressions reproducing each failure, clarify the auth comment, and rerun `npm run check`. Preserve the current offline MCP/sync separation and incomplete-history contract.

## Fixes applied after review

- Tombstones bypass only the content history watermark; regression covers discovered chats, cached media deletion, clear/replay, and post-clear deletion.
- Archive checks application ID, schema version and truly empty ownership before DDL. New schema initialization is transactional; failure closes the handle. Unknown and unrelated databases remain unchanged.
- A second guarded Baileys patch preserves RequestInit redirect/abort options. Sync validates both patches. Offline mocked fetch verifies those options reach the actual Baileys HTTP boundary.
- Normalization checks each supported envelope for view-once before unwrapping, and preserves nested edit detection. Added regressions.
- Clarified credential/key transaction comment. Added explicit legacy MCP 2024-11-05 stdio smoke test.

Validation after fixes: `npm run check` (typecheck, ESLint, guarded build and full test suite). See final verification for the latest cumulative result.
