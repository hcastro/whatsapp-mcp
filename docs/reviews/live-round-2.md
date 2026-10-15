# Live reader — review round 2

Reviewer: GPT-6.1 Sol, same review agent and exact strategic-code-design/code-comments skills. Verdict: needs changes.

- High: A rejected anchorless chat-history request prevented the approved account fallback. Fixed only for anchorless account requests, with cancellation, socket identity and current account authorization rechecked before recovery. Selected-mode, revoked-scope and cancelled requests preserve errors and never escalate to full history.
- Medium: Delayed history did not update retained request status. Fixed by storing each request's history-generation baseline and checking it on every subsequent read, including reads that request no new history.
- Medium: Raw discovery included unsupported IDs. `availableChats()` now applies the owning authorization rule before exposing metadata; raw human discovery remains distinct.
- Medium: `selectedChats` obscured account-mode semantics. Renamed to `availableChats` and documented the legacy MCP listing as a compatibility operation.

New regressions cover anchorless refusal, delayed history, selected/revoked/cancelled fallback prevention, and filtering unsupported discovered IDs. The discovered-chat comment was rewritten exactly as requested; the connected-reader and parser comments were approved as-is.

Account scope and full-history recovery are authorized by the user's explicit approval and subsequent clarification that any conversation should be readable on direction. The current live task still reads only the requested chat. This review does not establish historical delivery or real-account attachment extraction.
