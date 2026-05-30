// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiffVisualDominance,
  VISUAL_DOMINANCE_THRESHOLD,
} from '../services/pickle-utils.js';

// --- AC-PIAP-B1-1: true for a >60% visual diff ---

test('AC-PIAP-B1-1: UI-primary diff (>60% visual lines) returns true', () => {
  // .scss whole-file: 6/6 visual. Button.tsx: 2/4 visual (JSX tags). util.ts: 0/1.
  // total visual = 8, total changed = 11, share ≈ 0.727 > 0.60.
  const diff = [
    {
      path: 'src/styles/button.scss',
      changedLines: [
        '.btn {',
        '  color: white;',
        '  background: rebeccapurple;',
        '  padding: 8px 16px;',
        '  border-radius: 4px;',
        '}',
      ],
    },
    {
      path: 'src/components/Button.tsx',
      changedLines: [
        '<button className="btn" onClick={onClick}>',
        '  Save',
        '</button>',
        'const onClick = () => doStuff();',
      ],
    },
    {
      path: 'src/lib/util.ts',
      changedLines: ['const sum = a + b;'],
    },
  ];
  assert.equal(classifyDiffVisualDominance(diff), true);
});

test('AC-PIAP-B1-1: styled-component template block counts as visual', () => {
  // styled opener + 3 template body lines = 4/5 visual ≈ 0.8 > 0.60.
  const diff = [
    {
      path: 'src/theme/Btn.ts',
      changedLines: [
        'const Btn = styled.button`',
        '  color: red;',
        '  padding: 8px;',
        '`;',
        'const handler = () => 1;',
      ],
    },
  ];
  assert.equal(classifyDiffVisualDominance(diff), true);
});

// --- AC-PIAP-B1-1: false for a logic-dominated diff ---

test('AC-PIAP-B1-1: logic-dominated diff returns false', () => {
  // calc.ts: 9 non-visual lines. Tag.tsx: 1 visual line. share = 1/10 = 0.1.
  const diff = [
    {
      path: 'src/lib/calc.ts',
      changedLines: [
        'const a = 1;',
        'const b = 2;',
        'let total = 0;',
        'total = a + b;',
        'function compute(n) {',
        '  return n * 2;',
        '}',
        'const result = compute(total);',
        'return result;',
      ],
    },
    {
      path: 'src/components/Tag.tsx',
      changedLines: ['<span className="t" />'],
    },
  ];
  assert.equal(classifyDiffVisualDominance(diff), false);
});

// --- AC-PIAP-B1-1: threshold boundary (strict >) ---

test('AC-PIAP-B1-1: exactly 0.60 visual share returns false (strict exceed)', () => {
  // 6 visual / 10 changed = 0.60 exactly → not strictly greater → false.
  const diff = [
    {
      path: 'src/styles/a.css',
      changedLines: ['.a{', 'x:1;', 'y:2;', 'z:3;', 'w:4;', '}'], // 6 visual
    },
    {
      path: 'src/lib/logic.ts',
      changedLines: ['const p = 1;', 'const q = 2;', 'return p;', 'return q;'], // 0 visual
    },
  ];
  assert.equal(classifyDiffVisualDominance(diff), false);
});

test('AC-PIAP-B1-1: just above 0.60 visual share returns true', () => {
  // 7 visual / 10 changed = 0.70 > 0.60 → true.
  const diff = [
    {
      path: 'src/styles/a.css',
      changedLines: ['.a{', 'x:1;', 'y:2;', 'z:3;', 'w:4;', 'v:5;', '}'], // 7 visual
    },
    {
      path: 'src/lib/logic.ts',
      changedLines: ['const p = 1;', 'const q = 2;', 'return p;'], // 0 visual
    },
  ];
  assert.equal(classifyDiffVisualDominance(diff), true);
});

test('AC-PIAP-B1-1: custom threshold parameter is honored', () => {
  // 0.60 share: false at default/0.60, true at 0.50.
  const diff = [
    { path: 'src/styles/a.scss', changedLines: ['a{', 'b:1;', 'c:2;', 'd:3;', 'e:4;', '}'] },
    { path: 'src/lib/l.ts', changedLines: ['const p=1;', 'const q=2;', 'return p;', 'return q;'] },
  ];
  assert.equal(classifyDiffVisualDominance(diff, 0.6), false);
  assert.equal(classifyDiffVisualDominance(diff, 0.5), true);
});

// --- Purity / edge cases ---

test('empty diff returns false (no visual dominance over zero changed lines)', () => {
  assert.equal(classifyDiffVisualDominance([]), false);
  assert.equal(classifyDiffVisualDominance([{ path: 'a.tsx', changedLines: [] }]), false);
});

test('non-source, non-stylesheet files contribute zero visual lines', () => {
  const diff = [
    { path: 'README.md', changedLines: ['# Title', 'some prose', 'more prose'] },
    { path: 'src/styles/x.less', changedLines: ['.x{c:1;}'] }, // 1 visual / 4 changed
  ];
  assert.equal(classifyDiffVisualDominance(diff), false);
});

test('deterministic: same input yields same output across calls', () => {
  const diff = [
    { path: 'src/a.scss', changedLines: ['a{', 'b:1;', '}'] },
    { path: 'src/b.ts', changedLines: ['const x = 1;', 'return x;'] },
  ];
  const r1 = classifyDiffVisualDominance(diff);
  const r2 = classifyDiffVisualDominance(diff);
  assert.equal(r1, r2);
});

test('VISUAL_DOMINANCE_THRESHOLD default is 0.60', () => {
  assert.equal(VISUAL_DOMINANCE_THRESHOLD, 0.6);
});
