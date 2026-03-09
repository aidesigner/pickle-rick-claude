import * as fs from 'fs';
import * as path from 'path';
import type { State } from './types/index.js';
import { getSessionForCwd } from './services/session-map.js';
import { loadCBState } from './services/circuit-breaker.js';

export async function showStatus(cwd: string): Promise<string> {
  const sessionPath = await getSessionForCwd(cwd);
  if (!sessionPath) {
    return 'No active session for this directory.';
  }

  const statePath = path.join(sessionPath, 'state.json');
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as State;
  } catch {
    return 'Session state is unreadable.';
  }

  const maxIter = Number(state.max_iterations) || 0;
  const curIter = Number(state.iteration) || 0;
  const iterStr = maxIter > 0 ? `${curIter} of ${maxIter}` : String(curIter);

  const elapsed = state.start_time_epoch
    ? Math.floor(Date.now() / 1000) - state.start_time_epoch
    : 0;
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;

  const lines = [
    `Active: ${state.active ? 'Yes' : 'No'}`,
    `Step: ${state.step || 'unknown'}`,
    `Iteration: ${iterStr}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Elapsed: ${elapsedMin}m ${elapsedSec}s`,
    `Session: ${path.basename(sessionPath)}`,
  ];

  // CB state
  const cbPath = path.join(sessionPath, 'circuit_breaker.json');
  if (fs.existsSync(cbPath)) {
    const cb = loadCBState(sessionPath);
    lines.push(`Circuit Breaker: ${cb.state}`);
    if (cb.state !== 'CLOSED') {
      lines.push(`  Reason: ${cb.reason}`);
      lines.push(`  No-progress: ${cb.consecutive_no_progress}`);
    }
  }

  return lines.join('\n');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'status.js') {
  let cwd = process.cwd();
  const cwdIdx = process.argv.indexOf('--cwd');
  if (cwdIdx !== -1 && process.argv[cwdIdx + 1]) {
    cwd = process.argv[cwdIdx + 1];
  }
  showStatus(cwd)
    .then((output) => console.log(output))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    });
}
