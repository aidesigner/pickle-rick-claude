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
export function extractForwardRefAnnotations(text) {
    const re = new RegExp(FORWARD_REF_ANNOTATION_RE.source, FORWARD_REF_ANNOTATION_RE.flags);
    const results = [];
    for (const match of text.matchAll(re)) {
        results.push(match[1]);
    }
    return results;
}
