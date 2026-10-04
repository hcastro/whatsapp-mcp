# Precommit source-comment audit

Applied the actual `code-comments` skill, found at `~/.claude-work/skills/code-comments/SKILL.md` through its symlink to `~/Sync/dotfiles/claude-code/skills/code-comments/SKILL.md`. This corrects the earlier incomplete, non-symlink-following search. `pr-comments` remains separate guidance for reviewer communication.

- **REWRITE** — `src/archive.ts`, class contract: `Every query rechecks selected chats; replayed history cannot restore revoked content.`
- **KEEP AS-IS** — `src/archive.ts`, account binding: `One authenticated account owns this archive; never adopt a populated, unbound archive.`
- **KEEP AS-IS** — `src/archive.ts`, discovery boundary: `Local human-only discovery; deliberately not exposed by MCP.`
- **KEEP AS-IS** — `src/archive.ts`, replay invariant: `Replayed history cannot resurrect deletions or replace a newer edit with the original body.`
- **REWRITE** — `src/auth.ts`, durability contract: `Credentials stay outside the retrieval database. Key batches commit atomically; credential records are saved in separate durable transactions.`
- **KEEP AS-IS** — `src/config.ts`, configuration contract: `Read for every operation: malformed or removed configuration fails closed.`
- **KEEP AS-IS** — `src/media.ts`, transfer boundary: `Only WhatsApp-hosted media, without redirects/reuploads, and bounded before buffering.`
- **REWRITE** — `src/normalize.ts`, identity contract: `Phone-number and opaque WhatsApp IDs remain separate; selecting one never grants access to the other.`
- **REWRITE** — `src/normalize.ts`, wrapper exclusion: `Exclude view-once messages at every nesting depth so wrappers cannot make them permanent.`
- **KEEP AS-IS** — `src/server.ts`, compatibility reason: `Return the same object through both paths for clients without structured output support.`
- **KEEP AS-IS** — `src/sync.ts`, process boundary: `Explicit network process; never called or imported by the MCP entry point.`
- **KEEP AS-IS** — `src/sync.ts`, error precedence: `Preserve the shutdown error if storage is also unavailable.`
- **KEEP AS-IS** — `src/sync.ts`, optional-transfer constraint: `Optional downloads never hold up durable messages, revocations, or credentials.`
- **KEEP AS-IS** — `scripts/patch-baileys.mjs`, installed presence guard marker: `whatsapp-readonly-mcp: suppress automatic presence broadcasts, including unavailable.`
- **KEEP AS-IS** — `scripts/patch-baileys.mjs`, installed HTTP guard marker: `whatsapp-readonly-mcp: preserve redirect and abort policy.`
- **REWRITE** — `scripts/patch-baileys.mjs`, installed send-boundary marker: `whatsapp-readonly-mcp: prevent automatic presence updates and read receipts before encoding.`
- **DELETE** — `scripts/patch-baileys.mjs`, import-line marker `own both stream lifetimes`: the later pipeline comment carries the reason; this repeats it.
- **REWRITE** — `scripts/patch-baileys.mjs`, installed pipeline marker: `whatsapp-readonly-mcp: link errors and cancellation across both streams.`
- **REWRITE** — `scripts/patch-baileys.mjs`, patch policy: `Only patch the reviewed upstream text; fail on any changed implementation.`
- **REWRITE** — `test/transport-policy.test.mjs`, credential-update fixture reason: `Credential updates can trigger presence even when automatic online status is disabled.`
