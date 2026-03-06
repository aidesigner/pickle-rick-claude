import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import pickle from '../eslint-plugin-pickle/index.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
});

// ─── no-raw-state-write ─────────────────────────────────────────────────────

describe('pickle/no-raw-state-write', () => {
  it('catches raw fs.writeFileSync on state.json and allows safe patterns', () => {
    ruleTester.run('no-raw-state-write', pickle.rules['no-raw-state-write'], {
      valid: [
        // Non-state file
        { code: `import * as fs from 'fs'; fs.writeFileSync('/tmp/config.json', '{}');` },
        // writeStateFile is fine
        { code: `writeStateFile(statePath, state);` },
        // fs.readFileSync on state is fine
        { code: `import * as fs from 'fs'; fs.readFileSync(statePath, 'utf-8');` },
      ],
      invalid: [
        // Literal state.json path
        {
          code: `import * as fs from 'fs'; fs.writeFileSync('/tmp/state.json', '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // statePath variable
        {
          code: `import * as fs from 'fs'; const statePath = 'x'; fs.writeFileSync(statePath, '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // stateFile variable
        {
          code: `import * as fs from 'fs'; const stateFile = 'x'; fs.writeFileSync(stateFile, '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // Template literal with state.json
        {
          code: 'import * as fs from \'fs\'; fs.writeFileSync(`${dir}/state.json`, \'{}\');',
          errors: [{ messageId: 'useWriteStateFile' }],
        },
      ],
    });
  });
});

// ─── cli-guard-basename ─────────────────────────────────────────────────────

describe('pickle/cli-guard-basename', () => {
  it('requires path.basename for process.argv[1] comparisons', () => {
    ruleTester.run('cli-guard-basename', pickle.rules['cli-guard-basename'], {
      valid: [
        // Correct: path.basename
        { code: `import * as path from 'path'; if (path.basename(process.argv[1]) === 'setup.js') {}` },
        // Non-comparison use is fine
        { code: `const script = process.argv[1];` },
        // process.argv[2] is fine
        { code: `if (process.argv[2] === 'foo') {}` },
      ],
      invalid: [
        // Bare comparison
        {
          code: `if (process.argv[1] === 'setup.js') {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // startsWith
        {
          code: `if (process.argv[1].startsWith('/usr')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // endsWith
        {
          code: `if (process.argv[1].endsWith('.js')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // includes
        {
          code: `if (process.argv[1].includes('setup')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
      ],
    });
  });
});

// ─── hook-decision-values ───────────────────────────────────────────────────

describe('pickle/hook-decision-values', () => {
  it('enforces approve/block in hooks/ files', () => {
    ruleTester.run('hook-decision-values', pickle.rules['hook-decision-values'], {
      valid: [
        // Correct decisions in hooks/
        { code: `const r = { decision: "approve" };`, filename: 'src/hooks/stop.ts' },
        { code: `const r = { decision: "block", reason: "nope" };`, filename: 'src/hooks/stop.ts' },
        // "allow" outside hooks/ is fine
        { code: `const x = "allow";`, filename: 'src/bin/setup.ts' },
        // Non-decision property in hooks/ is fine
        { code: `const r = { status: "allow" };`, filename: 'src/hooks/stop.ts' },
      ],
      invalid: [
        // decision: "allow" in hooks/
        {
          code: `const r = { decision: "allow" };`,
          filename: 'src/hooks/handlers/stop-hook.ts',
          errors: [{ messageId: 'noAllow' }],
        },
        // decision: "permit" in hooks/
        {
          code: `const r = { decision: "permit" };`,
          filename: 'src/hooks/handlers/stop-hook.ts',
          errors: [{ messageId: 'invalidDecision' }],
        },
        // JSON.stringify({ decision: "allow" }) in hooks/
        {
          code: `const x = JSON.stringify({ decision: "allow" });`,
          filename: 'src/hooks/stop.ts',
          errors: [{ messageId: 'noAllow' }],
        },
      ],
    });
  });
});

// ─── no-unsafe-error-cast ───────────────────────────────────────────────────

describe('pickle/no-unsafe-error-cast', () => {
  it('requires instanceof guard for catch binding property access', () => {
    ruleTester.run('no-unsafe-error-cast', pickle.rules['no-unsafe-error-cast'], {
      valid: [
        // Ternary guard
        { code: `try { x(); } catch (err) { const m = err instanceof Error ? err.message : String(err); }` },
        // If guard
        { code: `try { x(); } catch (err) { if (err instanceof Error) { console.log(err.message); } }` },
        // && guard
        { code: `try { x(); } catch (err) { const m = err instanceof Error && err.message; }` },
        // Not a catch binding
        { code: `const err = new Error('x'); console.log(err.message);` },
        // Catch without binding
        { code: `try { x(); } catch { console.log('failed'); }` },
        // Safe property (not in dangerous list)
        { code: `try { x(); } catch (err) { console.log(err.name); }` },
        // String(err) is safe
        { code: `try { x(); } catch (err) { console.log(String(err)); }` },
      ],
      invalid: [
        // Bare .message
        {
          code: `try { x(); } catch (err) { console.log(err.message); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
        // Bare .stack
        {
          code: `try { x(); } catch (err) { console.log(err.stack); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
        // Bare .code
        {
          code: `try { x(); } catch (e) { console.log(e.code); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
      ],
    });
  });
});
