// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  buildRefinementManifest,
} = await import('../bin/spawn-refinement-team.js');

function tmpDir(prefix = 'pickle-refine-manifest-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('spawn-refinement-team: manifest PRD tickets inherit source PRD attribution', () => {
  const root = tmpDir();
  try {
    const parentPrd = path.join(root, 'bundle.md');
    const sourcePrd = path.join(root, 'source.md');
    const refinementDir = path.join(root, 'refinement');
    fs.mkdirSync(refinementDir, { recursive: true });
    fs.writeFileSync(parentPrd, [
      '---',
      'peer_prds:',
      '  deferred:',
      '    - source.md',
      '---',
      '# Bundle',
    ].join('\n'));
    fs.writeFileSync(sourcePrd, [
      '# Source',
      '',
      '## Source Section',
      '',
      '| ID | Check |',
      '|---|---|',
      '| AC-SRC-01 | Source requirement |',
    ].join('\n'));
    fs.writeFileSync(path.join(refinementDir, 'analysis_requirements.md'), [
      '## ac_shape_smells',
      '```json',
      JSON.stringify({
        ac_shape_smells: [],
        tickets: [
          { id: 'ticket-1', title: 'Implement source requirement', source_ac_ids: ['AC-SRC-01'] },
        ],
      }),
      '```',
    ].join('\n'));

    const manifest = buildRefinementManifest({
      prdPath: parentPrd,
      sessionDir: root,
    }, {
      refinementDir,
      cyclesRequested: 1,
      maxTurns: 1,
      allCycleResults: [[]],
      finalResults: [{ roleId: 'requirements', success: true, logPath: path.join(root, 'worker.log'), exitCode: 0, signal: null, cycle: 1 }],
      allSuccess: true,
    });

    assert.deepEqual(manifest.tickets.map((ticket) => ({
      id: ticket.id,
      source_prd: ticket.source_prd,
      source_section: ticket.source_section,
      mapped_requirements: ticket.mapped_requirements,
    })), [{
      id: 'ticket-1',
      source_prd: 'source.md',
      source_section: 'Source Section',
      mapped_requirements: ['AC-SRC-01'],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
