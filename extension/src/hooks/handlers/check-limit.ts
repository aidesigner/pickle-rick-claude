import * as fs from 'node:fs';
import * as path from 'node:path';
import { State } from '../../types/index.js';
import { getExtensionDir, resolveStateFile, allow } from '../resolve-state.js';

async function main() {
  const extensionDir = getExtensionDir();
  const globalDebugLog = path.join(extensionDir, 'debug.log');
  let sessionHooksLog: string | null = null;

  const log = (msg: string) => {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] [CheckLimitJS] ${msg}\n`;
    try { fs.appendFileSync(globalDebugLog, formatted); } catch { /* ignore */ }
    if (sessionHooksLog) {
      try { fs.appendFileSync(sessionHooksLog, formatted); } catch { /* ignore */ }
    }
  };

  const stateFile = resolveStateFile(extensionDir);
  if (!stateFile) { allow(); return; }

  const state: State = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
    allow();
    return;
  }

  if (!state.active) { allow(); return; }

  sessionHooksLog = path.join(path.dirname(stateFile), 'hooks.log');

  const now = Math.floor(Date.now() / 1000);
  const elapsedSeconds = now - state.start_time_epoch;
  const maxTimeSeconds = state.max_time_minutes * 60;

  if (state.jar_complete) {
    log('Jar complete');
    console.log(
      JSON.stringify({ decision: 'deny', continue: false, reason: 'Jar processing complete' })
    );
    return;
  }

  if (state.max_time_minutes > 0 && elapsedSeconds >= maxTimeSeconds) {
    log(`Time limit exceeded: ${elapsedSeconds}/${maxTimeSeconds}s`);
    console.log(
      JSON.stringify({ decision: 'deny', continue: false, reason: 'Time limit exceeded' })
    );
    return;
  }

  if (state.max_iterations > 0 && state.iteration > state.max_iterations) {
    log(`Iteration limit exceeded: ${state.iteration}/${state.max_iterations}`);
    console.log(
      JSON.stringify({
        decision: 'deny',
        continue: false,
        reason: `Iteration limit exceeded (${state.iteration}/${state.max_iterations})`,
      })
    );
    return;
  }

  allow();
}

main().catch(() => { allow(); });
