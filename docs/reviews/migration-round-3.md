# SDK migration review — round 3

Scope: third sequential independent review of the final migration against `0540db22931fc1778df1226fa1c9d924cfd889bf`, after the first two focused reviews. Intended behavior: serve modern MCP and retain legacy stdio interoperability without changing selected-chat authorization, archive contents or account access.

Read and applied the exact personal `strategic-code-design` skill and its `review-rubric.md`, `principles.md` and `red-flags.md`, plus the actual `code-comments` skill. Changed contracts are the split SDK dependencies, explicit object schemas, protocol opening and factory-owned archive lifetime. Inspected the complete production/test migration diff and the installed published SDK lifecycle implementation. This review did not edit production code or tests.

## Verdict

**Approve** for the documented offline migration.

The full verification suite and an independent archive-close probe support the changed protocol and lifecycle contracts; no actionable correctness, safety or design defect was found.

## Correctness and safety

- No blocker or high-severity finding.
- **Archive ownership verified directly:** a temporary preload instrumented `Archive.close` in the real CLI child process. For each of EOF, SIGINT and SIGTERM, the client issued discovery twice, fell back to legacy initialization, and successfully read coverage. Both archive instances closed exactly once: the discarded discovery instance and its legacy replacement. All three processes exited with code zero, without a double-close or transport error. This verifies resource disposal rather than relying only on successful process exit.
- **Authorization and offline scope are preserved:** the migration changes SDK imports, schemas and serving lifecycle; the archive's query/policy implementation, database format, Baileys synchronization and linking controls are unchanged. The real modern SDK client exercises all five tools and live revocation for search, context and media. No new network, write, account-linking or configuration tool is exposed.
- **Failure semantics remain bounded:** invalid input is checked at the schema boundary; archive failures return the existing sanitized tool error. The factory closes an opened archive if server construction throws. The installed SDK serializes opening decisions, disposes late instances after teardown and routes errors to the provided stderr handler. Test output and protocol traffic remain separated.
- **Accepted upstream interoperability limit:** the installed SDK pins an established connection's era and does not reclassify an ordinary later request's version claim. `docs/MCP-V2.md` accurately limits the claim to rejection of unsupported opening revisions and documents the later-request behavior. This does not bypass the archive's selected-chat policy. No strict per-request version-validation claim or custom protocol parser is introduced by this migration.

## Design quality

- No actionable design finding.
- Protocol selection and encoding remain inside the official SDK. The CLI factory owns archive construction and cleanup; handlers continue to use the same archive abstraction. The fresh-per-instance ownership handles discovery fallback without sharing a closed database handle or duplicating protocol state.
- Explicit Zod objects retain a single validation/defaulting boundary. The shared stdio test fixture hides process plumbing while the tests assert observable results, errors and shutdown behavior.
- The documented choice between legacy-only import replacement and the modern serving entry point makes the interface decision reviewable. Tasks, elicitation and application-owned wire interception would add complexity without helping these bounded local retrieval operations.

## Tests and verification

- Independently ran `npm run check`: strict TypeScript typecheck, ESLint, guarded build and **44/44 tests passed**; zero failed, skipped or cancelled.
- Existing tests cover modern discovery, metadata and result fields, private cache scope/zero TTL, all tool schemas, structured/text parity, authorization revocation, unsupported opening versions, missing metadata, legacy `2024-11-05` and `2025-11-25`, discovery fallback, and EOF/signals before and after opening an archive.
- Independently ran the temporary close-count reproduction described above for EOF, SIGINT and SIGTERM. Each case asserted two exact archive closures, usable legacy coverage, clean exit and no `auth.sqlite`. The temporary files were removed; no reproduction code was added to the project.
- `git diff --check` passed.
- Regenerate the final check log and source manifest after recording this review, as planned. Real Codex-host negotiation and WhatsApp history coverage remain unverified pending user approval; this review did not link an account or modify persistent Codex configuration.

## Comment audit

- **KEEP AS-IS** — `src/cli.ts:51`: `// Discovery can discard an instance before a legacy connection opens its own archive.` Explains the otherwise non-obvious per-instance archive ownership requirement in plain terms.
- **KEEP AS-IS** — `test/modern.test.mjs:103`: `// An unsupported probe confirms signal handlers are installed without opening an archive.` Explains the signal test's synchronization choice rather than restating the request itself.

These are all added or changed source/test comments in the reviewed migration diff. The existing structured-output comment is unchanged.

## Suggested next patch

No production or test patch is required. Refresh final verification artifacts, retain the documented SDK interoperability limitation and publish the verified migration through the already authorized workflow.
