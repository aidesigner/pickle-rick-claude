// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeManagerPromptFromSkill } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// R-PNTR-5: pickle.md deleted; repointed to committed source template.
const PICKLE_MD_PATH = path.resolve(__dirname, '../templates/_pickle-manager-prompt.md');
const managerTemplateExists = fs.existsSync(PICKLE_MD_PATH);

function assertNoSetupTaskOutsideFraming(payload) {
  // Locate end of framing block (if any) then check remainder for setup.js --task
  const endMarker = '<!-- END MANAGER_ROLE_FRAMING -->';
  const markerIdx = payload.indexOf(endMarker);
  const searchRegion = markerIdx >= 0 ? payload.slice(markerIdx + endMarker.length) : payload;
  const setupTaskRe = /\bsetup\.js\b[^\n]{0,200}--task\b/;
  const m = setupTaskRe.exec(searchRegion);
  assert.ok(m === null, `setup.js --task found outside framing region: ${JSON.stringify(m?.[0])}`);
}

// --- mux-runner surface: codex ---
test('codex-manager-prompt-no-setup-examples: codex mux payload has framing markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(payload.includes('<!-- BEGIN MANAGER_ROLE_FRAMING -->'), 'missing BEGIN marker');
  assert.ok(payload.includes('<!-- END MANAGER_ROLE_FRAMING -->'), 'missing END marker');
});

test('codex-manager-prompt-no-setup-examples: codex mux payload has zero setup.js --task outside markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assertNoSetupTaskOutsideFraming(payload);
});

test('codex-manager-prompt-no-setup-examples: codex payload includes mux no-signal and no-bypass guardrails', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(payload.includes('DO NOT send SIGTERM/SIGINT/SIGKILL to the mux-runner subprocess.'));
  assert.ok(payload.includes('DO NOT decide that mux-runner is wedged based on session-directory observation.'));
  assert.ok(payload.includes('DO NOT attempt to bypass mux-runner by spawning spawn-morty.js directly.'));
});

// --- jar-runner surface: codex ---
test('codex-manager-prompt-no-setup-examples: codex jar payload has framing markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(payload.includes('<!-- BEGIN MANAGER_ROLE_FRAMING -->'), 'missing BEGIN marker');
});

test('codex-manager-prompt-no-setup-examples: codex jar payload has zero setup.js --task outside markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assertNoSetupTaskOutsideFraming(payload);
});

// --- claude mode: no framing ---
test('codex-manager-prompt-no-setup-examples: claude mux payload has NO framing markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'claude', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(!payload.includes('BEGIN MANAGER_ROLE_FRAMING'), 'unexpected BEGIN marker in claude mode');
  assert.ok(!payload.includes('END MANAGER_ROLE_FRAMING'), 'unexpected END marker in claude mode');
});

test('codex-manager-prompt-no-setup-examples: claude jar payload has NO framing markers', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'claude', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(!payload.includes('BEGIN MANAGER_ROLE_FRAMING'), 'unexpected BEGIN marker in claude mode');
});

// --- Backend differentiation: codex and claude payloads must differ from each other ---
// Note: codex backend adds framing markers; claude backend returns the template as-is
// (no $ARGUMENTS or ## SETUP in _pickle-manager-prompt.md — it is already post-strip).
test('codex-manager-prompt-no-setup-examples: codex composed payload differs from on-disk manager template', { skip: !managerTemplateExists }, () => {
  const onDisk = fs.readFileSync(PICKLE_MD_PATH, 'utf-8');
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.notEqual(payload, onDisk, 'codex payload should differ from raw template (framing markers added)');
});

test('codex-manager-prompt-no-setup-examples: codex and claude payloads differ (backend-specific transforms)', { skip: !managerTemplateExists }, () => {
  const codexPayload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  const claudePayload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'claude', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.notEqual(codexPayload, claudePayload, 'codex and claude payloads must differ (codex adds framing)');
});

// --- Step 1 Initialization block stripped ---
test('codex-manager-prompt-no-setup-examples: codex payload has no # Step 1 Initialization heading', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(!payload.includes('# Step 1: Initialization'), '# Step 1: Initialization should be stripped');
});

test('codex-manager-prompt-no-setup-examples: claude payload has no # Step 1 Initialization heading', { skip: !managerTemplateExists }, () => {
  const payload = composeManagerPromptFromSkill(PICKLE_MD_PATH, 'claude', {
    argumentSubstitution: '--resume /fake/session',
  });
  assert.ok(!payload.includes('# Step 1: Initialization'), '# Step 1: Initialization should be stripped');
});

// --- manager template on disk untouched ---
test('codex-manager-prompt-no-setup-examples: manager template on disk is not modified by compose', { skip: !managerTemplateExists }, () => {
  const beforeStat = fs.statSync(PICKLE_MD_PATH);
  composeManagerPromptFromSkill(PICKLE_MD_PATH, 'codex', { argumentSubstitution: '--resume /s' });
  const afterStat = fs.statSync(PICKLE_MD_PATH);
  assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, 'manager template mtime should not change');
});
