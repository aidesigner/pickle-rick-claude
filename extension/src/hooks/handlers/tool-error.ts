import * as fs from 'fs';
import * as path from 'path';
import { PostToolUseFailureInput, LastToolErrorState } from '../../types/index.js';
import { normalizeErrorSignature } from '../../services/circuit-breaker.js';
import { getDataRoot, getExtensionRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { approve, loadActiveState, resolveStateFile } from '../resolve-state.js';

const ERROR_STATE_FILE = 'last-tool-error.json';

function log(message: string): void {
  try {
    fs.appendFileSync(
      path.join(getExtensionRoot(), 'debug.log'),
      `[tool-error] ${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    /* fail open */
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLastToolErrorState(value: unknown): value is LastToolErrorState {
  if (!isObject(value)) return false;
  const retryCount = value.retry_count;
  return typeof value.ts === 'string' &&
    typeof value.tool === 'string' &&
    typeof value.error_signature === 'string' &&
    typeof retryCount === 'number' &&
    Number.isInteger(retryCount) &&
    retryCount > 0;
}

function readExistingState(filePath: string): LastToolErrorState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isLastToolErrorState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseInput(inputData: string): PostToolUseFailureInput | null {
  try {
    const parsed: unknown = JSON.parse(inputData);
    return isObject(parsed) ? parsed as PostToolUseFailureInput : null;
  } catch {
    return null;
  }
}

function buildNextState(input: PostToolUseFailureInput, existing: LastToolErrorState | null): LastToolErrorState | null {
  if (input.hook_event_name !== 'PostToolUseFailure') return null;
  if (input.is_interrupt === true) return null;
  if (typeof input.tool_name !== 'string' || input.tool_name.trim() === '') return null;
  if (typeof input.error !== 'string' || input.error.trim() === '') return null;

  const tool = input.tool_name.trim();
  const errorSignature = normalizeErrorSignature(input.error) || 'unknown';
  const retryCount = existing?.tool === tool && existing.error_signature === errorSignature
    ? existing.retry_count + 1
    : 1;

  return {
    ts: new Date().toISOString(),
    tool,
    error_signature: errorSignature,
    retry_count: retryCount,
  };
}

async function main(): Promise<void> {
  let inputData = '';
  try {
    inputData = fs.readFileSync(0, 'utf8');
  } catch {
    approve();
    return;
  }

  if (!inputData.trim()) {
    approve();
    return;
  }

  const input = parseInput(inputData);
  if (!input) {
    log('Malformed hook event JSON; skipping');
    approve();
    return;
  }

  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile || !loadActiveState(stateFile)) {
    approve();
    return;
  }

  const outputPath = path.join(path.dirname(stateFile), ERROR_STATE_FILE);
  const nextState = buildNextState(input, readExistingState(outputPath));
  if (!nextState) {
    log('Malformed PostToolUseFailure payload; skipping');
    approve();
    return;
  }

  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    log(`Failed to write ${ERROR_STATE_FILE}: ${safeErrorMessage(err)}`);
  }

  approve();
}

main().catch((err) => {
  log(`FATAL: ${safeErrorMessage(err)}`);
  approve();
});
