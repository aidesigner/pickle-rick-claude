// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R-PSAI-7 regression: six cases for launch-time scope auto-inference.
 *
 * Since `/pickle-pipeline` is a skill prompt (not executable code), these
 * tests validate the REGEX PATTERNS embedded in Step 0.6 of the skill and
 * the behavioral contract of lock-scope.js for the session-patch cases.
 * They serve as a living spec for the auto-inference clause.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(__dirname, '../../../.claude/commands/pickle-pipeline.md');
const skill = fs.readFileSync(skillPath, 'utf8');

// Extract Step 0.6 body
const step06Start = skill.indexOf('## Step 0.6: Scope Auto-Inference');
const step1Start = skill.indexOf('## Step 1: Check tmux');
assert.ok(step06Start > 0);
const step06Body = skill.slice(step06Start, step1Start);

// Extract the two regex patterns from Step 0.6 (Signal 1 and Signal 2).
// They appear as inline code blocks: `/…/i`
function extractRegexes(body) {
  const matches = [...body.matchAll(/`(\/((?:[^`/\\]|\\.)+)\/[gimusy]*)`/g)];
  return matches.map(m => {
    try {
      // Strip flags from the source, build RegExp
      const full = m[1];
      const lastSlash = full.lastIndexOf('/');
      const source = full.slice(1, lastSlash);
      const flags = full.slice(lastSlash + 1);
      return new RegExp(source, flags || 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const regexes = extractRegexes(step06Body);
assert.ok(regexes.length >= 2, `Expected ≥2 regexes in Step 0.6, found ${regexes.length}`);

const branchRegex = regexes[0];
const apiOnlyRegex = regexes[1];

describe('R-PSAI-7 scope auto-inference regression (6 cases)', () => {

  // Case 1: Branch-named kickoff — TASK contains a branch path
  test('Case 1: branch-named kickoff triggers SCOPE_SIGNAL=branch', () => {
    const tasks = [
      'build feature/payment-api endpoint',
      'implement fix/rate-limit-bug',
      'on branch feature/new-auth-flow',
      'branch: hotfix/prod-crash',
      'working on release/v2.0',
    ];
    for (const task of tasks) {
      const matched = branchRegex.test(task);
      assert.ok(matched, `Branch regex did not match: "${task}"`);
    }
  });

  // Case 2: "API-only" kickoff triggers api_only signal
  test('Case 2: API-only phrasing triggers SCOPE_SIGNAL=api_only', () => {
    const tasks = [
      'API-only changes to the auth service',
      'backend only refactor',
      'no cross-repo dependencies',
      'api scope: update rate limiter',
      'api only update for user endpoint',
    ];
    for (const task of tasks) {
      const matched = apiOnlyRegex.test(task);
      assert.ok(matched, `API-only regex did not match: "${task}"`);
    }
  });

  // Case 3: --scope already passed → Step 0.6 is skipped (no prompt)
  test('Case 3: --scope already passed → skill documents Step 0.6 skips', () => {
    // The skill text must say Step 0.6 only runs when --scope was NOT passed.
    assert.match(
      step06Body,
      /--scope.*NOT.*passed|NOT.*--scope.*passed|Only runs when `--scope` was NOT/i,
      'Step 0.6 must document that it skips when --scope is already present',
    );
  });

  // Case 4: no-signal default-branch kickoff → no prompt
  test('Case 4: no-signal kickoff does NOT trigger scope prompt', () => {
    const plainTasks = [
      'refactor the login form',
      'add unit tests for the validator',
      'fix typo in README',
    ];
    // None of these should match either branch or api_only regex.
    for (const task of plainTasks) {
      const matchesBranch = branchRegex.test(task);
      const matchesApi = apiOnlyRegex.test(task);
      assert.ok(
        !matchesBranch && !matchesApi,
        `Plain task "${task}" should NOT match scope signals (branch=${matchesBranch} api=${matchesApi})`,
      );
    }
  });

  // Case 5: non-default-branch + ≥1 ahead + no-scope → safety prompt fires
  test('Case 5: non-default-branch safety prompt is documented in Step 0.6', () => {
    assert.match(
      step06Body,
      /non[\s_-]?default[\s_-]?branch|SCOPE_SIGNAL=non_default_branch/i,
    );
    assert.match(step06Body, /Lock to branch.*Recommended|Recommended.*Lock to branch/i);
    assert.match(step06Body, /commit.*ahead|ahead.*commit/i);
  });

  // Case 6: operator picks "unscoped" → audit log line present
  test('Case 6: unscoped operator choice is logged (skill docs audit log line)', () => {
    // The skill must document that choosing "unscoped" produces an activity log entry.
    assert.match(
      step06Body,
      /log.*scope-inference.*operator.*unscoped|activity|audit/i,
      'Step 0.6 must document logging when operator picks unscoped',
    );
  });
});
