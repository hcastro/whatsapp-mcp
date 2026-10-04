# SDK migration review — round 1

Scope: uncommitted migration against `0540db22931fc1778df1226fa1c9d924cfd889bf`; independent outside-in review. Intended behavior: serve the modern MCP protocol and retain legacy stdio clients without changing read-only archive access or authorization.

Applied the exact `strategic-code-design` skill, `review-rubric.md`, `principles.md`, `red-flags.md`, and the actual personal `code-comments` skill. Changed contracts are SDK package/import names, tool-schema construction, opening negotiation, and archive lifetime. Database format, query authorization, tool names and WhatsApp connection policy are unchanged.

## Verdict

**Approve** for the documented offline implementation, with final evidence refresh required before publication.

No actionable correctness or safety defect was found in the migration. The documented upstream version-validation limitation is acceptable for this local, pinned-protocol deployment; it must remain explicit rather than being described as strict per-request version enforcement.

## Correctness and safety

- No blocker or high-severity finding.
- **Accepted upstream limitation — established connection version validation.**
  - Evidence: independently reproduced a valid modern `tools/list`, followed by a `tools/list` claiming `2099-01-01`; both returned five tools. A subsequent valid `sync_coverage` remained usable and reported `complete: false`. Installed SDK `serveStdio` passes messages directly to the selected channel in its pinned state; only opening classification rejects unsupported revisions.
  - Risk: a client that changes revisions within a connection can receive a response encoded for the established era. This is a protocol interoperability limitation, not authorization: application handlers continue to use the same archive methods, which reload the selected-chat policy on reads. Modern client tests prove live revocation for search, context and media.
  - Decision: retain the documented limitation without adding a custom wire parser or SDK fork. The application supports clients that retain their selected revision; it does not claim strict compliance for revision changes mid-connection. Re-evaluate on the next SDK upgrade.
- Archive lifetime is correctly local to each SDK factory instance. Probe-to-legacy fallback closes the discarded instance before the new instance opens its own archive. The installed SDK preserves the server's `onclose` callback, and its channel close is idempotent. The factory closes its archive if tool registration throws. No account-linking or persistence capability was introduced.

## Design quality

- **Low — final verification document still describes the pre-migration dependency and tests.**
  - Risk: a reader can mistake historical evidence for verification of the published migration.
  - Fix: refresh the final evidence document, check log, dependency audit and source manifest after all three migration review rounds. Alternatively label the original evidence explicitly as historical and link the new final evidence.
- Protocol classification and encoding remain owned by the SDK; tool handlers retain the simple archive abstraction. Explicit Zod object schemas are a small, direct adaptation. The shared raw-stdio test fixture meaningfully hides process setup, request correlation and teardown rather than adding a production wrapper.

## Tests and verification

- Executed `node --experimental-test-module-mocks --test test/modern.test.mjs test/legacy.test.mjs test/protocol.test.mjs`: **12/12 passed**.
- Coverage includes a real modern SDK client, all five tools, output schemas, structured/text parity, dynamic revocation, unsupported opening revisions, required metadata rejection, discovery-to-legacy replacement, legacy revisions `2024-11-05` and `2025-11-25`, and EOF/SIGINT/SIGTERM before and after opening a modern instance.
- Independently reproduced the documented later-request unsupported-version behavior and clean EOF exit (`code: 0`, no signal).
- Inspected the installed official SDK's opening, fallback, channel disposal and close-callback implementation. Attempts to retrieve its two official documentation pages through the web tool were unavailable; conclusions above rely on installed published source and executable reproductions, not an inaccessible page.
- Run the full typecheck/lint/build/regression suite again after the final migration changes. Actual Codex-host negotiation and real WhatsApp history remain outside this offline review and require the pending user approval.

## Comment audit

- **KEEP AS-IS** — `src/cli.ts:51`: `// Discovery can discard an instance before a legacy connection opens its own archive.` Explains the otherwise non-obvious need for a fresh archive per factory invocation.
- **KEEP AS-IS** — `test/modern.test.mjs:103`: `// An unsupported probe confirms signal handlers are installed without opening an archive.` Explains why the test sends an intentionally unsupported request before signalling the process.

These are all added or changed source/test comments in the reviewed migration diff; the unchanged structured-output comment in `src/server.ts` was not reclassified as a new comment.

## Suggested next patch

No production change is required by this round. Complete the remaining sequential reviews and refresh final verification artifacts before committing and publishing.

## Resolution before round 2

Final verification documentation now identifies the split 2.3.0 packages, 44 checks and modern/legacy coverage, and explicitly marks the migration reviews as in progress. The final log and source manifest will be refreshed after the third focused round; no historical output is claimed as final migration evidence.
