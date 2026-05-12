import * as fs from 'node:fs';
import * as path from 'node:path';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runIteration(sessionDir, iteration) {
  const convergencePath = path.join(sessionDir, 'anatomy-park.json');
  const current = readJson(convergencePath);
  const subsystem = Array.isArray(current.subsystems) && current.subsystems.length > 0
    ? current.subsystems[current.current_index ?? 0] ?? current.subsystems[0]
    : 'fixture';

  const next = {
    ...current,
    subsystems: Array.isArray(current.subsystems) && current.subsystems.length > 0
      ? current.subsystems
      : ['fixture'],
    current_index: Number.isInteger(current.current_index) ? current.current_index : 0,
    pass_counts: {
      ...(current.pass_counts ?? {}),
      [subsystem]: iteration,
    },
    consecutive_clean: {
      ...(current.consecutive_clean ?? {}),
      [subsystem]: iteration === 5 ? 0 : Math.max(0, iteration - 5),
    },
    stall_counts: {
      ...(current.stall_counts ?? {}),
    },
    converged: false,
    reason: iteration === 5
      ? 'fixture injected subprocess timeout'
      : `fixture iteration ${iteration}`,
  };
  writeJson(convergencePath, next);

  fs.writeFileSync(
    path.join(sessionDir, `tmux_iteration_${iteration}.log`),
    `fixture iteration ${iteration}\n`,
  );

  if (iteration === 5) {
    return {
      completion: 'error',
      timedOut: true,
      exitCode: null,
      wallSeconds: 14_400,
      stallReason: 'wall_clock',
    };
  }

  return {
    completion: 'continue',
    timedOut: false,
    exitCode: 0,
    wallSeconds: 1,
  };
}
