// @tier: fast
//
// Tests for graph-preflight.ts: ensureGraph never-throw contract, timeout
// invariant, activity event conformance, and pinned-version guard.
//
// AC-PGI-1-1: degraded result when binary absent and install stubbed to fail
// AC-PGI-1-2: every spawnSync/spawn call has explicit timeout
// AC-PGI-1-3: graph_preflight_completed event written + validates against schema
// AC-PGI-3-1: install targets pinned version, never @latest
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'src/services/graph-preflight.ts');
const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');

// ── AC-PGI-1-1: ensureGraph returns degraded:true when install fails ─────────

describe('AC-PGI-1-1: ensureGraph degraded when install fails', () => {
  it('never throws and returns degraded:true when binary absent and install stubbed to fail', async () => {
    const { ensureGraph } = await import('../services/graph-preflight.js');

    const result = await ensureGraph('/tmp/fake-repo', {
      detectFn: () => ({ found: false }),
      installFn: () => ({ success: false, reason: 'stub-install-fail' }),
    });

    assert.equal(result.degraded, true, 'result.degraded must be true');
    assert.equal(result.available, false, 'result.available must be false');
    assert.ok(typeof result.reason === 'string', 'result.reason must be a string');
    assert.ok(result.reason.length > 0, 'result.reason must be non-empty');
  });

  it('never throws when detect throws unexpectedly', async () => {
    const { ensureGraph } = await import('../services/graph-preflight.js');

    const result = await ensureGraph('/tmp/fake-repo', {
      detectFn: () => { throw new Error('unexpected-detect-error'); },
    });

    assert.equal(result.degraded, true, 'must degrade on unexpected detect error');
    assert.equal(result.available, false);
  });

  it('never throws when analyze throws unexpectedly', async () => {
    const { ensureGraph } = await import('../services/graph-preflight.js');

    const result = await ensureGraph('/tmp/fake-repo', {
      detectFn: () => ({ found: true }),
      analyzeFn: () => { throw new Error('unexpected-analyze-error'); },
    });

    assert.equal(result.degraded, true, 'must degrade on unexpected analyze error');
    assert.equal(result.available, false);
  });

  it('returns available:true when all stubs succeed', async () => {
    const { ensureGraph } = await import('../services/graph-preflight.js');

    const result = await ensureGraph('/tmp/fake-repo', {
      detectFn: () => ({ found: true }),
      analyzeFn: () => ({ success: true, indexPath: '/tmp/fake-repo/.gitnexus', symbolCount: 42 }),
    });

    assert.equal(result.available, true);
    assert.equal(result.degraded, false);
    assert.equal(result.symbolCount, 42);
    assert.equal(result.indexPath, '/tmp/fake-repo/.gitnexus');
  });
});

// ── AC-PGI-1-2: every spawnSync/spawn call has explicit timeout ──────────────

