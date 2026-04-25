import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.resolve(__dirname, '../../.claude/commands/pickle-pipeline.md');
const skill = fs.readFileSync(skillPath, 'utf8');

const STEP0_START = skill.indexOf('## Step 0: Refinement Prerequisite');
const STEP1_START = skill.indexOf('## Step 1: Check tmux');
const STEP3_START = skill.indexOf('## Step 3: Session Setup');
const STEP4_START = skill.indexOf('## Step 4: Create pipeline.json');
const step0Body = skill.slice(STEP0_START, STEP1_START);
const step3Body = skill.slice(STEP3_START, STEP4_START);

describe('pickle-pipeline skill prompt — description and structure', () => {
  test('first-line description fits in 80 chars and names all three runtime phases', () => {
    const firstLine = skill.split('\n')[0];
    assert.ok(firstLine.length <= 80, `first line is ${firstLine.length} chars: ${firstLine}`);
    assert.match(firstLine, /pickle-tmux/);
    assert.match(firstLine, /anatomy-park/);
    assert.match(firstLine, /szechuan-sauce/);
  });

  test('Step 0 Refinement Prerequisite is present and runs before Step 1', () => {
    assert.ok(STEP0_START > 0, 'Step 0 header missing');
    assert.ok(STEP1_START > STEP0_START, 'Step 1 must come after Step 0');
  });

  test('no stale "run /pickle-refine-prd FIRST" instruction remains (would contradict Step 0)', () => {
    assert.doesNotMatch(skill, /run\s+`?\/pickle-refine-prd`?\s+FIRST/);
  });
});

describe('pickle-pipeline Step 0 — decision tree', () => {
  test('decision tree is labeled "first match wins"', () => {
    assert.match(step0Body, /first match wins/i);
  });

  test('rule order: --no-refine wins over --refine wins over auto-infer wins over default-false', () => {
    const noRefineRule = step0Body.search(/1\.\s*`?\$ARGUMENTS`?\s+contains\s+`?--no-refine`?/);
    const refineRule = step0Body.search(/2\.\s*`?\$ARGUMENTS`?\s+contains\s+`?--refine`?/);
    const autoInferRule = step0Body.search(/3\.\s*`?\$ARGUMENTS`?\s+matches/);
    const defaultRule = step0Body.search(/4\.\s*Otherwise/);
    assert.ok(noRefineRule >= 0, 'rule 1 (--no-refine) not found');
    assert.ok(refineRule > noRefineRule, '--refine rule must follow --no-refine');
    assert.ok(autoInferRule > refineRule, 'auto-infer rule must follow --refine');
    assert.ok(defaultRule > autoInferRule, 'default-false rule must come last');
  });

  test('conflict pre-check rejects --refine + --no-refine together', () => {
    assert.match(step0Body, /Pre-check/i);
    assert.match(step0Body, /BOTH\s+`?--refine`?\s+AND\s+`?--no-refine`?/);
    assert.match(step0Body, /Conflicting flags/i);
  });
});

