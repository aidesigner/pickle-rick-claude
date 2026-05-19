/**
 * judge-spawn-env.ts — R-SJET-3
 *
 * Purpose: Produce a sanitized env for the LLM judge `claude` / `codex` spawns
 * inside microverse-runner / szechuan / plumbus / microverse.
 *
 * Goals:
 * - Prevent nested-claude auth/session contamination (H2 in the SJET PRD).
 * - Strip PICKLE_* and CLAUDE* session markers that can leak the outer manager context.
 * - Keep only the minimal required for the judge CLI to auth and run (ANTHROPIC_API_KEY etc. survive).
 * - Provide a single place for future "judge backend specific" pruning.
 *
 * Used by: microverse-runner.ts (measureLlmMetricAttempt + probeJudgeCliAvailability)
 * and any future convergence judge paths.
 */

export type JudgeBackend = 'claude' | 'codex' | 'auto';

const DANGEROUS_PREFIXES = [
  'PICKLE_',
  'CLAUDECODE',
  'CLAUDE_',
  'PICKLE_RICK_',
  'SESSION_ROOT',
  'TICKET_DIR',
];

const ALLOWED_JUDGE_OVERRIDES: Record<string, string> = {
  // We deliberately do NOT pass the outer PICKLE_STATE_FILE etc.
};

/**
 * Build a clean env for spawning the judge CLI.
 * Strips anything that would make an inner `claude` think it is still inside the
 * outer Pickle manager session (the root cause of the iter-3 hang on claude backend).
 */
export function buildJudgeSpawnEnv(
  backend: JudgeBackend,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;

    // Never leak pickle internal state or outer session markers into the judge.
    if (DANGEROUS_PREFIXES.some(p => k.startsWith(p))) {
      continue;
    }

    // Keep everything else (API keys, PATH, HOME, etc.)
    out[k] = v;
  }

  // Explicitly force a "clean" claude context for the judge.
  // The judge itself may set its own, but we start from a known-good slate.
  delete out['CLAUDECODE'];
  delete out['PICKLE_STATE_FILE'];
  delete out['PICKLE_ROLE'];

  // Future: per-backend tweaks (e.g. codex may need different model routing)
  if (backend === 'claude' || backend === 'auto') {
    // claude CLI is the default judge path we are hardening.
  }

  // Merge any explicit overrides (currently empty — hook for R-SJET-4 config).
  Object.assign(out, ALLOWED_JUDGE_OVERRIDES);

  return out;
}

/**
 * Convenience wrapper used at the two spawn sites.
 * Returns the exact shape expected by child_process / execFile.
 */
export function getJudgeEnvForAttempt(
  backend: JudgeBackend,
  cwd: string
): NodeJS.ProcessEnv {
  // cwd is accepted for future "per-repo .env" loading if we ever need it.
  // Currently we do not want to inherit repo .env that might contain conflicting keys.
  void cwd;
  return buildJudgeSpawnEnv(backend);
}

export default { buildJudgeSpawnEnv, getJudgeEnvForAttempt };