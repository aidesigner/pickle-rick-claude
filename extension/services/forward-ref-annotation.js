import * as fs from 'node:fs';
import * as path from 'node:path';
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
// R-FRA-6 / AC-B1: the single canonical escape used for path-suffix matching,
// mirroring `check-readiness.ts:resolvePathRef`'s R-RTRC-4 regex escaping.
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// True iff `needle` is a path-suffix of `haystack` under the `(?:^|/)<needle>$`
// boundary — so `tests/X` matches `.../tests/X` but NOT `othertests/X`. Equal
// strings match via the `^` alternative.
function isPathSuffixOf(needle, haystack) {
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
export function isForwardCreated(ref, declaredPaths) {
    for (const declared of declaredPaths) {
        if (isPathSuffixOf(ref, declared) || isPathSuffixOf(declared, ref))
            return true;
    }
    return false;
}
// WS3 (#120 R-ATPR) gate-parity: the SINGLE extension-relative directory resolver shared by
// both `check-readiness.ts:resolvePathRef` and `audit-ticket-bundle.ts:loadDispositions`.
// Walks UP from `startDir` (≤6 hops) to the `extension/` package root: returns `dir` when it
// IS the extension package (basename `extension` + a `package.json`), else the `extension/`
// child of `dir` when that child holds a `package.json`, else ascends to the parent; stops at
// the filesystem root. Returns null when no `extension/` package root is found. This is the
// lone home for the `fs.existsSync(path.join(dir, 'extension', 'package.json'))`-style walk —
// neither consumer may re-inline it (enforced by gate-parity-shared-resolver.test.js).
export function resolveExtensionDir(startDir) {
    let dir = startDir;
    for (let i = 0; i < 6; i++) {
        if (path.basename(dir) === 'extension' && fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, 'extension', 'package.json'))) {
            return path.join(dir, 'extension');
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
// WS3 (#120 R-ATPR) gate-parity: the SINGLE resolution outcome both gates consume for an
// extension-relative path reference. True iff `ref` is an existing absolute path, OR resolves
// against `repoRoot`, OR resolves against the shared `extension/` package dir under `repoRoot`.
// A genuine phantom (no such file under any base) returns false so the teeth are preserved.
export function resolveExtensionRelativePath(ref, repoRoot) {
    if (path.isAbsolute(ref) && fs.existsSync(ref))
        return true;
    if (fs.existsSync(path.resolve(repoRoot, ref)))
        return true;
    const extDir = resolveExtensionDir(repoRoot) ?? path.join(repoRoot, 'extension');
    return fs.existsSync(path.resolve(extDir, ref));
}