describe('AC-PGI-1-2: every spawnSync/spawn call has explicit timeout', () => {
  it('all spawnSync calls in graph-preflight.ts include a timeout option', () => {
    const src = fs.readFileSync(SOURCE_PATH, 'utf8');

    // Find all occurrences of spawnSync( or spawn(
    // Each call's opts object must contain a timeout key before the closing }
    // Strategy: extract each spawnSync call site and verify timeout is present

    // Split on spawnSync( to get all invocation sites
    const spawnSyncParts = src.split('spawnSync(');
    // First element is preamble before first call; the rest are call bodies
    for (let i = 1; i < spawnSyncParts.length; i++) {
      const callBody = spawnSyncParts[i];
      // Find the matching closing paren by tracking brace depth
      let depth = 1;
      let end = 0;
      for (; end < callBody.length && depth > 0; end++) {
        if (callBody[end] === '(') depth++;
        else if (callBody[end] === ')') depth--;
      }
      const args = callBody.slice(0, end);
      assert.ok(
        /timeout\s*:/.test(args) || /timeout\s*}/.test(args),
        `spawnSync call #${i} must have explicit timeout option. Found: ${args.slice(0, 200)}`,
      );
    }

    // Also check no bare spawn( (non-spawnSync) exists without timeout
    const spawnParts = src.split(/(?<![a-zA-Z])spawn\(/);
    // Skip the preamble (index 0)
    for (let i = 1; i < spawnParts.length; i++) {
      const callBody = spawnParts[i];
      // Find the matching closing paren
      let depth = 1;
      let end = 0;
      for (; end < callBody.length && depth > 0; end++) {
        if (callBody[end] === '(') depth++;
        else if (callBody[end] === ')') depth--;
      }
      const args = callBody.slice(0, end);
      assert.ok(
        /timeout\s*:/.test(args),
        `spawn( call #${i} must have explicit timeout option. Found: ${args.slice(0, 200)}`,
      );
    }
  });

  it('DETECT_TIMEOUT_MS, INSTALL_TIMEOUT_MS, ANALYZE_TIMEOUT_MS constants are defined', () => {
    const src = fs.readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(/DETECT_TIMEOUT_MS\s*=/.test(src), 'DETECT_TIMEOUT_MS constant must be defined');
    assert.ok(/INSTALL_TIMEOUT_MS\s*=/.test(src), 'INSTALL_TIMEOUT_MS constant must be defined');
    assert.ok(/ANALYZE_TIMEOUT_MS\s*=/.test(src), 'ANALYZE_TIMEOUT_MS constant must be defined');
  });
});

// ── AC-PGI-1-3: graph_preflight_completed validates against schema ───────────

