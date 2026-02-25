#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getExtensionRoot } from '../services/pickle-utils.js';

function main() {
  const args = process.argv.slice(2);
  let sessionPath = '';

  // Find session path from args or map
  const resumeIndex = args.indexOf('--resume');
  if (resumeIndex !== -1 && args[resumeIndex + 1] && !args[resumeIndex + 1].startsWith('--')) {
    sessionPath = args[resumeIndex + 1];
  }

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');
    if (fs.existsSync(SESSIONS_MAP)) {
      try {
        const map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
        sessionPath = map[process.cwd()] || '';
      } catch {
        /* corrupt map — no session path */
      }
    }
  }

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.error('Worker Error: No session path found.');
    process.exit(1);
  }

  printMinimalPanel(
    'Morty Worker Initialized',
    {
      Session: path.basename(sessionPath),
      CWD: process.cwd(),
    },
    'BLUE',
    '👶'
  );
}

if (process.argv[1] && path.basename(process.argv[1]) === 'worker-setup.js') {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
