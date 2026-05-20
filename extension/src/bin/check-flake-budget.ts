import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const DEFAULT_RUNS = 5;
const DEFAULT_FAIL_BUDGET = 2;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const USAGE = 'Usage: check-flake-budget [--runs=N] [--fail-budget=N] [--timeout=MS]';

interface ParsedArgs {
  runs: number;
  failBudget: number;
  timeoutMs: number;
}

interface CheckFlakeBudgetMainOpts {
  argv: string[];
  cwd?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  spawnSyncFn?: typeof spawnSync;
}

interface RunSummary {
  failures: number;
  runsCompleted: number;
}

function parseIntegerFlag(name: string, value: string, min: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    runs: DEFAULT_RUNS,
    failBudget: DEFAULT_FAIL_BUDGET,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE);
    }
    if (arg.startsWith('--runs=')) {
      parsed.runs = parseIntegerFlag('--runs', arg.slice('--runs='.length), 1);
      continue;
    }
    if (arg.startsWith('--fail-budget=')) {
      parsed.failBudget = parseIntegerFlag('--fail-budget', arg.slice('--fail-budget='.length), 0);
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      parsed.timeoutMs = parseIntegerFlag('--timeout', arg.slice('--timeout='.length), 1);
      continue;
    }
    throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
  }

  return parsed;
}

function buildRunInvocation(env: NodeJS.ProcessEnv): string[] {
  const testFile = env.PICKLE_FLAKE_BUDGET_TEST_FILE?.trim();
  if (testFile) {
    return ['--test', '--test-concurrency=8', testFile];
  }
  return ['bin/test-runner.js', '--tier', 'fast', '--test-concurrency=8'];
}

function runIterations(
  parsed: ParsedArgs,
  opts: Required<Pick<CheckFlakeBudgetMainOpts, 'cwd' | 'env' | 'execPath' | 'spawnSyncFn'>>,
): RunSummary {
  let failures = 0;
  const childEnv = { ...opts.env };
  delete childEnv.NODE_TEST_CONTEXT;

  for (let runIndex = 0; runIndex < parsed.runs; runIndex += 1) {
    const result = opts.spawnSyncFn(opts.execPath, buildRunInvocation(opts.env), {
      cwd: opts.cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: parsed.timeoutMs,
    });

    if (result.error) {
      throw result.error;
    }

    if ((result.status ?? 1) !== 0) {
      failures += 1;
      if (failures > parsed.failBudget) {
        return { failures, runsCompleted: runIndex + 1 };
      }
    }
  }

  return { failures, runsCompleted: parsed.runs };
}

export async function checkFlakeBudgetMain(opts: CheckFlakeBudgetMainOpts): Promise<number> {
  const stdout = opts.stdout ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  try {
    const parsed = parseArgs(opts.argv);
    const summary = runIterations(parsed, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      execPath: opts.execPath ?? process.execPath,
      spawnSyncFn: opts.spawnSyncFn ?? spawnSync,
    });

    if (summary.failures > parsed.failBudget) {
      stderr(
        `FAIL_BUDGET_EXCEEDED failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`,
      );
      return 1;
    }

    stdout(
      `flake-budget OK failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'check-flake-budget.js') {
  checkFlakeBudgetMain({ argv: process.argv.slice(2) }).then((code) => process.exit(code)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
}
