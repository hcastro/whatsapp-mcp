# Correctness contract and design choices

## Intended behavior

Codex can retrieve only selected, locally archived WhatsApp conversations without holding account credentials or causing WhatsApp side effects.

## Design it twice

**A — connected MCP:** one process owns a socket, archive, search and media fetch. Simple launch, but tool calls now depend on network/session lifecycle, and read-only claims are difficult to audit. Credentials and account mutation capabilities share the model-facing process.

**B — separate sync CLI and offline MCP (chosen):** human configuration/terminal commands own linking and sync; the model-facing process opens SQLite read-only. Extra explicit command, but retrieval does not know the socket, keys, download URLs, or files. Archive owns authorization, tombstones, SQL and ordering. Each boundary hides one complex decision.

**Persistence alternatives:** flat JSON/event files are easy initially but make deduplication, ordering, edits, stable IDs and concurrent reads a caller concern. SQLite WAL centralizes those invariants and permits one writer with read-only MCP processes. Credential keys use a separate SQLite database with transactional batches; never store them in the retrieval database. First schema is version 1 with an application ID; unknown ownership/versions fail before writes. The archive binds to the normalized authenticated account, and a process pins its data directory. Credentials and accepted content persist synchronously; media cannot delay them. Socket shutdown completes before final credential save and handle/lock release.

## Invariants

- Empty/malformed allowlist fails closed. Every content query, context anchor, coverage query and media lookup derives scope from the current local config.
- Discovery of all delivered chat names/IDs is an explicit local CLI operation, never an MCP tool. Unselected message bodies are discarded before persistence.
- Exact normalized chat ID grants access. PN/LID alternatives do not implicitly grant one another access.
- Stable message identity is SHA-256 of JSON `[chatId, sourceId, fromMe]`. Within a chat/direction, WhatsApp source IDs are assumed unique. Sender ID is retained but not used in the stable identity because updates sometimes omit it.
- Original bodies cannot overwrite a newer edit. Deletions are monotonic tombstones and clear cached bytes. No revision history of deleted or edited-away text is exposed.
- Pagination uses an opaque query/selection-bound cursor and a `(timestamp,id)` tie-breaker. It does not claim snapshot isolation across calls.
- History status describes observed batches, never exhaustive history. Every search/context includes incomplete coverage; errors remain distinct from empty results.
- Media APIs accept IDs only, never paths/URLs. Sync caps downloaded bytes before retaining them and rechecks selection and revision before caching.
- Link is an explicit interactive CLI command with acknowledgement flag. Serve has no Baileys import graph. Credential/session renewal occurs only in separately started sync.
- No application sending/read/presence/group mutation path. Library transport acknowledgments and synchronization traffic still occur. Verified dependency guards suppress forbidden outgoing stanzas at one common send boundary, preserve HTTP abort/redirect policy and link media stream cleanup.

## Ownership

`config.ts` validates trusted local config. `archive.ts` owns persistence and authorization. `normalize.ts` hides Baileys message representation. `auth.ts` owns durable session keys. `media.ts` owns bounded media transfer. `sync.ts` owns socket lifecycle, synchronous durable event acceptance and a bounded optional media queue. `server.ts` translates the archive contract into official MCP schemas; `cli.ts` exposes deliberate local workflows.

## Skills and instructions

Read `~/.codex/skills/strategic-code-design/SKILL.md` and exact `references/review-rubric.md`, `principles.md`, `design-it-twice.md`, `red-flags.md`. Read `~/.codex/skills/pr-comments/SKILL.md` for actionable review feedback. `pr-comments` explicitly excludes source-code comments, so source comments use the strategic skill's interface-contract/why guidance.

The source-comments skill is `~/.claude-work/skills/code-comments/SKILL.md`, a symlink to `~/Sync/dotfiles/claude-code/skills/code-comments/SKILL.md`. It was found during the final symlink-following prepublication search and applied in a per-comment audit before commit. Earlier discovery without symlink following missed it; it is not unavailable. See `reviews/code-comments.md` for every verdict and exact rewrite.

Discovery checked the session catalog, checkout `.agents/skills` (absent), `~/.agents/skills`, `~/.codex/skills`, `~/Projects/personal/private-agent-skills`, `~/.claude-work/skills`, and strategic-code-design linked references. No applicable AGENTS.md was found in checkout ancestry. No unrelated files changed.
