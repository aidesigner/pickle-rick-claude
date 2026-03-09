import * as path from 'path';
import {
  getSessionForCwd,
  findLastSessionForCwd,
  listSessions,
} from './services/session-map.js';

export async function getSession(args: string[]): Promise<void> {
  let cwd = process.cwd();
  let lastMode = false;
  let listMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cwd') {
      cwd = args[++i];
      if (!cwd) {
        console.error('Error: --cwd requires a path');
        process.exit(1);
      }
    } else if (arg === '--last') {
      lastMode = true;
    } else if (arg === '--list') {
      listMode = true;
    }
  }

  if (listMode) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log('No active sessions.');
      return;
    }
    for (const s of sessions) {
      console.log(`${s.cwd} → ${s.sessionDir}`);
    }
    return;
  }

  // Try map lookup first
  let sessionPath = await getSessionForCwd(cwd);

  if (!sessionPath && lastMode) {
    sessionPath = await findLastSessionForCwd(cwd);
  }

  if (sessionPath) {
    process.stdout.write(sessionPath);
  } else {
    console.error(`No active session for directory: ${cwd}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'get-session.js') {
  getSession(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
