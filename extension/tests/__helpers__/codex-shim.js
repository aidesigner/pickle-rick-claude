import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'package.json');

function readEnginesCodexRange() {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
    const range = pkg?.engines?.codex;
    if (typeof range !== 'string' || range.trim() === '') {
        throw new Error(`extension/package.json missing engines.codex — required by codex shim fixture`);
    }
    return range.trim();
}

// Mirrors the floor/caret/exact range shapes that setup.ts:codexVersionSatisfiesRange
// supports. Returns the lower bound, which by definition satisfies the range.
export function compatibleCodexVersion() {
    const range = readEnginesCodexRange();
    const floor = range.match(/^>=\s*(\d+\.\d+\.\d+)$/);
    if (floor) return floor[1];
    const caret = range.match(/^\^(\d+\.\d+\.\d+)$/);
    if (caret) return caret[1];
    const exact = range.match(/^(\d+\.\d+\.\d+)$/);
    if (exact) return exact[1];
    throw new Error(`codex shim cannot derive a satisfying version from engines.codex="${range}" — supported shapes: >=X.Y.Z, ^X.Y.Z, X.Y.Z`);
}

// A version reliably below every non-degenerate lower bound, used to assert
// the version-mismatch failure path in setup.
export function incompatibleCodexVersion() {
    return '0.0.0';
}

// Full `codex --version` output line for the given version, matching the
// live binary's `codex-cli X.Y.Z` shape.
export function codexVersionLine(version) {
    return `codex-cli ${version}`;
}
