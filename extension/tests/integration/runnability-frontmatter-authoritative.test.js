// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const muxRunnerSrc = fs.readFileSync(path.join(repoRoot, 'extension/src/bin/mux-runner.ts'), 'utf-8');
const typesSrc = fs.readFileSync(path.join(repoRoot, 'extension/src/types/index.ts'), 'utf-8');

test('runnability-frontmatter (R-RMBS-3.a): no parallel state field for runnability', () => {
  // Forbidden: state.failed_tickets / state.blocked_tickets / state.skipped_tickets
  // The doc explicitly forbids these field names from re-appearing in State.
  const forbidden = ['failed_tickets', 'blocked_tickets', 'skipped_tickets'];
  for (const field of forbidden) {
    // Allow mentions inside strings/comments (e.g. the FORBIDDEN comment itself);
    // disallow only actual access patterns like `state.<field>` or interface props.
    const accessRe = new RegExp(`state\\.${field}|^\\s*${field}\\??:\\s*`, 'm');
    assert.ok(
      !accessRe.test(muxRunnerSrc),
      `mux-runner.ts has access to forbidden parallel set state.${field}`,
    );
    assert.ok(
      !accessRe.test(typesSrc),
      `types/index.ts has access to forbidden parallel set state.${field}`,
    );
  }
});

test('runnability-frontmatter (R-RMBS-3.d): ticket_runnability_resolved event is registered', () => {
  // The event MUST be in VALID_ACTIVITY_EVENTS so logActivity accepts it.
  assert.match(
    typesSrc,
    /'ticket_runnability_resolved'/,
    'ticket_runnability_resolved must appear in VALID_ACTIVITY_EVENTS',
  );
});

test('runnability-frontmatter (R-RMBS-3.d): mux-runner emits ticket_runnability_resolved at iteration start', () => {
  // The emission must be inside the iteration loop, gated by preTicket presence.
  assert.match(
    muxRunnerSrc,
    /event:\s*['"]ticket_runnability_resolved['"]/,
    'mux-runner.ts must emit ticket_runnability_resolved',
  );
  // And the emission must include the required payload shape.
  const eventRegion = muxRunnerSrc.match(/event:\s*['"]ticket_runnability_resolved['"][\s\S]{0,800}/);
  assert.ok(eventRegion, 'event emission block found');
  const block = eventRegion[0];
  assert.match(block, /frontmatter_status/, 'payload includes frontmatter_status');
  assert.match(block, /runnable/, 'payload includes runnable');
  assert.match(block, /reason/, 'payload includes reason');
});

test('runnability-frontmatter (R-RMBS-3.b): isPendingMuxTicket reads ticket frontmatter, not manifest', () => {
  // isPendingMuxTicket must use getTicketStatus, not manifest.tickets[].status.
  const pendingFnMatch = muxRunnerSrc.match(/function isPendingMuxTicket[\s\S]{0,600}\}/);
  assert.ok(pendingFnMatch, 'isPendingMuxTicket function present');
  const block = pendingFnMatch[0];
  assert.match(
    block,
    /getTicketStatus/,
    'isPendingMuxTicket reads ticket frontmatter via getTicketStatus',
  );
  assert.ok(
    !/manifest\.tickets/.test(block),
    'isPendingMuxTicket must NOT consult refinement_manifest.json',
  );
});
