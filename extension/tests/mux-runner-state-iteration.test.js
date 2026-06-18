// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { StateManager } from '../services/state-manager.js';

// Trap-door enforcement for `src/bin/mux-runner.ts` (state-iteration write):
//   INVARIANT: every iteration_start persists `state.iteration` for the
//   current manager-loop iteration through `StateManager.update()`.
//   PATTERN_SHAPE: `updateMuxLifecycleState(statePath, { iteration` at
//   iteration_start; the write is `s.iteration = patch.iteration` inside the
//   helper's `sm.update(statePath, ` callback.
// This file is the regression guard for that invariant. It does two things:
//   1. Source-grep (PATTERN_SHAPE check) — asserts the iteration write still
//      lives in `src/bin/mux-runner.ts`. Cheap, deterministic, and survives
//      manager-loop refactors as long as the writer keeps the documented
//      shape.
//   2. Functional check — exercises a real `StateManager.update()` round-trip
//      that mirrors `updateMuxLifecycleState()` and asserts the on-disk
//      `state.json` reflects `state.iteration = N` after the write.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const muxRunnerSrcPath = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const claudeMdPath = path.resolve(__dirname, '../CLAUDE.md');

// Pulls the backtick-quoted code literals out of the PATTERN_SHAPE field of the
// `(state-iteration write)` trap-door entry in extension/CLAUDE.md. The trap-door
// convention requires PATTERN_SHAPE to point at literals that still exist in the
// referenced source so Citadel/anatomy-park pattern-replay can verify the
// invariant deterministically. A stale literal (e.g. the pre-refactor
// `state.iteration = iteration`) defeats that replay silently.
function statePatternShapeLiterals() {
  const claude = readFileSync(claudeMdPath, 'utf8');
  const entry = claude
    .split('\n')
    .find(line => line.includes('(state-iteration write)') && line.includes('PATTERN_SHAPE:'));
  assert.ok(entry, '(state-iteration write) trap-door entry with PATTERN_SHAPE must exist in CLAUDE.md');
  const shape = entry.slice(entry.indexOf('PATTERN_SHAPE:') + 'PATTERN_SHAPE:'.length);
  return [...shape.matchAll(/`([^`]+)`/g)].map(m => m[1]);
}

test('mux-runner-state-iteration: source contains updateMuxLifecycleState writer', () => {
  const src = readFileSync(muxRunnerSrcPath, 'utf8');
  assert.ok(
    src.includes('updateMuxLifecycleState'),
    'updateMuxLifecycleState helper must exist in mux-runner.ts',
  );
});

test('mux-runner-state-iteration: PATTERN_SHAPE iteration write goes through StateManager.update', () => {
  const src = readFileSync(muxRunnerSrcPath, 'utf8');
  // The canonical CLAUDE.md PATTERN_SHAPE is `s.iteration = patch.iteration`
  // inside `updateMuxLifecycleState`'s `sm.update(statePath, s => { ... })`
  // callback. This regex accepts both the abbreviated `s.iteration` and a
  // literal `state.iteration` form. What matters is: the assignment is to
  // `<state>.iteration` from `iteration`/`patch.iteration`, inside `sm.update(...)`.
  const iterationAssignment = /\b[a-zA-Z_$][\w$]*\.iteration\s*=\s*(?:patch\.)?iteration\b/;
  assert.match(src, iterationAssignment, 'state.iteration assignment must be present');

  // The assignment must live inside an sm.update() callback (StateManager.update),
  // not be a raw fs.writeFile. Find the assignment, then walk back to confirm
  // the enclosing sm.update(...) call.
  const updateCallIndex = src.search(/sm\.update\s*\(\s*statePath\s*,/);
  assert.notEqual(updateCallIndex, -1, 'sm.update(statePath, ...) call must be present');

  const assignmentMatch = src.match(iterationAssignment);
  assert.ok(assignmentMatch, 'iteration assignment must match');
  const assignmentIndex = src.indexOf(assignmentMatch[0]);
  // The sm.update() call should appear before the assignment (assignment is
  // inside the callback body). They must live in the same function so the
  // assignment is genuinely persisted through StateManager.
  assert.ok(
    updateCallIndex < assignmentIndex,
    'state.iteration assignment must be lexically inside sm.update(statePath, ...) callback',
  );
});

test('mux-runner-state-iteration: CLAUDE.md PATTERN_SHAPE literals still exist in source', () => {
  // Regression guard for the trap-door PATTERN_SHAPE drift Citadel pattern-replay
  // flagged: the documented literal `state.iteration = iteration` no longer
  // matched mux-runner.ts after the write was centralized into
  // updateMuxLifecycleState. Every backtick literal in the entry's PATTERN_SHAPE
  // must appear verbatim in the referenced source.
  const src = readFileSync(muxRunnerSrcPath, 'utf8');
  const literals = statePatternShapeLiterals();
  assert.ok(literals.length > 0, 'PATTERN_SHAPE must declare at least one code literal');
  for (const literal of literals) {
    assert.ok(
      src.includes(literal),
      `PATTERN_SHAPE literal not found in mux-runner.ts (stale trap door): ${JSON.stringify(literal)}`,
    );
  }
});

test('mux-runner-state-iteration: iteration_start is logged for each iteration', () => {
  const src = readFileSync(muxRunnerSrcPath, 'utf8');
  // The trap-door INVARIANT couples the `iteration_start` activity event with
  // the persisted state.iteration write. Both must remain present.
  assert.ok(
    src.includes("event: 'iteration_start'"),
    "logActivity must still emit event: 'iteration_start' per outer-loop iteration",
  );
});

test('mux-runner-state-iteration: StateManager.update persists iteration to state.json', () => {
  // Functional regression: simulate the runIteration() startup write by
  // running the same shape `updateMuxLifecycleState` runs — assigning
  // `s.iteration = <n>` inside `StateManager.update()`. This guards
  // against silent regression where the writer is replaced with an unsynced
  // raw write that loses the iteration counter on resume.
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pickle-mux-state-iteration-'));
  try {
    const sessionDir = path.join(tmpDir, 'session');
    mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');

    const initialState = {
      schema_version: 1,
      active: true,
      // Live pid so the R-PTSB-3 phantom-demotion guard does not demote this
      // active fixture (active+pid=null+tmux=false+iteration=0+empty-history) on read.
      pid: process.pid,
      working_dir: tmpDir,
      iteration: 0,
      step: 'research',
      max_iterations: 10,
      history: [],
    };
    writeFileSync(statePath, JSON.stringify(initialState, null, 2));

    const sm = new StateManager();
    // Mirror updateMuxLifecycleState's actual write: s.iteration = patch.iteration
    // wrapped in sm.update(statePath, s => { ... }). PATTERN_SHAPE guarantee.
    sm.update(statePath, s => {
      s.iteration = 3;
    });

    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(written.iteration, 3, 'on-disk state.iteration must reflect the manager-loop iteration write');
    assert.equal(written.active, true, 'StateManager.update must preserve other state fields');
    assert.equal(written.step, 'research', 'StateManager.update must preserve other state fields');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
