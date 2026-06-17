import type { CitadelFinding } from './reporter.js';

/**
 * A matcher that recognizes a deterministically-fixable ("mechanical") Citadel
 * finding by its `id`. Each matcher is a narrow, read-only predicate — the
 * array is iterated by {@link isMechanicalCitadelFinding}. Keep it extensible:
 * adding a new mechanical class is a new array entry, not a branch edit.
 */
export interface MechanicalFindingMatcher {
  /** Stable label for the mechanical class this matcher recognizes. */
  id: string;
  /** True when `finding` belongs to this mechanical class. */
  matches(finding: CitadelFinding): boolean;
}

/**
 * The exhaustive set of mechanical-finding matchers that ship today.
 *
 * Exactly one matcher: `banned-construct:brace-free-if`, emitted by
 * `banned-constructs-audit.ts` as `banned-construct:brace-free-if:<slug>:<line>`
 * at severity `Medium`. It is deterministically fixable (wrap the statement in a
 * `{ ... }` block), so a later ticket can route it to the gate-remediator.
 *
 * `nested-ternary` and the `orphan-*` trap-door findings are deliberately NOT
 * matched: they require judgement and stay non-mechanical.
 */
export const MECHANICAL_FINDING_MATCHERS: readonly MechanicalFindingMatcher[] = [
  {
    id: 'banned-construct:brace-free-if',
    matches: (finding) => finding.id.startsWith('banned-construct:brace-free-if'),
  },
];

/**
 * Classify whether a Citadel finding is mechanical (deterministically fixable).
 *
 * A finding is mechanical IFF it matches one of {@link MECHANICAL_FINDING_MATCHERS}
 * AND its severity is not `Critical`. Critical findings are never auto-remediated
 * regardless of id, so a brace-free-if escalated to Critical classifies false.
 *
 * Pure and read-only: no file system access, no mutation of `finding`.
 */
export function isMechanicalCitadelFinding(finding: CitadelFinding): boolean {
  if (finding.severity === 'Critical') return false;
  return MECHANICAL_FINDING_MATCHERS.some((matcher) => matcher.matches(finding));
}
