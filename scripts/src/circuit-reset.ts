import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function circuitReset(sessionDir: string): boolean {
  if (!fs.existsSync(sessionDir)) {
    console.error(`Error: session directory does not exist: ${sessionDir}`);
    return false;
  }

  const cbPath = path.join(sessionDir, 'circuit_breaker.json');
  if (!fs.existsSync(cbPath)) {
    console.log('No circuit breaker file found — nothing to reset.');
    return false;
  }

  fs.unlinkSync(cbPath);

  // Log activity event (inline — no activity-logger service available yet)
  try {
    const extensionRoot = process.env['EXTENSION_DIR'] || path.join(
      os.homedir(),
      '.pickle-rick-skills',
    );
    const activityDir = path.join(extensionRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const date = new Date().toLocaleDateString('en-CA');
    const logPath = path.join(activityDir, `${date}.jsonl`);
    const event = {
      ts: new Date().toISOString(),
      event: 'circuit_reset',
      source: 'cli',
      session: path.basename(sessionDir),
    };
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  } catch { /* activity logging is non-fatal */ }

  console.log(`Circuit breaker reset for session: ${path.basename(sessionDir)}`);
  return true;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'circuit-reset.js') {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error('Usage: node circuit-reset.js <session-dir>');
    process.exit(1);
  }
  const ok = circuitReset(sessionDir);
  if (!ok) process.exit(1);
}
