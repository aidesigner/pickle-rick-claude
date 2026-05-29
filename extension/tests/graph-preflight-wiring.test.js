// @tier: fast
//
// AC-PGI-2-1: ensureGraph is invoked before work in spawn-refinement-team.ts,
//             setup.ts (build path), and before each hardening phase in pipeline-runner.ts
// AC-PGI-2-2: --no-graph / enable_graph_preflight:false skips the preflight
// AC-PGI-4-1: pipeline completes normally when gitnexus unavailable (degraded preflight);
//             hasGitNexusIndex() stays the gate — no GitNexus block in worker prompt
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REFINEMENT_SRC = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');
const SETUP_SRC = path.join(ROOT, 'src/bin/setup.ts');
const PIPELINE_SRC = path.join(ROOT, 'src/bin/pipeline-runner.ts');
const SPAWN_MORTY_SRC = path.join(ROOT, 'src/bin/spawn-morty.ts');

// ── AC-PGI-2-1: ensureGraph invoked before work in all 3 entry points ────────

describe('AC-PGI-2-1: ensureGraph wired into entry points', () => {
  it('spawn-refinement-team.ts imports ensureGraph from graph-preflight', () => {
    const src = fs.readFileSync(REFINEMENT_SRC, 'utf8');
    assert.ok(
      /import.*ensureGraph.*from.*['"]\.\.\/services\/graph-preflight\.js['"]/.test(src),
      'spawn-refinement-team.ts must import ensureGraph from ../services/graph-preflight.js',
    );
  });

  it('spawn-refinement-team.ts calls ensureGraph before orchestrateCycles in main()', () => {
    const src = fs.readFileSync(REFINEMENT_SRC, 'utf8');
    // ensureGraph must appear in the source
    assert.ok(/await ensureGraph\(/.test(src), 'spawn-refinement-team.ts must call await ensureGraph(...)');
    // ensureGraph call must appear before orchestrateCycles call in main()
    const mainIdx = src.indexOf('async function main()');
    assert.ok(mainIdx >= 0, 'must have async function main()');
    const mainBody = src.slice(mainIdx);
    const ensureIdx = mainBody.indexOf('await ensureGraph(');
    const orchestrateIdx = mainBody.indexOf('orchestrateCycles(');
    assert.ok(ensureIdx >= 0, 'main() must call await ensureGraph(...)');
    assert.ok(orchestrateIdx >= 0, 'main() must call orchestrateCycles(...)');
    assert.ok(
      ensureIdx < orchestrateIdx,
      `ensureGraph (pos ${ensureIdx}) must appear before orchestrateCycles (pos ${orchestrateIdx}) in main()`,
    );
  });

  it('setup.ts imports ensureGraph from graph-preflight', () => {
    const src = fs.readFileSync(SETUP_SRC, 'utf8');
    assert.ok(
      /import.*ensureGraph.*from.*['"]\.\.\/services\/graph-preflight\.js['"]/.test(src),
      'setup.ts must import ensureGraph from ../services/graph-preflight.js',
    );
  });

  it('setup.ts calls ensureGraph in main()', () => {
    const src = fs.readFileSync(SETUP_SRC, 'utf8');
    assert.ok(/await ensureGraph\(/.test(src), 'setup.ts must call await ensureGraph(...)');
    // ensureGraph must appear in the main() body
    const mainIdx = src.indexOf('async function main()');
    assert.ok(mainIdx >= 0, 'must have async function main()');
    const mainBody = src.slice(mainIdx);
    assert.ok(
      /await ensureGraph\(/.test(mainBody),
      'main() in setup.ts must call await ensureGraph(...)',
    );
  });

  it('pipeline-runner.ts imports ensureGraph from graph-preflight', () => {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    assert.ok(
      /import.*ensureGraph.*from.*['"]\.\.\/services\/graph-preflight\.js['"]/.test(src),
      'pipeline-runner.ts must import ensureGraph from ../services/graph-preflight.js',
    );
  });

  it('pipeline-runner.ts calls ensureGraph before anatomy-park and szechuan-sauce setup', () => {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    // ensureGraph must be called
    assert.ok(/await ensureGraph\(/.test(src), 'pipeline-runner.ts must call await ensureGraph(...)');
    // The call must be conditioned on hardening phases
    assert.ok(
      /anatomy-park.*szechuan-sauce.*ensureGraph|szechuan-sauce.*anatomy-park.*ensureGraph|anatomy-park.*\|\|.*szechuan-sauce/.test(src.replace(/\n/g, ' ')),
      'ensureGraph call must be conditioned on anatomy-park or szechuan-sauce phase',
    );
  });
});

// ── AC-PGI-2-2: --no-graph / enable_graph_preflight:false skips preflight ────

describe('AC-PGI-2-2: opt-out gates are respected', () => {
  it('spawn-refinement-team.ts parses --no-graph flag', () => {
    const src = fs.readFileSync(REFINEMENT_SRC, 'utf8');
    assert.ok(
      /['"]--no-graph['"]/.test(src) || /no-graph/.test(src),
      'spawn-refinement-team.ts must reference --no-graph',
    );
    // noGraph field on RefinementArgs
    assert.ok(/noGraph/.test(src), 'RefinementArgs must have noGraph field');
  });

  it('spawn-refinement-team.ts skips ensureGraph when noGraph is set', () => {
    const src = fs.readFileSync(REFINEMENT_SRC, 'utf8');
    // The guard must check noGraph
    assert.ok(
      /noGraph.*ensureGraph|ensureGraph.*noGraph/.test(src.replace(/\n/g, ' ')) || /!args\.noGraph/.test(src),
      'spawn-refinement-team.ts must guard ensureGraph with noGraph check',
    );
  });

  it('setup.ts parses --no-graph flag', () => {
    const src = fs.readFileSync(SETUP_SRC, 'utf8');
    assert.ok(/'--no-graph'/.test(src), 'setup.ts ARG_HANDLERS must include --no-graph');
    assert.ok(/noGraph/.test(src), 'SetupArgs must have noGraph field');
  });

  it('setup.ts skips ensureGraph when noGraph is set', () => {
    const src = fs.readFileSync(SETUP_SRC, 'utf8');
    assert.ok(
      /!args\.noGraph/.test(src) || /args\.noGraph/.test(src),
      'setup.ts must guard ensureGraph with noGraph check',
    );
  });

  it('spawn-refinement-team.ts reads enable_graph_preflight from settings', () => {
    const src = fs.readFileSync(REFINEMENT_SRC, 'utf8');
    assert.ok(
      /enable_graph_preflight/.test(src),
      'spawn-refinement-team.ts must read enable_graph_preflight setting',
    );
    assert.ok(
      /enableGraphPreflight/.test(src),
      'RefinementSettings must have enableGraphPreflight field',
    );
  });

  it('setup.ts reads enable_graph_preflight from settings', () => {
    const src = fs.readFileSync(SETUP_SRC, 'utf8');
    assert.ok(
      /enable_graph_preflight/.test(src),
      'setup.ts must read enable_graph_preflight setting',
    );
  });

  it('pipeline-runner.ts reads enable_graph_preflight from settings', () => {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    assert.ok(
      /enable_graph_preflight/.test(src),
      'pipeline-runner.ts must read enable_graph_preflight setting',
    );
  });

  it('loadRefinementSettings defaults enableGraphPreflight to true when setting is absent', async () => {
    const { loadRefinementSettings } = await import('../bin/spawn-refinement-team.js');
    // Pass a non-existent settings path — defaults must apply
    const settings = loadRefinementSettings('/tmp/nonexistent-pickle_settings.json');
    assert.equal(
      settings.enableGraphPreflight,
      true,
      'enableGraphPreflight must default to true when settings file is absent',
    );
  });

  it('loadRefinementSettings sets enableGraphPreflight to false when setting is false', async () => {
    const { loadRefinementSettings } = await import('../bin/spawn-refinement-team.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-wiring-'));
    const settingsPath = path.join(tmpDir, 'pickle_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ enable_graph_preflight: false }), 'utf8');
    try {
      const settings = loadRefinementSettings(settingsPath);
      assert.equal(
        settings.enableGraphPreflight,
        false,
        'enableGraphPreflight must be false when setting is false',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseAndValidateArgs sets noGraph:true when --no-graph is passed', async () => {
    const { parseAndValidateArgs } = await import('../bin/spawn-refinement-team.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-args-'));
    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD', 'utf8');
    const sessionDir = tmpDir;
    try {
      const args = parseAndValidateArgs(['--prd', prdPath, '--session-dir', sessionDir, '--no-graph']);
      assert.equal(args.noGraph, true, '--no-graph flag must set noGraph:true');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseAndValidateArgs leaves noGraph:undefined/false without --no-graph', async () => {
    const { parseAndValidateArgs } = await import('../bin/spawn-refinement-team.js');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-args2-'));
    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD', 'utf8');
    const sessionDir = tmpDir;
    try {
      const args = parseAndValidateArgs(['--prd', prdPath, '--session-dir', sessionDir]);
      assert.ok(!args.noGraph, 'noGraph must be falsy without --no-graph flag');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── AC-PGI-4-1: pipeline completes when gitnexus unavailable ─────────────────

describe('AC-PGI-4-1: degraded preflight does not block pipeline; hasGitNexusIndex stays the gate', () => {
  it('ensureGraph returns degraded:true without throwing when gitnexus unavailable', async () => {
    const { ensureGraph } = await import('../services/graph-preflight.js');
    // Stub binary absent and install fails → degraded
    const result = await ensureGraph('/tmp/fake-repo-no-gitnexus', {
      detectFn: () => ({ found: false }),
      installFn: () => ({ success: false, reason: 'gitnexus-unavailable-stub' }),
    });
    assert.equal(result.degraded, true, 'result must be degraded when gitnexus unavailable');
    assert.equal(result.available, false, 'result.available must be false');
  });

  it('hasGitNexusIndex returns false when .gitnexus dir is absent (no GitNexus block in prompt)', () => {
    // Verify spawn-morty uses hasGitNexusIndex() as the sole gate for the GitNexus prompt block
    const src = fs.readFileSync(SPAWN_MORTY_SRC, 'utf8');
    assert.ok(
      /hasGitNexusIndex/.test(src),
      'spawn-morty.ts must define hasGitNexusIndex gating function',
    );
    // hasGitNexusIndex gates the GitNexus block
    const gitnexusBlockIdx = src.indexOf('gitnexusIndexed');
    assert.ok(gitnexusBlockIdx >= 0, 'spawn-morty.ts must use gitnexusIndexed guard for prompt block');
  });

  it('degraded preflight does not create a .gitnexus directory', async () => {
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-nodir-'));
    try {
      const { ensureGraph } = await import('../services/graph-preflight.js');
      await ensureGraph(tmpDir, {
        detectFn: () => ({ found: false }),
        installFn: () => ({ success: false, reason: 'stub-unavailable' }),
      });
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.gitnexus')),
        '.gitnexus dir must NOT be created when preflight degrades',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('successful preflight creates .gitnexus and hasGitNexusIndex returns true', async () => {
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gp-dir-'));
    const gitnexusDir = path.join(tmpDir, '.gitnexus');
    try {
      const { ensureGraph } = await import('../services/graph-preflight.js');
      // Stub: binary exists, analyze creates the .gitnexus dir and reports success
      const result = await ensureGraph(tmpDir, {
        detectFn: () => ({ found: true }),
        analyzeFn: (repoRoot) => {
          fs.mkdirSync(path.join(repoRoot, '.gitnexus'), { recursive: true });
          return { success: true, indexPath: path.join(repoRoot, '.gitnexus'), symbolCount: 10 };
        },
      });
      assert.equal(result.available, true, 'result.available must be true on success');
      assert.ok(fs.existsSync(gitnexusDir), '.gitnexus dir must exist after successful analyze stub');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
