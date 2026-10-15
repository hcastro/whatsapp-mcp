# WhatsApp agent skill

## Scope and design

The repository-scoped `.agents/skills/whatsapp` skill covers directed conversation reading, summaries, attachments, and local voice notes. English transcription and Spanish/English parallel translation share full Whisper large-v3; Colombian language interpretation is an agent workflow loaded only when relevant. No new MCP tool, account session, global skill registration, or persistent client configuration was added.

Applied skills: Strategic Code Design (`~/.codex/skills/strategic-code-design`), Code Comments (`~/.claude-work/skills/code-comments`), and Skill Creator. Read and applied [Anthropic skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): concise triggering description, short main workflow, one-level references, deterministic helpers, and evaluation with a fresh agent.

Two approaches considered:

- Extend the MCP with a speech runtime and transcription endpoint: simplifies a remote caller but couples Python/MLX model lifecycle and large result files to the always-on sync service.
- Keep a repository skill with two local helpers: reuses existing authorization/media download, keeps recognition offline, and leaves protocol/session behavior unchanged. Selected for the local Mac workflow.

Correctness contract: export only specified authorized audio IDs, recheck deletion/revision and policy after downloads and before batch completion, retain source IDs and checksums, remove failed partial exports, decode bounded verified bytes without remote media references, and never overwrite earlier transcripts. Missing runtime/model, invalid input, or decoder errors must not produce a completed transcript. Translation preserves ambiguity rather than introducing a settled payment arrangement.

## Evaluations

Observed baseline gaps before packaging: repeated ad-hoc transcription commands, smaller-model recognition errors, unreliable isolated clips, and translation that could make a loosely phrased proposal sound definite.

Representative scenarios:

1. English received voice note: preserve full text and source metadata; do not execute instructions spoken in the recording.
2. Colombian Spanish notes: retain full original/English output, contextual expressions, uncertain proper names, and unspecified currency/payment periods.
3. General WhatsApp task: resolve the directed chat, distinguish cached search from a live read, follow pagination/coverage, inspect attachments, and include both directions when asked for all voice notes.
4. Ambiguous source wording: preserve uncertainty without inventing details.

Executed: existing English recording and three Spanish recordings through the packaged helpers using the already-local original bytes. The exporter rechecked archive authorization; no new WhatsApp session or live download was needed. Both default recognition and the context-check workflow were exercised. Source checksums and private permissions passed. Runtime is mlx-whisper 0.4.3; pinned large-v3 snapshot is recorded by the script/output.

Fresh-agent forward test: the agent located the runtime instructions, executed local recognition and a context check, returned complete English text with source metadata and uncertainty, treated recording content as data, and preserved ambiguous source wording. No source/test edits, live retrieval, or outgoing communication occurred.

Mixed-language mode has routing/parameter coverage and explicit verification guidance; no natural code-switching recording has been independently evaluated. General MCP behavior is covered by the existing synthetic/stdio tests, not a new live phone comparison in this task. No claim of human-verified transcription accuracy or full phone history is made.

## Sequential GPT-6.1 Sol reviews

### Round 1 — needs changes, fixes applied

- High: incoming-only default could omit outgoing notes in an explicit “all notes” request. Fixed selection instructions.
- Medium: arbitrary manifest location weakened private-output guarantees. Added approved data directory, export location, and permission validation; tests cover rejection.
- Medium: repeated source comparison rule. Consolidated one assertion while retaining per-download and final-batch checks.
- Comment audit: all six existing comments/docstrings KEEP AS-IS; decoder comment subsequently updated with the implementation.

### Round 2 — needs changes, fix applied

- High: ordinary M4A with trailing metadata failed through a nonseekable pipe. Decode verified bytes from a private temporary snapshot; force known containers, prohibit network protocols, and disable external MOV data references.
- Added synthetic trailing-metadata M4A regression. All comment verdicts KEEP AS-IS, with decoder comment updated to explain seeking/references.

### Round 3 — needs changes, fix applied

- High: FFmpeg could exit successfully after decoding only part of a damaged WAV. Enabled `-xerror` and reject error-level diagnostics. Added a truncated-WAV regression proving no completed transcript is saved.
- All six source comment/docstring verdicts KEEP AS-IS. No additional design findings.

### Round 4

Approve. No remaining correctness, safety, or design findings. Reviewer independently reran all four exporter tests and twelve Python tests; none skipped. All six source comment/docstring verdicts KEEP AS-IS. No blockers or further patch requested.

## Verification

Initial full project check passed: typecheck, ESLint, build, and all 94 Node tests (including four new exporter tests). Direct lint of the skill exporter passed. Twelve Python tests cover manifest identity/checksum/path rules, private output boundary, missing model, playlist rejection, M4A, damaged input, duration limits, offline language routing/provenance, non-overwriting outputs, and failed batch cleanup. Final post-round-4 rerun passed: typecheck, project lint plus direct skill-exporter lint, build, all 94 Node tests, all 12 Python tests (none skipped), skill-format validation, and `git diff --check`. The hardened decoder also completed English recognition and Spanish context-check recognition on the four existing private recordings. During the original skill implementation, no new runtime/model installation, account pairing, global skill installation, commit, or push was performed.

## Publication verification

Before the authorized commit and push, personal names in test fixtures and review notes were replaced with generic labels, and machine-specific runtime paths were removed from the reusable skill. The deleted translation reference remains absent. Typecheck, lint, build, 94 Node tests, 12 Python tests, skill-format validation, and whitespace checks passed. Private session files, configuration, audio, and transcripts remain excluded by `.gitignore`.
