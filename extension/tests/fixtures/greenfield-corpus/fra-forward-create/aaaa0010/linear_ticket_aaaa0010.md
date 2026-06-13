---
id: aaaa0010
key: FRA-CREATE
order: 10
ac_ids: []
---

# FRA forward-create — order-10 producer

This order-10 ticket forward-creates a source file that the order-70 ticket
references. The path does NOT exist at HEAD by design.

## Files to create

- `extension/tests/fixtures/greenfield-corpus/fra-forward-create/forward-created-source.ts`

## Acceptance Criteria

- [ ] Command writes a JSON file with field `kind` matching exactly `bundle`.

<!-- audit: 7-class checked 2026-06-13 -->