describe('pickle-pipeline Step 0 — auto-infer regex behavior', () => {
  function extractAutoInferRegex() {
    const match = step0Body.match(/`(\/[^`]+\/i)`/);
    assert.ok(match, 'expected an /…/i regex literal in Step 0 (rule 3)');
    const literal = match[1];
    const body = literal.slice(1, literal.lastIndexOf('/'));
    return new RegExp(body, 'i');
  }

  test('positive triggers: workflow-style refinement requests match', () => {
    const re = extractAutoInferRegex();
    for (const positive of [
      'refine-prd then build the caching layer',
      'pickle refine prd, pickle tmux, szechuan, anatomy park',
      'prd refinement followed by build',
      'refine before building',
      'refinement first, then implement',
      'Refine the PRD then ship',
    ]) {
      assert.ok(re.test(positive), `should match: ${positive}`);
    }
  });

  test('negative triggers: feature-content uses do NOT match', () => {
    const re = extractAutoInferRegex();
    for (const negative of [
      'refine the dropdown UX',
      'add a refinement loop to the model',
      'refinery pipeline scheduling',
      'redefine the API contract',
      'refactor the auth middleware',
    ]) {
      assert.ok(!re.test(negative), `should NOT match: ${negative}`);
    }
  });
});

describe('pickle-pipeline Step 0 — PRD resolution and skip gates', () => {
  test('Step 0a documents fail-fast on missing prd.md', () => {
    assert.match(step0Body, /fail fast/i);
    assert.match(step0Body, /No prd\.md found/);
    assert.match(step0Body, /Run \/pickle-prd first/);
  });

  test('Step 0b skip-if-already-refined references prd_refined.md and uses skip language', () => {
    const skipBlock = step0Body.match(/0b[^]*?(?=0c|Mid-refinement)/);
    assert.ok(skipBlock, 'Step 0b block not found');
    assert.match(skipBlock[0], /prd_refined\.md/);
    assert.match(skipBlock[0], /skip|skipping/i);
    assert.match(skipBlock[0], /Continue to Step 1/);
  });

  test('mid-refinement detection fails fast on partial state (manifest without refined PRD)', () => {
    assert.match(step0Body, /Mid-refinement/i);
    assert.match(step0Body, /refinement_manifest\.json/);
    assert.match(step0Body, /in-progress refinement/i);
    assert.match(step0Body, /\/pickle-refine-prd --resume/);
  });
});

describe('pickle-pipeline Step 0 — refine handoff and backend pinning', () => {
  test('Step 0c invokes /pickle-refine-prd inline and captures SESSION_ROOT', () => {
    const refineBlock = step0Body.match(/0c[^]*?(?=0d|Note on interactive)/);
    assert.ok(refineBlock, 'Step 0c block not found');
    assert.match(refineBlock[0], /\/pickle-refine-prd/);
    assert.match(refineBlock[0], /Capture[^.]*SESSION_ROOT/i);
    assert.match(refineBlock[0], /TASK_COMPLETED/);
  });

  test('refinement is pinned to claude backend regardless of pipeline --backend', () => {
    assert.match(step0Body, /claude[`\s]+backend\s+regardless/i);
  });

  test('Step 0c documents the interactive verification gate risk', () => {
    assert.match(step0Body, /interactive gating|interactive gate|interview/i);
    assert.match(step0Body, /pause/i);
    assert.match(step0Body, /Step 2c|verification quality/i);
  });

  test('Step 0e strips --refine/--no-refine before Step 2 reparses', () => {
    const continueBlock = step0Body.match(/0e[^]*$/);
    assert.ok(continueBlock, 'Step 0e block not found');
    assert.match(continueBlock[0], /[Ss]trip/);
    assert.match(continueBlock[0], /--refine/);
    assert.match(continueBlock[0], /--no-refine/);
    assert.match(continueBlock[0], /TASK content/);
  });
});

describe('pickle-pipeline Step 3 — SESSION_ROOT carryover from Step 0', () => {
  test('Step 3 branches on whether SESSION_ROOT was set by Step 0', () => {
    assert.match(step3Body, /SESSION_ROOT.*was set by Step 0/);
    assert.match(step3Body, /resume mode/i);
  });

  test('Step 3 resume branch uses --resume with the captured SESSION_ROOT', () => {
    assert.match(step3Body, /setup\.js[^`]*--resume\s+"\$\{SESSION_ROOT\}"/);
  });

  test('Step 3 fresh branch (no refinement) preserves --task argument', () => {
    const freshBranch = step3Body.indexOf('Otherwise (no refinement');
    assert.ok(freshBranch > 0, 'fresh-branch label missing');
    const freshBody = step3Body.slice(freshBranch);
    assert.match(freshBody, /--task\s+"<TASK>"/);
    assert.doesNotMatch(freshBody.split('Append')[0], /--resume/);
  });
});

describe('pickle-pipeline flag table — Step 2', () => {
  test('--refine and --no-refine flags are documented as already consumed in Step 0', () => {
    assert.match(skill, /--refine[^\n]*Step 0/);
    assert.match(skill, /--no-refine[^\n]*Step 0/);
  });
});
