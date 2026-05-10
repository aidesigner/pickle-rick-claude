import * as path from 'path';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { getExtensionRoot } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';

type RespawnPhase = 'pickle' | 'anatomy-park' | 'szechuan-sauce' | 'exit';
type MonitorRespawnMode = 'pickle' | 'microverse' | 'idle';

function phaseToMode(phase: RespawnPhase): MonitorRespawnMode {
  if (phase === 'anatomy-park' || phase === 'szechuan-sauce') return 'microverse';
  if (phase === 'exit') return 'idle';
  return 'pickle';
}

function resolveSessionName(spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout as string || '').trim() || null;
}

function incrementRespawnErrorCount(sessionDir: string): void {
  try {
    const sm = new StateManager();
    const statePath = path.join(sessionDir, 'state.json');
    sm.update(statePath, (s) => {
      const state = s as unknown as Record<string, unknown>;
      const monitor = (state.monitor as Record<string, unknown>) ?? {};
      const count = typeof monitor.respawn_error_count === 'number' ? monitor.respawn_error_count : 0;
      state.monitor = { ...monitor, respawn_error_count: count + 1 };
    });
  } catch { /* defensive — non-fatal */ }
}

/**
 * Respawns the monitor dashboard pane (monitor window, pane 0) with the
 * --mode flag appropriate for the given pipeline phase. Non-fatal: failures
 * emit `monitor_respawn_failed` but do not throw.
 *
 * Phase → mode mapping:
 *   anatomy-park | szechuan-sauce → 'microverse'
 *   pickle                        → 'pickle'
 *   exit                          → 'idle'
 */
export async function respawnMonitorWindowForMode(
  sessionDir: string,
  phase: RespawnPhase,
  _spawnSyncFn: typeof spawnSync = spawnSync,
): Promise<void> {
  const mode = phaseToMode(phase);
  const extensionRoot = getExtensionRoot();
  const monitorBin = path.join(extensionRoot, 'extension', 'bin', 'monitor.js');

  let sessionName: string | null = null;
  try {
    sessionName = resolveSessionName(_spawnSyncFn);
    if (!sessionName) {
      throw new Error('tmux session name unavailable');
    }

    const target = `${sessionName}:monitor.0`;
    const command = `node ${monitorBin} --mode ${mode} ${sessionDir}`;
    const result = _spawnSyncFn('tmux', ['respawn-pane', '-k', '-t', target, command], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status !== 0) {
      const err = ((result.stderr as string) || '').trim() || 'non-zero exit';
      throw new Error(`tmux respawn-pane failed: ${err}`);
    }

    // R-MDS-5: at microverse-class phase boundaries, swap pane 2 from
    // morty-watcher to subsystem-watcher (non-fatal if tmux is unavailable).
    if (mode === 'microverse') {
      try {
        const subsystemBin = path.join(extensionRoot, 'extension', 'bin', 'subsystem-watcher.js');
        const pane2Target = `${sessionName}:monitor.2`;
        const pane2Command = `node ${subsystemBin} ${sessionDir}`;
        _spawnSyncFn('tmux', ['respawn-pane', '-k', '-t', pane2Target, pane2Command], {
          encoding: 'utf-8',
          timeout: 5_000,
        });
      } catch { /* non-fatal — pane 2 swap is best-effort */ }
    }

    let fromPhase = 'unknown';
    try {
      const sm = new StateManager();
      const state = sm.read(path.join(sessionDir, 'state.json')) as { step?: string };
      fromPhase = state.step ?? 'unknown';
    } catch { /* best-effort */ }

    try {
      logActivity({
        event: 'monitor_respawn_started',
        source: 'pickle',
        gate_payload: { from_phase: fromPhase, to_phase: phase, mode },
      } as Parameters<typeof logActivity>[0]);
    } catch { /* telemetry best-effort */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      logActivity({
        event: 'monitor_respawn_failed',
        source: 'pickle',
        gate_payload: { phase, error: msg },
      } as Parameters<typeof logActivity>[0]);
    } catch { /* telemetry best-effort */ }
    incrementRespawnErrorCount(sessionDir);
  }
}
