// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const COMMAND_FILES = [
  path.join(repoRoot, '.claude/commands/pickle-tmux.md'),
  path.join(repoRoot, '.claude/commands/anatomy-park.md'),
];

const BOUNDARY_BLOCK_START = '<!-- BEGIN GIT_BOUNDARY_RULES -->';
const BOUNDARY_BLOCK_END = '<!-- END GIT_BOUNDARY_RULES -->';

const PROHIBITED_PHRASES = [
  'You are pinned to the current branch',
  '`git checkout <ref>`',
  '`git switch`',
  '`git reset --hard`',
  '`git pull`',
  '`git push`',
  '`git stash`',
  '`git rebase`',
];

const ALLOWED_PHRASES = [
  '`git restore',
  '`git add',
  '`git commit',
];

function readAndSplit(p) {
  const content = fs.readFileSync(p, 'utf8');
  const startIdx = content.indexOf(BOUNDARY_BLOCK_START);
  const endIdx = content.indexOf(BOUNDARY_BLOCK_END);
  assert.notStrictEqual(startIdx, -1, `${path.basename(p)} missing BEGIN_GIT_BOUNDARY_RULES marker`);
  assert.notStrictEqual(endIdx, -1, `${path.basename(p)} missing END_GIT_BOUNDARY_RULES marker`);
  assert.ok(endIdx > startIdx, `${path.basename(p)} END marker before BEGIN marker`);
  const block = content.slice(startIdx, endIdx + BOUNDARY_BLOCK_END.length);
  const outsideBlock = content.slice(0, startIdx) + content.slice(endIdx + BOUNDARY_BLOCK_END.length);
  return { content, block, outsideBlock };
}

for (const file of COMMAND_FILES) {
  const base = path.basename(file);

  test(`git-boundary: ${base} contains the boundary rules block`, () => {
    const { block } = readAndSplit(file);
    for (const phrase of PROHIBITED_PHRASES) {
      assert.ok(
        block.includes(phrase),
        `${base} boundary block missing required phrase: ${phrase}`,
      );
    }
    for (const phrase of ALLOWED_PHRASES) {
      assert.ok(
        block.includes(phrase),
        `${base} boundary block missing required allowed-phrase: ${phrase}`,
      );
    }
  });

  test(`git-boundary: ${base} has no destructive git instructions outside the boundary block`, () => {
    const { outsideBlock } = readAndSplit(file);
    // Allow inline mentions like "never git reset --hard" / "per Git Boundary Rules" that explicitly DENY the command.
    // The pattern below matches the destructive commands ONLY when they appear as bare instructions
    // (not preceded by negation keywords like "never", "NOT", "no", "instead of", "per Git Boundary").
    const destructivePatterns = [
      { name: 'git stash', regex: /\bgit stash\b/g },
      { name: 'git checkout .', regex: /\bgit checkout \./g },
      { name: 'git reset --hard', regex: /\bgit reset --hard\b/g },
      { name: 'git pull (bare)', regex: /\bgit pull\b/g },
      { name: 'git push (bare)', regex: /\bgit push\b/g },
      { name: 'git rebase', regex: /\bgit rebase\b/g },
    ];
    for (const { name, regex } of destructivePatterns) {
      const matches = [...outsideBlock.matchAll(regex)];
      for (const m of matches) {
        const lineStart = outsideBlock.lastIndexOf('\n', m.index) + 1;
        const lineEnd = outsideBlock.indexOf('\n', m.index);
        const line = outsideBlock.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const isNegated = /\b(never|NEVER|NOT|not|no |instead of|per Git Boundary|Boundary Rules|MUST NOT|do NOT)/.test(line);
        assert.ok(
          isNegated,
          `${base} contains bare destructive instruction "${name}" outside boundary block at: ${line}`,
        );
      }
    }
  });

  test(`git-boundary: ${base} has at least one allowed git restore reference`, () => {
    const { content } = readAndSplit(file);
    assert.ok(
      /\bgit restore\b/.test(content),
      `${base} must include at least one git restore reference as the replacement instruction`,
    );
  });
}
