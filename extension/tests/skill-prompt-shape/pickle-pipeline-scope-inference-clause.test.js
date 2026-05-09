// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(__dirname, '../../../.claude/commands/pickle-pipeline.md');
const skill = fs.readFileSync(skillPath, 'utf8');

const STEP_06_START = skill.indexOf('## Step 0.6: Scope Auto-Inference');
const STEP_1_START = skill.indexOf('## Step 1: Check tmux');

assert.ok(STEP_06_START > 0, 'Step 0.6 header missing from pickle-pipeline.md');
const step06Body = skill.slice(STEP_06_START, STEP_1_START);

describe('pickle-pipeline scope-inference clause (AC-PSAI-08 trap-door)', () => {
  test('Step 0.6 header is present and comes before Step 1', () => {
    assert.ok(STEP_06_START > 0, 'Step 0.6 header not found');
    assert.ok(STEP_1_START > STEP_06_START, 'Step 1 must follow Step 0.6');
  });

  test('Step 0.6 comes AFTER Step 0.5 (sizing check)', () => {
    const step05Start = skill.indexOf('## Step 0.5: Sizing Check');
    assert.ok(step05Start > 0, 'Step 0.5 header not found');
    assert.ok(STEP_06_START > step05Start, 'Step 0.6 must follow Step 0.5');
  });

  test('branch-name regex token is present in Step 0.6', () => {
    // R-PSAI-1: regex must match branch/feature/fix/etc. prefixed paths
    assert.match(
      step06Body,
      /branch|feature|fix|feat|hotfix|release|chore/,
      'Step 0.6 must contain branch-name regex tokens',
    );
    assert.match(step06Body, /SCOPE_SIGNAL/, 'Step 0.6 must reference SCOPE_SIGNAL');
  });

  test('api_only regex token is present in Step 0.6', () => {
    // R-PSAI-1: regex must match "API-only" class phrasing
    assert.match(
      step06Body,
      /api[\s\S]{0,20}only|api_only/i,
      'Step 0.6 must contain api-only scope signal detection',
    );
  });

  test('non-default-branch check is present in Step 0.6', () => {
    // R-PSAI-3: safety prompt for non-default branch with commits ahead
    assert.match(step06Body, /non[\s_-]default[\s_-]branch|SCOPE_SIGNAL=non_default_branch/i);
    assert.match(step06Body, /commit.*ahead|ahead.*commit/i);
  });

  test('AskUserQuestion call is referenced in Step 0.6', () => {
    // R-PSAI-1: MUST NOT silently flip — must emit AskUserQuestion
    assert.match(
      step06Body,
      /AskUserQuestion/,
      'Step 0.6 must reference AskUserQuestion (not silent flip)',
    );
  });

  test('Step 0.6 documents that scope is never silently applied', () => {
    // R-PSAI-1: MUST NOT silently flip scope on
    assert.match(
      step06Body,
      /MUST NOT silently|never silently|not silently|Do NOT silently/i,
      'Step 0.6 must document the no-silent-flip rule',
    );
  });

  test('Step 0.6 documents the operator-facing prompt shortcut', () => {
    // R-PSAI-6: "Naming a branch in your kickoff prompt is enough"
    assert.match(
      step06Body,
      /naming a branch.*kickoff|kickoff.*branch.*enough|branch.*prompt.*enough/i,
      'Step 0.6 must include the operator shortcut documentation',
    );
  });

  test('Step 8 surfaces resolved scope (R-PSAI-2)', () => {
    const step8Start = skill.indexOf('## Step 8: Report');
    assert.ok(step8Start > 0, 'Step 8 not found');
    const step8Body = skill.slice(step8Start);
    assert.match(step8Body, /Scope:/, 'Step 8 must surface the scope line');
    assert.match(
      step8Body,
      /unscoped.*anatomy-park|anatomy-park.*unscoped|scope.*unscoped/i,
      'Step 8 must include unscoped warning referencing anatomy-park',
    );
  });
});
