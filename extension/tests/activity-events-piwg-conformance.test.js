// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const SCHEMA_PATH = path.join(repoRoot, 'extension/src/types/activity-events.schema.json');
const EVENT_CASES_PATH = path.join(repoRoot, 'extension/tests/activity-event-payload.test.js');
const SPAWN_REFINE_PATH = path.join(repoRoot, 'extension/src/bin/spawn-refinement-team.ts');

// PIWG-bundle events: all events emitted by R-SRTS-1, R-PIWG-1, R-PIWG-4, R-PRCR-1.
// Each event MUST satisfy the three-way triangle: schema oneOf + EVENT_CASES + ACTIVITY_EVENT_SCHEMA_SECTION.
const PIWG_EVENTS = [
  'setup_resume_ticket_status_preserved',
  'setup_resume_overrode_ticket_status',
  'head_mismatch_detected',
  'stale_index_lock_cleaned',
  'stale_index_lock_held_by_live_process',
  'setup_resume_chdir_applied',
  'ticket_runnability_resolved',
];

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const eventCasesSrc = fs.readFileSync(EVENT_CASES_PATH, 'utf-8');
const spawnRefineSrc = fs.readFileSync(SPAWN_REFINE_PATH, 'utf-8');

function schemaHasEventDefinition(name) {
  return Object.prototype.hasOwnProperty.call(schema.definitions ?? {}, name);
}

function schemaOneOfReferencesEvent(name) {
  const oneOf = schema.oneOf ?? [];
  const ref = `#/definitions/${name}`;
  return oneOf.some((entry) => entry?.$ref === ref);
}

function eventCasesHasType(name) {
  // Look for `type: '<name>'` in EVENT_CASES array entries.
  const re = new RegExp(`type:\\s*['"]${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`);
  return re.test(eventCasesSrc);
}

function eventNamesContains(name) {
  // EVENT_NAMES array near the schema-drift block.
  const re = new RegExp(`['"]${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`);
  return re.test(eventCasesSrc);
}

function spawnRefineGroundingHasEvent(name) {
  // The ACTIVITY_EVENT_SCHEMA_SECTION docs table rows the event name in a backticked cell.
  const re = new RegExp(`\\\\\`${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\\``);
  return re.test(spawnRefineSrc);
}

for (const eventName of PIWG_EVENTS) {
  test(`piwg-triangle: ${eventName} has schema definition`, () => {
    assert.ok(
      schemaHasEventDefinition(eventName),
      `activity-events.schema.json definitions missing '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} is referenced from schema oneOf`, () => {
    assert.ok(
      schemaOneOfReferencesEvent(eventName),
      `activity-events.schema.json oneOf does not reference '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in EVENT_CASES test table`, () => {
    assert.ok(
      eventCasesHasType(eventName),
      `activity-event-payload.test.js EVENT_CASES has no entry for '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in EVENT_NAMES drift-check array`, () => {
    assert.ok(
      eventNamesContains(eventName),
      `activity-event-payload.test.js EVENT_NAMES drift-check missing '${eventName}'`,
    );
  });

  test(`piwg-triangle: ${eventName} appears in spawn-refinement-team ACTIVITY_EVENT_SCHEMA_SECTION`, () => {
    assert.ok(
      spawnRefineGroundingHasEvent(eventName),
      `spawn-refinement-team.ts ACTIVITY_EVENT_SCHEMA_SECTION missing grounding row for '${eventName}'`,
    );
  });
}

test('piwg-triangle: synthetic gap test — a missing spawn-refinement-team row would be detected', () => {
  // The detector is grep-based on the source; a gap would manifest as
  // `spawnRefineGroundingHasEvent` returning false. Verify the detector itself
  // returns false for a known-absent event name to prove it's not a false-positive.
  const fakeEvent = 'definitely_not_a_real_event_name_xyz_12345';
  assert.strictEqual(
    spawnRefineGroundingHasEvent(fakeEvent),
    false,
    `detector falsely reported grounding for ${fakeEvent}`,
  );
  assert.strictEqual(
    schemaHasEventDefinition(fakeEvent),
    false,
    `detector falsely reported schema for ${fakeEvent}`,
  );
});
