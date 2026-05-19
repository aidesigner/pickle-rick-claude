import * as fs from 'fs';
import * as path from 'path';
import { Defaults, type Backend } from '../types/index.js';
import { isRecord } from '../lib/is-record.js';
import { safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';

export interface RelaunchCapAuditViolation {
  statePath: string;
  count: number | null;
  cap: number;
  reason: string;
}

export interface RelaunchCapAuditResult {
  cap: number;
  checkedStatePaths: string[];
  violations: RelaunchCapAuditViolation[];
}

function statePathsForBundle(sessionDir: string): string[] {
  const statePaths = [path.join(sessionDir, 'state.json')];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return statePaths;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('microverse_')) continue;
    const childStatePath = path.join(sessionDir, entry.name, 'state.json');
    if (fs.existsSync(childStatePath) || readRecoverableJsonObject(childStatePath) !== null) {
      statePaths.push(childStatePath);
    }
  }

  return statePaths;
}

function readCount(statePath: string): { count: number | null; field: string } {
  let parsed: unknown = readRecoverableJsonObject(statePath);
  if (parsed === null) {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
  }
  if (!isRecord(parsed)) return { count: null, field: 'manager_relaunch_count' };
  let value: unknown;
  let field: string;
  if (parsed.manager_relaunch_count !== undefined) {
    value = parsed.manager_relaunch_count;
    field = 'manager_relaunch_count';
  } else if (parsed.codex_manager_relaunch_count !== undefined) {
    value = parsed.codex_manager_relaunch_count;
    field = 'codex_manager_relaunch_count';
  } else {
    return { count: 0, field: 'manager_relaunch_count' };
  }
  if (value === null) return { count: 0, field };
  if (typeof value === 'number' && Number.isFinite(value)) return { count: value, field };
  return { count: null, field };
}

function readBackend(statePath: string): Backend {
  let parsed: unknown = readRecoverableJsonObject(statePath);
  if (parsed === null) {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
  }
  if (!isRecord(parsed)) return 'claude';
  if (parsed.backend === 'codex' || parsed.backend === 'hermes' || parsed.backend === 'claude') {
    return parsed.backend;
  }
  if (parsed.codex_manager_relaunch_count !== undefined && parsed.manager_relaunch_count === undefined) {
    return 'codex';
  }
  return 'claude';
}

export function auditCodexManagerRelaunchCaps(sessionDir: string): RelaunchCapAuditResult {
  const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
  const checkedStatePaths = statePathsForBundle(sessionDir);
  const violations: RelaunchCapAuditViolation[] = [];

  for (const statePath of checkedStatePaths) {
    try {
      const { count, field } = readCount(statePath);
      const stateCap = readBackend(statePath) === 'claude'
        ? Defaults.CLAUDE_MANAGER_RELAUNCH_CAP
        : Defaults.CODEX_MANAGER_RELAUNCH_CAP;
      if (count === null) {
        violations.push({
          statePath,
          count,
          cap: stateCap,
          reason: `state file is not an object or has a non-numeric ${field}`,
        });
      } else if (count > stateCap) {
        violations.push({
          statePath,
          count,
          cap: stateCap,
          reason: `${field} ${count} exceeds cap ${stateCap}`,
        });
      }
    } catch (err) {
      violations.push({
        statePath,
        count: null,
        cap,
        reason: `state file is unreadable: ${safeErrorMessage(err)}`,
      });
    }
  }

  return { cap, checkedStatePaths, violations };
}