describe('AC-PGI-1-3: graph_preflight_completed event schema conformance', () => {
  it('schema defines graph_preflight_completed', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.graph_preflight_completed;
    assert.ok(def, 'activity-events.schema.json must define graph_preflight_completed');
    assert.equal(def.type, 'object');
    assert.ok(def.required.includes('event'), 'required must include event');
    assert.ok(def.required.includes('ts'), 'required must include ts');
    assert.equal(def.properties.event.const, 'graph_preflight_completed');
  });

  it('schema oneOf includes graph_preflight_completed', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/graph_preflight_completed'),
      'oneOf must reference graph_preflight_completed',
    );
  });

  it('schema defines graph_preflight_degraded', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.graph_preflight_degraded;
    assert.ok(def, 'activity-events.schema.json must define graph_preflight_degraded');
    assert.equal(def.type, 'object');
    assert.ok(def.required.includes('event'), 'required must include event');
    assert.ok(def.required.includes('ts'), 'required must include ts');
    assert.equal(def.properties.event.const, 'graph_preflight_degraded');
  });

  it('schema oneOf includes graph_preflight_degraded', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/graph_preflight_degraded'),
      'oneOf must reference graph_preflight_degraded',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers graph_preflight_completed', () => {
    const types = fs.readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]graph_preflight_completed['"]/.test(types),
      'index.ts VALID_ACTIVITY_EVENTS must include graph_preflight_completed',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers graph_preflight_degraded', () => {
    const types = fs.readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]graph_preflight_degraded['"]/.test(types),
      'index.ts VALID_ACTIVITY_EVENTS must include graph_preflight_degraded',
    );
  });

  it('graph_preflight_completed event is written to activity log on success', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-test-'));
    const origEnv = process.env.EXTENSION_DIR;
    try {
      process.env.EXTENSION_DIR = tmpRoot;

      const { ensureGraph } = await import('../services/graph-preflight.js');
      await ensureGraph('/tmp/fake-repo', {
        detectFn: () => ({ found: true }),
        analyzeFn: () => ({ success: true, indexPath: '/tmp/fake-repo/.gitnexus', symbolCount: 99 }),
      });

      const activityDir = path.join(tmpRoot, 'activity');
      // activity-logger writes filenames using a LOCAL-day key (not UTC); mirror
      // that here so the assertion does not fail in the evening US / UTC-next-day window.
      const now = new Date();
      const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const jsonlPath = path.join(activityDir, `${dateKey}.jsonl`);

      assert.ok(fs.existsSync(activityDir), 'activity dir must be created');
      assert.ok(fs.existsSync(jsonlPath), `activity JSONL must exist at ${jsonlPath}`);

      const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
      const completedEvent = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((e) => e && e.event === 'graph_preflight_completed');

      assert.ok(completedEvent, 'graph_preflight_completed event must be in activity log');
      assert.ok(typeof completedEvent.ts === 'string', 'event must have ts');
      assert.ok(completedEvent.gate_payload, 'event must have gate_payload');
      assert.equal(completedEvent.gate_payload.available, true);
      assert.equal(completedEvent.gate_payload.degraded, false);

      // Validate against schema definition
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const def = schema.definitions.graph_preflight_completed;
      for (const field of def.required) {
        assert.ok(field in completedEvent, `event must include required field: ${field}`);
      }
    } finally {
      process.env.EXTENSION_DIR = origEnv;
      if (origEnv === undefined) delete process.env.EXTENSION_DIR;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ── AC-PGI-3-1: install targets pinned version, never @latest ───────────────

describe('AC-PGI-3-1: install command targets pinned version', () => {
  it('PINNED_GITNEXUS_VERSION is a specific version, not "@latest"', async () => {
    const { PINNED_GITNEXUS_VERSION } = await import('../services/graph-preflight.js');

    assert.ok(typeof PINNED_GITNEXUS_VERSION === 'string', 'PINNED_GITNEXUS_VERSION must be a string');
    assert.ok(PINNED_GITNEXUS_VERSION.length > 0, 'PINNED_GITNEXUS_VERSION must be non-empty');
    assert.notEqual(PINNED_GITNEXUS_VERSION, '@latest', 'version must not be @latest');
    assert.notEqual(PINNED_GITNEXUS_VERSION, 'latest', 'version must not be "latest"');
    // Must look like a semver or semver prefix (e.g. "1.6.5" or "1.6")
    assert.ok(/^\d+\.\d+/.test(PINNED_GITNEXUS_VERSION), 'version must start with semver pattern');
  });

  it('install stub receives the pinned version, not @latest', async () => {
    const { ensureGraph, PINNED_GITNEXUS_VERSION } = await import('../services/graph-preflight.js');

    let capturedVersion = null;
    await ensureGraph('/tmp/fake-repo', {
      detectFn: () => ({ found: false }),
      installFn: (version) => {
        capturedVersion = version;
        return { success: false, reason: 'stub-stopped' };
      },
    });

    assert.ok(capturedVersion !== null, 'installFn must have been called');
    assert.equal(capturedVersion, PINNED_GITNEXUS_VERSION, 'install must use PINNED_GITNEXUS_VERSION');
    assert.notEqual(capturedVersion, '@latest');
    assert.notEqual(capturedVersion, 'latest');
  });

  it('source code does not reference @latest for gitnexus install', () => {
    const src = fs.readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(
      !src.includes('gitnexus@latest') && !src.includes(`gitnexus@'latest'`) && !src.includes(`gitnexus@"latest"`),
      'source must not reference gitnexus@latest',
    );
    // The install line must use the PINNED_GITNEXUS_VERSION constant
    assert.ok(
      /gitnexus@\$\{version\}/.test(src) || /gitnexus@\$\{PINNED/.test(src),
      'install command must use a version variable, not a hardcoded @latest',
    );
  });

  it('R-PDD-oneOf invariant: no definition missing from oneOf', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = new Set(schema.oneOf.map((o) => o.$ref.replace('#/definitions/', '')));
    const SHARED = new Set(['backendEnum', 'backendResolutionSourceEnum', 'workerBackendResolutionSourceEnum']);
    const missing = Object.keys(schema.definitions).filter((k) => !SHARED.has(k) && !refs.has(k));
    assert.deepEqual(missing, [], `definitions missing from oneOf: ${missing.join(', ')}`);
  });
});
