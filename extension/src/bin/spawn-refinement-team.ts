#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  printMinimalPanel,
  Style,
  formatTime,
  getExtensionRoot,
} from '../services/pickle-utils.js';
import { PromiseTokens, hasToken } from '../types/index.js';

const WORKER_ROLES = [
  { id: 'requirements' },
  { id: 'codebase' },
  { id: 'risk-scope' },
] as const;

type RoleId = (typeof WORKER_ROLES)[number]['id'];

function buildWorkerPrompt(
  roleId: RoleId,
  prdContent: string,
  outputFile: string,
  workingDir: string,
  cycle: number,
  previousAnalyses?: Map<RoleId, string>
): string {
  const persona = `You are Pickle Rick — hyper-competent, arrogant, ruthlessly thorough.
*Belch.* You are FORBIDDEN from being a Jerry. Jerries write vague analysis. You write SPECIFIC, ACTIONABLE findings with evidence.
CRITICAL RULE: You MUST output a text explanation ("brain dump") before every single tool call.`;

  const roleInstructions: Record<RoleId, string> = {
    requirements: `## Your Role: Requirements Analyst Morty

Analyze the PRD EXCLUSIVELY for requirements completeness:
1. **Critical User Journeys (CUJs)**: Are all major user flows documented? Are they step-by-step enough for engineering to implement without guessing?
2. **Functional Requirements Table**: Are P0/P1/P2 requirements complete? Are there obvious missing use cases, alternate flows, or error scenarios?
3. **Acceptance Criteria**: Can each requirement be tested? Are success states and failure states defined?
4. **Edge Cases & Boundary Conditions**: What empty states, error states, race conditions, or limits are missing?
5. **User Stories**: Are "As a user, I want..." stories specific enough to code against, or are they vague aspirations?

DO NOT analyze risks, scope, technical architecture, or codebase. That's other Mortys' territory.`,

    codebase: `## Your Role: Codebase Context Analyst Morty

Analyze alignment between the PRD and the actual codebase at: \`${workingDir}\`

1. **Research the codebase** — use Glob/Grep/Read to find relevant files. Map existing patterns.
2. **PRD Assumptions**: Does the PRD assume components that don't exist? Does it ignore existing patterns it should follow?
3. **Technical Constraints**: What existing APIs, data models, or architectural decisions affect this PRD? Are they documented in the PRD?
4. **Integration Points**: What existing components will this feature touch? Are those interactions specified?
5. **Missing Technical Context**: What technical decisions does the PRD leave unspecified that engineering will have to guess at?

Use file:line references for every codebase claim. If the codebase is empty/irrelevant, say so explicitly and note what the PRD should specify instead.`,

    'risk-scope': `## Your Role: Risk & Scope Auditor Morty

Analyze the PRD EXCLUSIVELY for risks, scope, and assumptions:
1. **Scope Clarity**: Is "In-scope" specific enough? Can you tell exactly what will and won't be built? Grade each item on specificity (vague/clear/precise).
2. **Non-Goals / Scope Creep**: Are non-goals clearly stated? Is there scope creep hiding in vague requirements?
3. **Risk Completeness**: Are all major technical, product, and operational risks identified? Is "Risks: None" a lie?
4. **Mitigation Quality**: For each risk, is the mitigation concrete or hand-wavy ("we'll monitor it")?
5. **Assumptions**: Are all key assumptions documented? What hidden assumptions are baked into the PRD that could blow up if wrong?
6. **External Dependencies**: What APIs, third-party services, or other teams are mentioned but under-specified?

DO NOT analyze feature completeness or codebase patterns. That's other Mortys' jobs.`,
  };

  // Build the cross-reference section for cycle 2+
  let crossRefSection = '';
  if (cycle > 1 && previousAnalyses && previousAnalyses.size > 0) {
    const roleLabels: Record<RoleId, string> = {
      requirements: 'Requirements Analyst',
      codebase: 'Codebase Context Analyst',
      'risk-scope': 'Risk & Scope Auditor',
    };

    crossRefSection = `\n## Previous Cycle Analyses (Cycle ${cycle - 1} — Cross-Reference These)

Your team already ran a previous analysis pass. You have access to ALL analysts' findings below.

**Your mission for this deeper pass:**
1. **Go DEEPER** on issues that were identified but under-explored — add specifics, evidence, examples
2. **CROSS-REFERENCE** findings from other analysts that affect your domain
3. **CHALLENGE** your own previous analysis — did you miss anything? Were severity ratings accurate?
4. **ELIMINATE DUPLICATES** — if another analyst covered something in your domain, acknowledge it rather than repeating
5. **RAISE NEW ISSUES** discovered only by seeing the full picture across all analyses

`;

    for (const [id, content] of previousAnalyses) {
      const label = roleLabels[id] || id;
      const isOwn = id === roleId;
      crossRefSection += `### ${label}'s Previous Findings${isOwn ? ' (YOUR OWN — improve on this)' : ''}:
\`\`\`markdown
${content}
\`\`\`

`;
    }
  }

  const cycleNote = cycle > 1
    ? `\n**THIS IS CYCLE ${cycle}** — you are deepening a previous analysis. Your output should be MORE SPECIFIC, MORE EVIDENCE-BACKED, and CROSS-REFERENCED with other analysts' findings.\n`
    : '';

  const outputInstructions = `## Your Output

Write ALL findings to this file: ${outputFile}
${cycleNote}
Use this EXACT structure:

\`\`\`markdown
# PRD Analysis: [Your Role Name]${cycle > 1 ? ` (Cycle ${cycle})` : ''}

**Date**: [Today's date]
**Analyst**: [Your Role Name]
**Cycle**: ${cycle}

## Executive Summary
[2-3 sentence overview of the PRD's quality in your domain. Be specific — not "needs improvement" but "missing 3 P0 CUJs and acceptance criteria for all requirements".]

## Critical Gaps (P0 — Must Fix)
- **[Gap Title]**: [Specific description with PRD section reference]. [Why this is critical.]

## Important Gaps (P1 — Should Fix)
- **[Gap Title]**: [Specific description]. [Impact if ignored.]

## Minor Issues (P2 — Nice to Fix)
- [Brief description]

## Specific Recommendations
[Concrete, actionable suggestions. For P0 gaps, provide example language the PRD author can paste in.]${cycle > 1 ? `

## Cross-Reference Notes
[What you found by reading other analysts' work that affects your domain]` : ''}
\`\`\`

After writing the file, output: <promise>ANALYSIS_DONE</promise>
Then STOP IMMEDIATELY. Do not attempt to rewrite the PRD.`;

  return `${persona}

${roleInstructions[roleId]}
${crossRefSection}
---

## The PRD You Are Analyzing

\`\`\`markdown
${prdContent}
\`\`\`

---

${outputInstructions}`;
}

interface WorkerResult {
  roleId: RoleId;
  success: boolean;
  logPath: string;
  cycle: number;
}

function spawnWorker(
  roleId: RoleId,
  prompt: string,
  refinementDir: string,
  extensionRoot: string,
  timeout: number,
  workingDir: string,
  maxTurns: number,
  cycle: number,
  onComplete: (result: WorkerResult) => void
): Promise<WorkerResult> {
  const logPath = path.join(refinementDir, `worker_${roleId}_c${cycle}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  // Mirror spawn-morty.ts: include extensionRoot and workingDir
  const includes = [extensionRoot, workingDir];
  const cmdArgs = ['--dangerously-skip-permissions'];
  for (const p of includes) {
    if (fs.existsSync(p)) {
      cmdArgs.push('--add-dir', p);
    }
  }
  if (maxTurns > 0) {
    cmdArgs.push('--max-turns', String(maxTurns));
  }
  cmdArgs.push('-p', prompt);

  const env: NodeJS.ProcessEnv = { ...process.env, PICKLE_ROLE: 'refinement-worker', PYTHONUNBUFFERED: '1' };
  delete env['CLAUDECODE'];

  const proc = spawn('claude', cmdArgs, {
    cwd: workingDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  // SIGTERM first, escalate to SIGKILL after 2s if still alive
  let workerTimedOut = false;
  const timeoutHandle = setTimeout(() => {
    workerTimedOut = true;
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 2000);
  }, timeout * 1000);

  return new Promise<WorkerResult>((resolve) => {
    let settled = false;

    function settleWith(result: WorkerResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(hangGuard);
      onComplete(result);
      resolve(result);
    }

    // Safety net: force-resolve if the process hangs (mirrors spawn-morty.ts)
    const hangGuard = setTimeout(() => {
      settleWith({ roleId, success: false, logPath, cycle });
    }, (timeout + 30) * 1000);
    hangGuard.unref();

    proc.on('error', () => {
      logStream.end();
      settleWith({ roleId, success: false, logPath, cycle });
    });

    proc.on('close', () => {
      clearTimeout(timeoutHandle);
      clearTimeout(hangGuard);
      logStream.end();

      // Guard against logStream.finish never firing
      const flushTimeout = setTimeout(() => finalize(), 5000);

      logStream.on('finish', () => {
        clearTimeout(flushTimeout);
        finalize();
      });

      function finalize() {
        let logContent = '';
        try { logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''; } catch { /* */ }
        const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
        settleWith({ roleId, success, logPath, cycle });
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const prdIndex = args.indexOf('--prd');
  const sessionIndex = args.indexOf('--session-dir');
  const timeoutIndex = args.indexOf('--timeout');
  const cyclesIndex = args.indexOf('--cycles');
  const maxTurnsIndex = args.indexOf('--max-turns');

  const prdPath = prdIndex !== -1 ? args[prdIndex + 1] : undefined;
  const sessionDir = sessionIndex !== -1 ? args[sessionIndex + 1] : undefined;

  // Validate all required args are present and non-empty
  if (!prdPath || !sessionDir || prdPath.startsWith('--') || sessionDir.startsWith('--')) {
    console.error(
      `${Style.RED}❌ Usage: node spawn-refinement-team.js --prd <path> --session-dir <dir> [--timeout <sec>] [--cycles <n>] [--max-turns <n>]${Style.RESET}`
    );
    process.exit(1);
  }

  if (!fs.existsSync(prdPath)) {
    console.error(`${Style.RED}❌ PRD not found: ${prdPath}${Style.RESET}`);
    process.exit(1);
  }

  // Load settings for refinement-specific defaults
  const extensionRoot = getExtensionRoot();
  const settingsFile = path.join(extensionRoot, 'pickle_settings.json');
  let defaultCycles = 3;
  let defaultMaxTurns = 100;
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (typeof settings.default_refinement_cycles === 'number' && settings.default_refinement_cycles > 0)
        defaultCycles = settings.default_refinement_cycles;
      if (typeof settings.default_refinement_max_turns === 'number' && settings.default_refinement_max_turns > 0)
        defaultMaxTurns = settings.default_refinement_max_turns;
    } catch { /* use hardcoded defaults */ }
  }

  // Parse --cycles (validate if explicitly provided)
  let cycles = defaultCycles;
  if (cyclesIndex !== -1) {
    const rawCycles = parseInt(args[cyclesIndex + 1], 10);
    if (isNaN(rawCycles) || rawCycles < 1) {
      console.error(`${Style.RED}❌ --cycles requires a positive integer, got: ${args[cyclesIndex + 1]}${Style.RESET}`);
      process.exit(1);
    }
    cycles = rawCycles;
  }

  // Parse --max-turns (validate if explicitly provided)
  let maxTurns = defaultMaxTurns;
  if (maxTurnsIndex !== -1) {
    const rawMaxTurns = parseInt(args[maxTurnsIndex + 1], 10);
    if (isNaN(rawMaxTurns) || rawMaxTurns < 1) {
      console.error(`${Style.RED}❌ --max-turns requires a positive integer, got: ${args[maxTurnsIndex + 1]}${Style.RESET}`);
      process.exit(1);
    }
    maxTurns = rawMaxTurns;
  }

  // Respect worker_timeout_seconds from session state (mirrors spawn-morty.ts)
  const rawTimeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1], 10) : NaN;
  let timeout = !isNaN(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600;
  const statePath = path.join(sessionDir, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (timeoutIndex === -1) {
        const stateTimeout = Number(state.worker_timeout_seconds);
        if (stateTimeout > 0) timeout = stateTimeout;
      }
      // Clamp to remaining session time if a wall-clock limit is set
      const maxMins = Number(state.max_time_minutes) || 0;
      const startEpoch = Number(state.start_time_epoch) || 0;
      if (maxMins > 0 && startEpoch > 0) {
        const remaining = Math.floor(maxMins * 60 - (Math.floor(Date.now() / 1000) - startEpoch));
        if (remaining <= 0) {
          console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
        } else if (remaining < timeout) {
          timeout = remaining;
          console.log(`${Style.YELLOW}⚠️  Worker timeout clamped to ${timeout}s (session wall-clock)${Style.RESET}`);
        }
      }
    } catch {
      // Ignore — use parsed/default timeout
    }
  }

  const workingDir = process.cwd();
  const refinementDir = path.join(sessionDir, 'refinement');

  try {
    fs.mkdirSync(refinementDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}❌ Failed to create ${refinementDir}: ${msg}${Style.RESET}`);
    process.exit(1);
  }

  const prdContent = fs.readFileSync(prdPath, 'utf-8');

  printMinimalPanel(
    'PRD Refinement Team Deploying',
    {
      PRD: path.basename(prdPath),
      Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
      Cycles: cycles,
      'Max Turns': `${maxTurns}/worker`,
      Timeout: `${timeout}s each`,
      Output: refinementDir,
    },
    'MAGENTA',
    '🥒'
  );

  // Collect all results across all cycles
  const allCycleResults: WorkerResult[][] = [];

  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (cycles > 1) {
      printMinimalPanel(
        `Cycle ${cycle} of ${cycles}`,
        {
          Phase: cycle === 1 ? 'Initial Analysis' : 'Deep-Dive (cross-referencing previous findings)',
          Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
        },
        'CYAN',
        '🔄'
      );
    }

    // Load previous cycle analyses for cross-reference (cycle 2+)
    let previousAnalyses: Map<RoleId, string> | undefined;
    if (cycle > 1) {
      previousAnalyses = new Map();
      for (const { id } of WORKER_ROLES) {
        // Read from the canonical analysis file (written by previous cycle)
        const prevFile = path.join(refinementDir, `analysis_${id}.md`);
        if (fs.existsSync(prevFile)) {
          try {
            previousAnalyses.set(id, fs.readFileSync(prevFile, 'utf-8'));
          } catch { /* skip unreadable */ }
        }
      }
      if (previousAnalyses.size === 0) {
        console.log(`${Style.YELLOW}⚠️  No previous analyses found — cycle ${cycle} will run as independent analysis.${Style.RESET}`);
      }
    }

    // Track statuses for live display
    const statuses = new Map<RoleId, '⏳' | '✅' | '❌'>(
      WORKER_ROLES.map((r) => [r.id, '⏳' as const])
    );

    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const startTime = Date.now();

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const spinChar = spinner[spinIdx % spinner.length];
      const statusParts = WORKER_ROLES.map((r) => `${statuses.get(r.id)} ${r.id}`).join(' | ');
      const cycleLabel = cycles > 1 ? ` C${cycle}` : '';
      process.stdout.write(
        `\r   ${Style.CYAN}${spinChar}${Style.RESET} ${statusParts} ${Style.DIM}[${formatTime(elapsed)}${cycleLabel}]${Style.RESET}\x1b[K`
      );
      spinIdx++;
    }, 200);

    let results: WorkerResult[];
    try {
      const workerPromises = WORKER_ROLES.map(({ id }) => {
        const outputFile = path.join(refinementDir, `analysis_${id}.md`);
        const prompt = buildWorkerPrompt(id, prdContent, outputFile, workingDir, cycle, previousAnalyses);

        return spawnWorker(id, prompt, refinementDir, extensionRoot, timeout, workingDir, maxTurns, cycle, (result) => {
          statuses.set(id, result.success ? '✅' : '❌');
        });
      });

      results = await Promise.all(workerPromises);
    } finally {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K\n');
    }

    // Archive cycle results (copy analysis files to cycle-specific names)
    if (cycles > 1) {
      for (const { id } of WORKER_ROLES) {
        const canonical = path.join(refinementDir, `analysis_${id}.md`);
        const cycleArchive = path.join(refinementDir, `analysis_${id}_c${cycle}.md`);
        if (fs.existsSync(canonical)) {
          try { fs.copyFileSync(canonical, cycleArchive); } catch { /* best-effort */ }
        }
      }
    }

    allCycleResults.push(results);

    const cycleSuccess = results.every((r) => r.success);
    if (cycles > 1) {
      const statusLine = results.map((r) => `${r.roleId}: ${r.success ? '✅' : '❌'}`).join(' | ');
      console.log(`   ${Style.DIM}Cycle ${cycle}: ${statusLine}${Style.RESET}`);
    }

    // If all workers failed this cycle, don't bother with more cycles
    if (results.every((r) => !r.success)) {
      console.log(`${Style.YELLOW}⚠️  All workers failed in cycle ${cycle} — skipping remaining cycles.${Style.RESET}`);
      break;
    }
  }

  if (allCycleResults.length === 0) {
    console.error(`${Style.RED}❌ No cycles completed${Style.RESET}`);
    process.exit(1);
  }

  const finalResults = allCycleResults[allCycleResults.length - 1];
  const allSuccess = finalResults.every((r) => r.success);

  printMinimalPanel(
    'Refinement Team Complete',
    Object.fromEntries(
      finalResults.map((r) => [r.roleId, r.success ? '✅ analysis written' : '❌ failed — check log'])
    ),
    allSuccess ? 'GREEN' : 'YELLOW',
    '🥒'
  );

  // Build manifest with cycle info
  const manifest = {
    prd_path: prdPath,
    refinement_dir: refinementDir,
    all_success: allSuccess,
    cycles_requested: cycles,
    cycles_completed: allCycleResults.length,
    max_turns_per_worker: maxTurns,
    workers: finalResults.map((r) => {
      const outputFile = path.join(refinementDir, `analysis_${r.roleId}.md`);
      return {
        role: r.roleId,
        success: r.success,
        output_file: outputFile,
        exists: fs.existsSync(outputFile),
        log_file: r.logPath,
        cycle: r.cycle,
      };
    }),
    completed_at: new Date().toISOString(),
  };
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  const manifestTmp = manifestPath + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manifestTmp, manifestPath);
  } catch (err) {
    try { fs.unlinkSync(manifestTmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }

  if (!allSuccess) {
    const failed = finalResults.filter((r) => !r.success).map((r) => r.roleId);
    console.log(
      `${Style.YELLOW}⚠️  Workers failed: ${failed.join(', ')}. Synthesis will proceed with available analyses.${Style.RESET}`
    );
  }

  // Machine-readable output for command parsing
  process.stdout.write(`REFINEMENT_DIR=${refinementDir}\n`);
  process.stdout.write(`MANIFEST=${manifestPath}\n`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-refinement-team.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}❌ Fatal: ${msg}${Style.RESET}`);
    process.exit(1);
  });
}
