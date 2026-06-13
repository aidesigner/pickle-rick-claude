---
id: bbbb0070
key: FRA-CONSUME
order: 70
ac_ids: []
---

# FRA forward-create — order-70 consumer

This order-70 ticket references a path forward-created by the order-10 ticket,
annotated per R-RTRC-7 so both readiness and ticket-audit honor it instead of
flagging a false `file_path` / `path-drift`.

## Files

- `extension/tests/fixtures/greenfield-corpus/fra-forward-create/forward-created-source.ts` (created by ticket aaaa0010)

## Acceptance Criteria

- [ ] Command writes a JSON file with field `kind` matching exactly `bundle`.

<!-- audit: 7-class checked 2026-06-13 -->
