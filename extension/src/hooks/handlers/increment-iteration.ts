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
    const formatted = `[${ts}] [IncrementIterationJS] ${msg}\n`;
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

  const role = process.env.PICKLE_ROLE;
  if (state.active && role !== 'worker') {
    sessionHooksLog = path.join(path.dirname(stateFile), 'hooks.log');
    state.iteration = (state.iteration || 0) + 1;
    log(`Incrementing iteration to ${state.iteration}`);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  allow();
}

main().catch(() => { allow(); });
