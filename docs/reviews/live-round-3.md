# Live reader — review round 3

Reviewer: GPT-6.1 Sol, using the same exact strategic design and comments skills. Verdict: needs changes.

- High: EOCD entry undercounts allowed downstream ZIP parsers to consume an unvalidated duplicate entry. Fixed strict end-record/directory bounds and counts, duplicate/non-canonical paths, local/central agreement, disk/ZIP64 rejection, checksums, expansion limits and overlapping-region rejection. DOCX consumes the validated XML bytes directly.
- Medium: Parser completion could release concurrency capacity while worker termination remained pending. Fixed by settling the parser promise only after termination resolves; termination rejection is explicit.
- Medium: ZIP validation and consumption used independent interpretations. DOCX now reuses validated content. XLSX retains its format parser only after a strict canonical ZIP subset is validated.

Adversarial regressions cover hidden duplicate replacement, undercounts, directory-size mismatches, multi-disk/ZIP64 variants and truncated end records. Mocked worker lifecycle tests hold termination pending and verify both successful and cancelled operations wait. Earlier normal XLSX/DOCX fixture tests continue verifying accepted formats.

The discovered-chat comment is approved as-is. This round found no new confirmed scope bypass. Live historical recovery and account attachment extraction remain separate acceptance checks.
