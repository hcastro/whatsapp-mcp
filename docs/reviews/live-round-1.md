# Live reader — review round 1

Reviewer: GPT-6.1 Sol subagent `/root/live_review_sol`, using the actual personal strategic-code-design rubric and code-comments skill. Verdict: needs changes.

- High: Cached/live messages could falsely mark a history request received. Fixed with an archive-owned selected-chat history generation, incremented only by history events; response status is `history-observed`, not a claim that a particular request was fulfilled. Cached/new ordinary messages do not establish history delivery.
- High: IPC 42/45-second timers were shorter than allowed probe/download/parse budgets. Fixed with a 60-second operation deadline, 65-second transport deadline, cancellation context propagated into transfer, waits and parser termination, and cancellation on client disconnect.
- Medium: Spreadsheet cell clipping was not reported and a large row could be cut into invalid JSON. Fixed explicit clipping tracking and complete-row JSON bounding.
- Medium: Deadline/lifetime policy was scattered. The IPC request context now owns the outer deadline; components retain smaller local budgets.

Added regression checks for ordinary updates during a history wait, account scope/recovery throttling, transfer/parser/client-disconnect cancellation, clipped cells and large valid row JSON. Existing actual history-event tests distinguish history ingestion from normal updates.

Comment audit: applied the requested self-contained replacements for connected-reader and parser interface comments. Pairing compatibility comments belong to the earlier already-tested dependency patch; kept their semantics and exact-source guard text unchanged to avoid an unrelated dependency migration during this reader change. They describe protocol constraints and do not introduce narrative/debug breadcrumbs.

The user clarified account-wide user-directed access after this round, superseding the old single-chat connector restriction, and explicitly approved full-history recovery. The revised account scope and guarded recovery capability are included in the next review. The requested chat remains the only conversation read for the current task.
