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
  workingDir: string
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

  const outputInstructions = `## Your Output

Write ALL findings to this file: ${outputFile}

Use this EXACT structure:

\`\`\`markdown
# PRD Analysis: [Your Role Name]

**Date**: [Today's date]
**Analyst**: [Your Role Name]

## Executive Summary
[2-3 sentence overview of the PRD's quality in your domain. Be specific — not "needs improvement" but "missing 3 P0 CUJs and acceptance criteria for all requirements".]

## Critical Gaps (P0 — Must Fix)
- **[Gap Title]**: [Specific description with PRD section reference]. [Why this is critical.]

## Important Gaps (P1 — Should Fix)
- **[Gap Title]**: [Specific description]. [Impact if ignored.]

## Minor Issues (P2 — Nice to Fix)
- [Brief description]

## Specific Recommendations
[Concrete, actionable suggestions. For P0 gaps, provide example language the PRD author can paste in.]
\`\`\`

After writing the file, output: <promise>ANALYSIS_DONE</promise>
Then STOP IMMEDIATELY. Do not attempt to rewrite the PRD.`;

  return `${persona}

${roleInstructions[roleId]}

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
}

function spawnWorker(
  roleId: RoleId,
  prompt: string,
  refinementDir: string,
  extensionRoot: string,
  timeout: number,
  workingDir: string,
  onComplete: (result: WorkerResult) => void
): Promise<WorkerResult> {
  const logPath = path.join(refinementDir, `worker_${roleId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  // Mirror spawn-morty.ts: include extensionRoot and workingDir
  const includes = [extensionRoot, workingDir];
  const cmdArgs = ['-s', '-y'];
  for (const p of includes) {
    if (fs.existsSync(p)) {
      cmdArgs.push('--include-directories', p);
    }
  }
  cmdArgs.push('-p', prompt);

  const proc = spawn('claude', cmdArgs, {
    cwd: workingDir,
    env: { ...process.env, PICKLE_ROLE: 'refinement-worker', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  // SIGTERM first, escalate to SIGKILL after 2s if still alive
  const timeoutHandle = setTimeout(() => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 2000);
  }, timeout * 1000);

  return new Promise<WorkerResult>((resolve, reject) => {
    proc.on('error', reject);

    proc.on('close', () => {
      clearTimeout(timeoutHandle);
      logStream.end();

      // Wait for the write stream to fully flush before reading the log
      logStream.on('finish', () => {
        const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        const success = logContent.includes('<promise>ANALYSIS_DONE</promise>');
        const result: WorkerResult = { roleId, success, logPath };
        onComplete(result);
        resolve(result);
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const prdIndex = args.indexOf('--prd');
  const sessionIndex = args.indexOf('--session-dir');
  const timeoutIndex = args.indexOf('--timeout');

  const prdPath = prdIndex !== -1 ? args[prdIndex + 1] : undefined;
  const sessionDir = sessionIndex !== -1 ? args[sessionIndex + 1] : undefined;

  // Fix #1: Validate all required args are present and non-empty
  if (!prdPath || !sessionDir || prdPath.startsWith('--') || sessionDir.startsWith('--')) {
    console.error(
      `${Style.RED}❌ Usage: node spawn-refinement-team.js --prd <path> --session-dir <dir> [--timeout <sec>]${Style.RESET}`
    );
    process.exit(1);
  }

  if (!fs.existsSync(prdPath)) {
    console.error(`${Style.RED}❌ PRD not found: ${prdPath}${Style.RESET}`);
    process.exit(1);
  }

  // Fix #10: Respect worker_timeout_seconds from session state (mirrors spawn-morty.ts)
  const rawTimeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1], 10) : NaN;
  let timeout = !isNaN(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600;
  const statePath = path.join(sessionDir, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (timeoutIndex === -1 && state.worker_timeout_seconds) {
        timeout = Number(state.worker_timeout_seconds) || timeout;
      }
      // Clamp to remaining session time if a wall-clock limit is set
      const maxMins = state.max_time_minutes || 0;
      const startEpoch = state.start_time_epoch || 0;
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
  const extensionRoot = getExtensionRoot();
  const refinementDir = path.join(sessionDir, 'refinement');

  // Fix #6: Wrap mkdirSync
  try {
    fs.mkdirSync(refinementDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${Style.RED}❌ Failed to create refinement dir: ${msg}${Style.RESET}`);
    process.exit(1);
  }

  const prdContent = fs.readFileSync(prdPath, 'utf-8');

  printMinimalPanel(
    'PRD Refinement Team Deploying',
    {
      PRD: path.basename(prdPath),
      Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
      Timeout: `${timeout}s each`,
      Output: refinementDir,
    },
    'MAGENTA',
    '🥒'
  );

  // Track statuses for live display
  const statuses = new Map<RoleId, '⏳' | '✅' | '❌'>(
    WORKER_ROLES.map((r) => [r.id, '⏳' as const])
  );

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinIdx = 0;
  const startTime = Date.now();

  // Fix #5: Guarantee interval cleanup even if workers throw
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinChar = spinner[spinIdx % spinner.length];
    const statusParts = WORKER_ROLES.map((r) => `${statuses.get(r.id)} ${r.id}`).join(' | ');
    process.stdout.write(
      `\r   ${Style.CYAN}${spinChar}${Style.RESET} ${statusParts} ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`
    );
    spinIdx++;
  }, 200);

  let results: WorkerResult[];
  try {
    const workerPromises = WORKER_ROLES.map(({ id }) => {
      const outputFile = path.join(refinementDir, `analysis_${id}.md`);
      const prompt = buildWorkerPrompt(id, prdContent, outputFile, workingDir);

      return spawnWorker(id, prompt, refinementDir, extensionRoot, timeout, workingDir, (result) => {
        statuses.set(id, result.success ? '✅' : '❌');
      });
    });

    results = await Promise.all(workerPromises);
  } finally {
    clearInterval(interval);
    process.stdout.write('\r\x1b[K\n');
  }

  const allSuccess = results.every((r) => r.success);

  printMinimalPanel(
    'Refinement Team Complete',
    Object.fromEntries(
      results.map((r) => [r.roleId, r.success ? '✅ analysis written' : '❌ failed — check log'])
    ),
    allSuccess ? 'GREEN' : 'YELLOW',
    '🥒'
  );

  // Fix #9: Include exists flag so command can detect missing output files
  const manifest = {
    prd_path: prdPath,
    refinement_dir: refinementDir,
    all_success: allSuccess,
    workers: results.map((r) => {
      const outputFile = path.join(refinementDir, `analysis_${r.roleId}.md`);
      return {
        role: r.roleId,
        success: r.success,
        output_file: outputFile,
        exists: fs.existsSync(outputFile),
        log_file: r.logPath,
      };
    }),
    completed_at: new Date().toISOString(),
  };
  const manifestPath = path.join(sessionDir, 'refinement_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (!allSuccess) {
    const failed = results.filter((r) => !r.success).map((r) => r.roleId);
    console.log(
      `${Style.YELLOW}⚠️  Workers failed: ${failed.join(', ')}. Synthesis will proceed with available analyses.${Style.RESET}`
    );
  }

  // Machine-readable output for command parsing
  process.stdout.write(`REFINEMENT_DIR=${refinementDir}\n`);
  process.stdout.write(`MANIFEST=${manifestPath}\n`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${Style.RED}❌ Fatal: ${msg}${Style.RESET}`);
  process.exit(1);
});
