# Three sequential review-and-fix rounds

All rounds used Henry’s exact personal `strategic-code-design` review rubric and `pr-comments` feedback guidance. Three independent reviewers inspected the progressively corrected implementation. No account linking or real user data was used.

| Round           | Initial findings                                                                                                           | Resolution                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [1](round-1.md) | Tombstones rejected after discovery; unsafe schema initialization; dropped HTTP safety options; nested view-once retention | Fixed in owning modules and guarded dependency; full check 21/21                                                       |
| [2](round-2.md) | Accepted events lost on shutdown; live data-directory confusion; missing account binding; overwritten terminal failures    | Durable event/media separation, pinned storage identity, account ownership and lifecycle regressions; full check 29/29 |
| [3](round-3.md) | Alternate automatic presence path; media stream errors/cancellation; premature async socket teardown                       | Central outgoing-stanza guard, linked stream lifetimes and awaited socket shutdown; full check 35/35                   |

Round 3 independently reverified its fixes: 11/11 targeted tests passed, with **Approve for the documented offline implementation** and no remaining actionable findings. Earlier Block verdicts describe pre-fix code and are preserved with evidence/fix appendices.

Live linking, actual conversation selection and older-history comparison remain separate approval-dependent validation steps, not completed reviews or claimed test results.

The precommit [source-comment audit](code-comments.md) applies the actual `code-comments` skill found through its symlink. Its comment-only refinements and the explicit current protocol negotiation assertion passed the full 35-test check before publication.

## SDK v2 migration reviews

The original reviews above remain the historical evidence for the archive and sync implementation. A subsequent SDK migration adds modern protocol `2026-07-28` while retaining legacy clients. Three additional focused independent reviews inspect the migration against the original published commit; the [migration assessment](../MCP-V2.md) records design choices and the upstream version-validation limitation.

- [Migration round 1](migration-round-1.md): approved; final verification documentation marked in progress pending evidence refresh.
- [Migration round 2](migration-round-2.md): approved; independent factory-recovery, defaults, pagination and validation probes passed.
- [Migration round 3](migration-round-3.md): approved; full 44-test check and independent archive-close counting across probe fallback, EOF and both signals passed.

All three focused rounds approved the migration. Final evidence was regenerated after the last review; the full 44-test check passed again. The changed comments received explicit KEEP AS-IS verdicts in every focused review.

## Linking compatibility follow-up
