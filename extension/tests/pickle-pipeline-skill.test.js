import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.resolve(__dirname, '../../.claude/commands/pickle-pipeline.md');
const skill = fs.readFileSync(skillPath, 'utf8');

describe('pickle-pipeline skill prompt', () => {
  test('first-line description fits in 80 chars and names all three runtime phases', () => {
    const firstLine = skill.split('\n')[0];
    assert.ok(firstLine.length <= 80, `first line is ${firstLine.length} chars: ${firstLine}`);
    assert.match(firstLine, /pickle-tmux/);
    assert.match(firstLine, /anatomy-park/);
    assert.match(firstLine, /szechuan-sauce/);
  });

  test('Step 0 Refinement Prerequisite is present and runs before Step 1', () => {
    const step0 = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1 = skill.indexOf('## Step 1: Check tmux');
    assert.ok(step0 > 0, 'Step 0 header missing');
    assert.ok(step1 > step0, 'Step 1 must come after Step 0');
  });

  test('Step 0 references prd_refined.md as the skip gate', () => {
    const step0Idx = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1Idx = skill.indexOf('## Step 1: Check tmux');
    const step0Body = skill.slice(step0Idx, step1Idx);
    assert.match(step0Body, /prd_refined\.md/);
  });

  test('Step 0 invokes /pickle-refine-prd inline', () => {
    const step0Idx = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1Idx = skill.indexOf('## Step 1: Check tmux');
    const step0Body = skill.slice(step0Idx, step1Idx);
    assert.match(step0Body, /\/pickle-refine-prd/);
  });

  test('--refine and --no-refine flags are documented', () => {
    assert.match(skill, /--refine/);
    assert.match(skill, /--no-refine/);
  });

  test('Step 0 fail-fast behavior on missing prd.md is documented', () => {
    const step0Idx = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1Idx = skill.indexOf('## Step 1: Check tmux');
    const step0Body = skill.slice(step0Idx, step1Idx);
    assert.match(step0Body, /fail fast/i);
    assert.match(step0Body, /No prd\.md found/);
  });

  test('Step 0 auto-infer regex covers refine, refinement, refine-prd, prd-refinement', () => {
    const step0Idx = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1Idx = skill.indexOf('## Step 1: Check tmux');
    const step0Body = skill.slice(step0Idx, step1Idx);
    const regexLineMatch = step0Body.match(/\/[^/\n]*refine[^/\n]*\/i/);
    assert.ok(regexLineMatch, 'expected an /…refine…/i regex literal in Step 0');
    const re = new RegExp(regexLineMatch[0].slice(1, -2), 'i');
    assert.ok(re.test('refine'), 'matches "refine"');
    assert.ok(re.test('refinement'), 'matches "refinement"');
    assert.ok(re.test('refine-prd'), 'matches "refine-prd"');
    assert.ok(re.test('refine prd'), 'matches "refine prd"');
    assert.ok(re.test('prd refinement'), 'matches "prd refinement"');
  });

  test('refinement is pinned to claude backend (matches /pickle-refine-prd rule)', () => {
    const step0Idx = skill.indexOf('## Step 0: Refinement Prerequisite');
    const step1Idx = skill.indexOf('## Step 1: Check tmux');
    const step0Body = skill.slice(step0Idx, step1Idx);
    assert.match(step0Body, /claude/);
    assert.match(step0Body, /backend/);
  });
});
