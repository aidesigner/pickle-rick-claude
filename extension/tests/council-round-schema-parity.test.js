// @tier: fast
//
// R-DWF-4 trap-door test (R-DWF-SCHEMA-PARITY / AC-DWF-04) for the in-script
// SUBAGENT_PAYLOAD_SCHEMA literal in .claude/workflows/council-round.js.
//
// Proves round-trip parity: every fixture payload accepted by the canonical TS
// validateSubagentPayload (extension/services/council-schema.js) validates against
// SUBAGENT_PAYLOAD_SCHEMA, and every fixture it rejects fails the schema too.
//
// The schema is a const inside the workflow body (a script with a bare top-level
// `return`, not an importable module). We recover the REAL literal the same way the
// runtime sees it: wrap the body in an AsyncFunction with mocked ambients and capture
// the `schema` the workflow hands to its first Phase-B agent() call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import { validateSubagentPayload } from '../services/council-schema.js';

const Ajv = AjvModule.default || AjvModule;

const WORKFLOW_PATH = fileURLToPath(new URL('../../.claude/workflows/council-round.js', import.meta.url));

/** Capture the in-script SUBAGENT_PAYLOAD_SCHEMA by running the workflow with mocked ambients. */
function loadSubagentPayloadSchema() {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const body = src.replace(/^export\s+const\s+meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body);

  let captured = null;
  const agent = async (_prompt, opts = {}) => {
    if (opts.schema && !captured) captured = opts.schema;
    // Return a minimal SubagentPayload-valid object so the body keeps running.
    return { category: 'B1_stack_structure', branch: null, status: 'ok', skip_reason: null, findings: [], trap_door_candidates: [], codex_per_branch: null };
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const phase = () => {};
  const log = () => {};
  const argsObj = { branches: ['feat/a', 'feat/b'], stackTier: 'm', codexEnabled: false, hasMigrationJournal: false, round: 1, sessionFiles: {} };

  // Kick the body; we only need it to reach the first schema-bearing agent() call.
  const p = fn(agent, parallel, async () => {}, phase, log, argsObj, {});
  return p.then(() => captured);
}

/** Does the canonical TS validator accept this payload (no throw)? */
function tsAccepts(payload) {
  try {
    validateSubagentPayload(payload);
    return true;
  } catch {
    return false;
  }
}

function fullFinding(overrides = {}) {
  return {
    severity: 'P1',
    confidence: 90,
    source: 'COUNCIL',
    file: 'src/x.ts',
    line: 42,
    rule: 'some-rule',
    description: 'desc',
    recommendation: 'fix it',
    line_range: null,
    data_flow: null,
    scenario: null,
    snippet_before: null,
    snippet_after: null,
    ...overrides,
  };
}

function okPayload(overrides = {}) {
  return {
    category: 'B1_stack_structure',
    branch: null,
    status: 'ok',
    skip_reason: null,
    findings: [],
    trap_door_candidates: [],
    codex_per_branch: null,
    ...overrides,
  };
}

const TRAP_DOOR = { path: 'src/x.ts', constraint: 'must hold', why_it_breaks: 'because', what_must_hold: 'invariant' };

const ACCEPTED = [
  ['minimal ok', okPayload()],
  ['skipped with reason', okPayload({ status: 'skipped', skip_reason: 'no Drizzle journal', category: 'B7_migration_hygiene' })],
  ['ok with full finding (all 13 keys)', okPayload({ findings: [fullFinding()] })],
  ['finding with nullable strings populated', okPayload({ findings: [fullFinding({ line_range: '40-44', data_flow: 'a→b', scenario: 'x', snippet_before: 'old', snippet_after: 'new' })] })],
  ['ok with trap door candidate', okPayload({ trap_door_candidates: [TRAP_DOOR] })],
  ['branch as string', okPayload({ branch: 'feat/a', category: 'C_correctness' })],
  ['C_codex with codex_per_branch populated', okPayload({ category: 'C_codex', codex_per_branch: { 'feat/a': { verdict: 'approve', reason: 'looks fine' } } })],
  ['C_codex with empty codex_per_branch object', okPayload({ category: 'C_codex', codex_per_branch: {} })],
  ['rule/description/recommendation empty strings', okPayload({ findings: [fullFinding({ rule: '', description: '', recommendation: '' })] })],
];

const REJECTED = [
  ['unknown category', okPayload({ category: 'B99_bogus' })],
  ['ok but skip_reason non-null', okPayload({ skip_reason: 'should be null' })],
  ['skipped but empty skip_reason', okPayload({ status: 'skipped', skip_reason: '' })],
  ['skipped but null skip_reason', okPayload({ status: 'skipped', skip_reason: null })],
  ['confidence out of range (101)', okPayload({ findings: [fullFinding({ confidence: 101 })] })],
  ['line < 1', okPayload({ findings: [fullFinding({ line: 0 })] })],
  ['bad severity', okPayload({ findings: [fullFinding({ severity: 'P5' })] })],
  ['bad source', okPayload({ findings: [fullFinding({ source: 'BOGUS' })] })],
  ['finding missing nullable key (line_range absent)', okPayload({ findings: [(() => { const f = fullFinding(); delete f.line_range; return f; })()] })],
  ['empty file', okPayload({ findings: [fullFinding({ file: '' })] })],
  ['codex value missing verdict', okPayload({ category: 'C_codex', codex_per_branch: { 'feat/a': { reason: 'x' } } })],
  ['trap door empty path', okPayload({ trap_door_candidates: [{ ...TRAP_DOOR, path: '' }] })],
  ['branch as number', okPayload({ branch: 5 })],
  ['missing findings key', (() => { const p = okPayload(); delete p.findings; return p; })()],
  ['status bogus', okPayload({ status: 'bogus', skip_reason: null })],
];

test('SUBAGENT_PAYLOAD_SCHEMA is recovered from the workflow and is a strict-shaped object', async () => {
  const schema = await loadSubagentPayloadSchema();
  assert.ok(schema && schema.type === 'object', 'must capture the in-script SUBAGENT_PAYLOAD_SCHEMA');
  assert.ok(Array.isArray(schema.required) && schema.required.includes('skip_reason'), 'schema must require skip_reason');
  // Lenient by design: extra keys allowed (validateSubagentPayload ignores unknown keys).
  assert.notEqual(schema.additionalProperties, false, 'schema must NOT set additionalProperties:false (parity with TS validator leniency)');
});

test('AC-DWF-04: every ACCEPTED fixture passes BOTH validators (round-trip)', async () => {
  const schema = await loadSubagentPayloadSchema();
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  for (const [name, payload] of ACCEPTED) {
    assert.ok(tsAccepts(payload), `TS validator must ACCEPT: ${name}`);
    assert.ok(validate(payload), `schema must ACCEPT: ${name} — ${ajv.errorsText(validate.errors)}`);
  }
});

test('AC-DWF-04: every REJECTED fixture fails BOTH validators (round-trip)', async () => {
  const schema = await loadSubagentPayloadSchema();
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  for (const [name, payload] of REJECTED) {
    assert.equal(tsAccepts(payload), false, `TS validator must REJECT: ${name}`);
    assert.equal(validate(payload), false, `schema must REJECT: ${name}`);
  }
});
