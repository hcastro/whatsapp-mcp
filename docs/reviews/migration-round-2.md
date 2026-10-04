# SDK migration review — round 2

Scope: independent review of the migration against `0540db22931fc1778df1226fa1c9d924cfd889bf`, after round 1 and its documentation correction. Intended behavior: serve modern MCP and preserve legacy clients while retaining selected-chat authorization, offline operation and deterministic archive cleanup.

Read and applied the exact personal `strategic-code-design` skill and its `review-rubric.md`, `principles.md` and `red-flags.md`, plus the actual `code-comments` skill. Changed contracts are split SDK dependencies, explicit Zod object schemas, opening negotiation and per-instance archive ownership. Archive persistence, query authorization and WhatsApp linking policy are unchanged.

## Verdict

**Approve** for the documented offline migration.

The changed lifecycle and validation contracts are correct in the inspected code and independent executable probes; no actionable correctness, safety or design finding remains from this round.

## Correctness and safety

- No blocker or high-severity finding.
- **Factory failure and recovery:** independently started the real stdio CLI with a valid configuration but no archive. The first modern request returned sanitized JSON-RPC internal error `-32603`, with only `MCP transport error.` on stderr. After creating a synthetic archive locally, the same process successfully served five tools and message retrieval. No credentials were created. The archive constructor closes its SQLite handle on initialization failure; tool-registration failure is separately guarded by the factory's catch/close path.
- **Ownership and shutdown:** inspected the installed published SDK's probe replacement, channel close, late factory disposal and EOF paths alongside the application's factory. A fresh archive is owned by each returned server; its close callback is preserved by protocol connection. The application does not reuse the discarded probe's database handle. Existing executable tests cover probe-to-legacy replacement and clean EOF/SIGINT/SIGTERM before and after an instance is created.
- **Input validation and defaults:** independently exercised a synthetic 35-message archive over modern raw stdio. Omitting `arguments` applied the empty-query and 30-message defaults, returned a cursor, and a second request returned the remaining five messages. Zero/oversized/string limits, null query, and an invalid chat ID were rejected as tool errors without structured message output. An unselected valid chat ID was also rejected. This checks Standard Schema transformation behavior rather than assuming the previous SDK's defaults survived the migration.
- **Accepted upstream limitation:** `docs/MCP-V2.md` explicitly describes the SDK's established-connection revision behavior. Installed `serveStdio` validates opening classification, then passes ordinary pinned-era requests to the selected channel without reclassifying their revision. This review does not claim strict rejection of a changed revision on every request. Authorization remains independent of that metadata and is enforced by unchanged archive methods. Adding a second application-owned wire parser is not required for the documented fixed-revision client contract.

## Design quality

- No actionable design finding.
- The official SDK owns modern/legacy protocol selection and encoding. The application owns archive construction and teardown in one factory, keeping protocol state out of retrieval handlers.
- Explicit object schemas preserve one validation boundary and avoid duplicating default rules inside handlers. The shared test fixture hides process plumbing while tests still assert observable wire behavior.
- Final evidence is now clearly marked as in progress; regenerate the final check log and source manifest after round 3 as already planned. Do not present the pre-migration artifacts as final migration evidence.

## Tests and verification

- Ran `node --experimental-test-module-mocks --test test/modern.test.mjs test/legacy.test.mjs test/protocol.test.mjs`: **12/12 passed**.
- Independently ran a temporary, inline raw-stdio reproduction covering archive-open failure and recovery, omitted arguments/defaults, five invalid input cases, unselected-chat denial, cursor pagination, clean EOF and absence of credentials. All assertions passed; no reproduction file was added to the project.
- Reviewed the complete migration source diff, modern and legacy wire tests, actual SDK serving implementation, archive constructor/close behavior and documented protocol limitation.
- Run the final full typecheck/lint/build/regression suite after round 3. Actual Codex-host negotiation, account linking and real history coverage remain outside this offline review.

## Comment audit

- **KEEP AS-IS** — `src/cli.ts:51`: `// Discovery can discard an instance before a legacy connection opens its own archive.` Explains why archive ownership belongs inside the factory and is self-contained.
- **KEEP AS-IS** — `test/modern.test.mjs:103`: `// An unsupported probe confirms signal handlers are installed without opening an archive.` Explains the non-obvious synchronization choice in the signal test.

These are all added or changed source/test comments in the reviewed migration. The unchanged structured-output comment is outside the comment diff.

## Suggested next patch

No production or test change is required by this round. Complete the third sequential independent review, refresh final evidence, and run the full final checks before publication.
