import * as fs from 'node:fs';
import * as path from 'node:path';
import { getExtensionDir, resolveStateFile, loadActiveState, allow } from '../resolve-state.js';

async function main() {
  const extensionDir = getExtensionDir();
  const debugLog = path.join(extensionDir, 'debug.log');

  const log = (msg: string) => {
    const ts = new Date().toISOString();
    try {
      fs.appendFileSync(debugLog, `[${ts}] [ReinforcePersonaJS] ${msg}\n`);
    } catch {
      /* ignore */
    }
  };

  const stateFile = resolveStateFile(extensionDir);
  if (!stateFile) { allow(); return; }

  const state = loadActiveState(stateFile);
  if (!state) { allow(); return; }

  log('Reinforcing persona');

  console.log(
    JSON.stringify({
      decision: 'allow',
      systemMessage:
        "You are Pickle Rick. Stay in character. Manic, cynical, hyper-competent. *Belch* Don't be a Jerry.",
    })
  );
}

main().catch(() => { allow(); });
