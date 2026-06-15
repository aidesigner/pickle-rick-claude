// R-FRA-6 (88a4cdd6 E3): a single trailing `)` / `,` / `.` / `;` AFTER the
// annotation's closing paren is tolerated — the regex matches the annotation up
// to its own `\)` and simply leaves the trailing delimiter unconsumed, so all of
// `(forward-created))`, `(forward-created),`, `(created by ticket ab1234cd).`,
// and `(introduced by ticket ab1234cd);` parse.
//
// The canonical ticket-hash group stays `[^)]+` (NOT a bounded class) ON PURPOSE:
// a wrong-length / malformed hash MUST still MATCH so the consumer
// (`check-readiness.ts:extractForwardRefAnnotations`) can validate it against
// `FORWARD_REF_ANNOTATION_HASH_RE` and emit an `annotation_format` finding.
// Tightening this group to `{6,12}` would make a typo'd hash silently fail to
// match → no malformed finding → silent gate bypass.
export const FORWARD_REF_ANNOTATION_RE = /`([^`]+)`(\s*)\((forward-created(?:\s+by\s+ticket\s+[A-Za-z0-9]{6,12})?|((created|introduced) by ticket ([^)]+))|(created by (R-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)))\)/g;

export function extractForwardRefAnnotations(text: string): string[] {
  const re = new RegExp(FORWARD_REF_ANNOTATION_RE.source, FORWARD_REF_ANNOTATION_RE.flags);
  const results: string[] = [];
  for (const match of text.matchAll(re)) {
    results.push(match[1]);
  }
  return results;
}

// R-FRA-6 / AC-B1: the single canonical escape used for path-suffix matching,
// mirroring `check-readiness.ts:resolvePathRef`'s R-RTRC-4 regex escaping.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True iff `needle` is a path-suffix of `haystack` under the `(?:^|/)<needle>$`
// boundary — so `tests/X` matches `.../tests/X` but NOT `othertests/X`. Equal
// strings match via the `^` alternative.
function isPathSuffixOf(needle: string, haystack: string): boolean {
  const suffixRe = new RegExp(`(?:^|/)${escapeRegExp(needle)}$`);
  return suffixRe.test(haystack);
}

// AC-B1: suffix-SYMMETRIC forward-created suppression. A declared
// `extension/tests/X` suppresses a referenced `tests/X` AND a declared `tests/X`
// suppresses a referenced `extension/tests/X` — i.e. either string being a
// path-suffix of the other counts. Shared by BOTH `buildBundleCreationIndex`
// consumers (`check-readiness.ts:findPathFindings` and
// `audit-ticket-bundle.ts:checkPathDrift`) so the two gates cannot drift (R-FRA-6
// gate parity). Teeth preserved: a `ref` that is not a path-suffix of any declared
// path AND no declared path a suffix of it returns false, so a genuine phantom
// still falls through to the path resolver / git ls-files and flags.
export function isForwardCreated(ref: string, declaredPaths: Iterable<string>): boolean {
  for (const declared of declaredPaths) {
    if (isPathSuffixOf(ref, declared) || isPathSuffixOf(declared, ref)) return true;
  }
  return false;
}
