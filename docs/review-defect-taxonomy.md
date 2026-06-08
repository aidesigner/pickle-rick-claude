# Review-Defect Taxonomy — What Human/Adversarial Reviewers Actually Catch

**Purpose.** This is the permanent, append-only record that seeds the review-gate flywheel
(`prds/review-gates-missed-14-human-review-defects-loa907-gap.md`). It captures the *classes* of
defect that human and adversarial-AI reviewers flag on real PRs, so the automated gates
(anatomy-park / szechuan-sauce / citadel / council-of-ricks) can be pointed at the dimensions that
actually matter. When a reviewer catches a class the gate missed, **add it here and — if it is
declarable — write it as a `PATTERN_SHAPE:` constraint** so Mechanism 1 enforces it forever.

**Corpus.** ~230 concrete reviewer-flagged issues mined from **63 PRs merged in 2026** by
`gregorydickson` across `loanlight-api` (46), `octy` (10), `loanlight-integrations` (3),
`attractor` (2), `loanlight-app` (1), `pickle-rick-codex` (1). Sources: GitHub inline review
comments, review bodies, and adversarial-bot reviews (`graphite-app[bot]`, `claude[bot]`). Primary
human reviewer signal: `jcapona` (Jorge); secondary `jabreland` (John), `YairVelasco` (Yair).

> Method note: counts are approximate (a review-comment mining pass, not a labelled dataset). The
> **ranking and the recurring-constraint list are the signal**, not the exact integers.

---

## Frequency distribution (descending)

| Class | ~Count | Default mechanism | Notes |
|---|---:|---|---|
| **T9 Security / trust-boundary** | ~35 | M1 (sibling-parity) + M2 | Mostly "new path omits a guard a documented sibling has" |
| **T11 Error-handling / edge-case** | ~34 | M2 | Async races, partial-input, rollback-over-live-state |
| **T8 DRY / dead-code / exhaustiveness** | ~30 | M1 | CLAUDE.md already bans most of it; partly eslint-able |
| **T1 Semantic-correctness** | ~26 | M2 | Type-correct, value-wrong: logic inversions, wrong identity |
| **T5 Migration / data-loss** | ~19 | M1 | Numbering, journal gaps, idempotency, constraint drift |
| **T4 Declared-constraint (CLAUDE.md) violations** | ~18 | M1 | Literal trap-door violations on the diff |
| **T6 Missing-test / silent-behavior-change** | ~14 | mixed | Default flips / removed guards shipped untested |
| **T7 Stale-comment / doc-on-diff** | ~13 | M2 | Added comment contradicts adjacent code |
| **T3 Resource-lifecycle** | ~12 | M2 | Pool/handle outside DI, never closed; blocking IO on hot path |
| **T2 Cross-file null-flow** | ~10 | M2 + M1 | `{} as T` / cast producer; unguarded consumer |
| T10 Performance / latency | ~8 | M1/M2 | N+1, token-budget overflow, uncached regen |
| T12 API / contract drift | ~6 | M1 | Producer↔consumer shape mismatch, sentinel inconsistency |
| T13 Style / taste | ~5 | neither | Low value; do not gate on these |

**Mechanism split:** roughly half the corpus is **M1** (declarable as a constraint and/or
eslint-able). M1 is therefore the highest-leverage investment — the rules largely exist or are
trivially written.

---

## Recurring constraints to codify (the M1 backlog)

Each of these recurred across **multiple PRs** and is declarable. Promote to a `PATTERN_SHAPE:`
trap door (or an eslint rule where marked) so Mechanism 1 catches it on every future diff.

