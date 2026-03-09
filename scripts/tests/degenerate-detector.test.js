import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDegenerate, extractTail, NO_OP_PATTERNS } from '../bin/services/degenerate-detector.js';

// ---------------------------------------------------------------------------
// NO_OP_PATTERNS
// ---------------------------------------------------------------------------

describe('NO_OP_PATTERNS', () => {
  it('exports exactly 10 patterns', () => {
    assert.equal(NO_OP_PATTERNS.length, 10);
  });
});

// ---------------------------------------------------------------------------
// isDegenerate — all 10 no-op patterns
// ---------------------------------------------------------------------------

describe('isDegenerate — no-op patterns', () => {
  const patterns = [
    'acknowledged', 'ok', 'done', 'understood', 'noted',
    'continuing', 'ready', 'got it', 'will do', 'roger',
  ];

  for (const pattern of patterns) {
    it(`"${pattern}" is degenerate (no_op_phrase)`, () => {
      const result = isDegenerate(pattern);
      assert.equal(result.degenerate, true);
    });
  }
});

// ---------------------------------------------------------------------------
// isDegenerate — whitespace detection
// ---------------------------------------------------------------------------

describe('isDegenerate — whitespace', () => {
  it('empty string is degenerate with reason whitespace_only', () => {
    const result = isDegenerate('');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'whitespace_only');
  });

  it('spaces/tabs/newlines are degenerate with reason whitespace_only', () => {
    const result = isDegenerate('   \n\t  ');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'whitespace_only');
  });
});

// ---------------------------------------------------------------------------
// isDegenerate — ultra-short detection
// ---------------------------------------------------------------------------

describe('isDegenerate — ultra-short', () => {
  it('≤10 char output is degenerate with reason ultra_short', () => {
    const result = isDegenerate('yes');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'ultra_short');
  });

  it('exactly 10 chars is degenerate', () => {
    const result = isDegenerate('1234567890');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'ultra_short');
  });

  it('11 non-pattern chars is not degenerate', () => {
    const result = isDegenerate('hello world');
    assert.equal(result.degenerate, false);
  });
});

// ---------------------------------------------------------------------------
// isDegenerate — normal output
// ---------------------------------------------------------------------------

describe('isDegenerate — normal output', () => {
  it('substantive output is not degenerate', () => {
    const result = isDegenerate('I have completed the implementation of the auth module');
    assert.equal(result.degenerate, false);
  });

  it('long non-pattern output is not degenerate', () => {
    const result = isDegenerate('x'.repeat(101));
    assert.equal(result.degenerate, false);
  });
});

// ---------------------------------------------------------------------------
// isDegenerate — case insensitivity
// ---------------------------------------------------------------------------

describe('isDegenerate — case insensitivity', () => {
  it('"OK" (uppercase) is degenerate', () => {
    assert.equal(isDegenerate('OK').degenerate, true);
  });

  it('"Ok" (mixed case) is degenerate', () => {
    assert.equal(isDegenerate('Ok').degenerate, true);
  });

  it('"ok" (lowercase) is degenerate', () => {
    assert.equal(isDegenerate('ok').degenerate, true);
  });

  it('"ACKNOWLEDGED" is degenerate', () => {
    const result = isDegenerate('ACKNOWLEDGED');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'no_op_phrase');
  });
});

// ---------------------------------------------------------------------------
// isDegenerate — trailing period
// ---------------------------------------------------------------------------

describe('isDegenerate — trailing period', () => {
  it('"ok." matches as no_op_phrase', () => {
    const result = isDegenerate('ok.');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'no_op_phrase');
  });

  it('"ok" matches as no_op_phrase', () => {
    const result = isDegenerate('ok');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'no_op_phrase');
  });

  it('"Acknowledged." matches as no_op_phrase', () => {
    const result = isDegenerate('Acknowledged.');
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'no_op_phrase');
  });
});

// ---------------------------------------------------------------------------
// extractTail
// ---------------------------------------------------------------------------

describe('extractTail', () => {
  it('returns full output when under line limit', () => {
    const output = 'line1\nline2\nline3';
    assert.equal(extractTail(output, 100), output);
  });

  it('returns last N lines when over limit', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const tail = extractTail(output, 100);
    const tailLines = tail.split('\n');
    assert.equal(tailLines.length, 100);
    assert.equal(tailLines[0], 'line 101');
    assert.equal(tailLines[99], 'line 200');
  });

  it('200-line output with "ok" early but real work late → not degenerate', () => {
    const earlyLines = Array.from({ length: 50 }, () => 'ok');
    const lateLines = Array.from({ length: 150 }, () => 'I implemented the feature successfully with full test coverage');
    const output = [...earlyLines, ...lateLines].join('\n');
    const tail = extractTail(output, 100);
    assert.equal(isDegenerate(tail).degenerate, false);
  });

  it('defaults to 100 lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const tail = extractTail(lines.join('\n'));
    assert.equal(tail.split('\n').length, 100);
  });
});

// ---------------------------------------------------------------------------
// Null/undefined safety
// ---------------------------------------------------------------------------

describe('isDegenerate — null safety', () => {
  it('null input treated as whitespace_only', () => {
    const result = isDegenerate(null);
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'whitespace_only');
  });

  it('undefined input treated as whitespace_only', () => {
    const result = isDegenerate(undefined);
    assert.equal(result.degenerate, true);
    assert.equal(result.reason, 'whitespace_only');
  });
});

describe('extractTail — null safety', () => {
  it('null input returns empty string', () => {
    assert.equal(extractTail(null), '');
  });

  it('undefined input returns empty string', () => {
    assert.equal(extractTail(undefined), '');
  });
});