| Constraint | Evidence (PRs) | Form |
|---|---|---|
| No brace-free one-liner `if` | 1356, 1409, 1416, 1623, 1649 (5×) | **eslint** (`curly`) |
| No nested ternary (esp. in JSX `className`) | 1416, 1649 | **eslint** (`no-nested-ternary`) |
| No unnecessary `as any` / `as never` / cast when TS infers | 769, 912, 1409, 398 | eslint + M1 trap door |
| No backwards-compat `_`-renamed dead params / unused aliases | 1602 | M1 trap door |
| No `.refine()` on a Zod schema that is never `.parse()`d | 912 | M1 trap door |
| New `@Body()` must use a class-validator DTO (not inline TS type) | 829 | M1 trap door |
| Migration: numbering must not collide; every SQL file has a journal entry; `ADD`/`CREATE` idempotent (`IF [NOT] EXISTS`); Drizzle schema CHECK widened with the migration | 769, 912, 934, 1088, 1134, 1356, 1586 | M1 migration-conformance scan (diff-level `.sql`, **not** journal-gated) |
| `ON CONFLICT DO UPDATE SET col=const` must not clobber a column another feature owns | LOA-907 #6, 1076 | M1 diff-level `.sql` scan |
| Sibling-route guard parity: a new route/handler must carry the same `@UseGuards` / feature-flag / budget-check / CSRF-validate / auth-gate as its nearest documented sibling | 769, 829, 1134, 1161, 1200, 1416, 1602, 1649 | M1 (extends citadel "sibling route divergence") |
| `E2E_MOCK_AUTH` (and similar test-bypass) must carry the `NODE_ENV ∈ {development,test}` second gate on **both** API and Next.js sides | **1585 → 1649 (repeat)** | M1 trap door + test |
| Drizzle timestamp columns return **strings**, not `Date` — no `.toISOString()` on them | octy #1 | M1 framework-contract trap door |
| `NEXT_PUBLIC_*` env vars are inlined at **build** time — runtime changes are no-ops | octy #28, #31 | M1 trap door |
| Deterministic IDs inside a message-queue handler (no `randomUUID()` on a retry-able insert that relies on `ON CONFLICT`) | integrations #398 | M1 trap door |
| Added/changed comment must still match the symbol/flag it cites in the same hunk | **1586 → 1602 (carry-forward)**, 1235, 14 | M2 lens + flywheel |

---

## Proven flywheel cases (why the record exists)

These are the empirical proof that "catch it, write it down, enforce it" beats re-catching:

- **`E2E_MOCK_AUTH` single-gate** — flagged on **PR#1585**, fixed, then **reintroduced on PR#1649
  six days later** and caught again by the same reviewer. Had it been a documented trap door after
  #1585, Mechanism 1 would have blocked #1649 automatically.
- **Stale `module`-column JSDoc** — flagged on **PR#1586**, then the *same* stale comment surfaced
  again on **PR#1602**. A diff-comment-accuracy lens (M2) plus a documented note would have stopped
  the carry-forward.

These are the canonical "would have been caught for free" examples cited by the PRD's AC-6.

---

## Structural observations

- **The gate is often the *only* reviewer.** octy: 10/10 PRs merged with zero substantive human
  review; ~25% of loanlight-api likewise. For agent-generated and infra PRs the automated gate is
  not a backstop to human review — it *is* the review. This raises the stakes for gate efficacy.
- **One reviewer carries the signal.** `jcapona`'s adversarial structure (multi-agent fan-out,
  explicit false-positive drops with evidence, structural-vs-semantic separation) is the behavior
  the gates should model — which is what council-of-ricks / anatomy-park already aspire to.
- **Trust-boundary asymmetry is the dominant security shape** and is *comparative*, not novel:
  almost every T9 was detectable by diffing the new path against a documented sibling. This is why
  sibling-route parity belongs in Mechanism 1, not only in an open-ended lens.

---

## Maintenance (this is the flywheel)

When a reviewer (human or Council) finds a defect the gate missed:

1. Add a one-line entry under the right class (or open a new class).
2. If it is declarable, add it to the **Recurring constraints** table *and* write the
   `PATTERN_SHAPE:` trap door in the target repo's `CLAUDE.md` so Mechanism 1 enforces it.
3. If it needs judgment, confirm the Mechanism 2 lens names its shape; tune the prompt if not.

Append-only. Do not delete classes — a class going quiet is itself signal that a constraint is working.
