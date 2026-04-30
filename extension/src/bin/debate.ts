#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentMd } from '../services/agent-md-loader.js';
import { logActivity } from '../services/activity-logger.js';
import { resolveBackend } from '../services/backend-spawn.js';
import { isoCompactStamp } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import type { Backend, State } from '../types/index.js';
import { DEBATE_PERSONAS, type DebatePersonaName } from './generate-debate-personas.js';

const DEFAULT_PERSONAS: DebatePersonaName[] = ['researcher', 'architect', 'implementer', 'skeptic'];
const MIN_PERSONA_COUNT = 2;
const MAX_PERSONA_COUNT = 6;
const SHARED_CONTEXT_WORD_CAP = 600;
const RESPONSE_WORD_CAP = 800;
const REQUIRED_TOOLS = ['Read', 'Glob', 'Grep'];
const AUTO_PROMOTE_BANNER = '[debate] codex backend detected — auto-promoting to --solo (use --strict-teams to require parallel subagents and fail-fast on codex). Sequential debate starting; estimated cost: $0.40, est. wall-clock: 90s. Continue? [Y/n]';
const STRICT_TEAMS_CODEX_ERROR = 'debate: --strict-teams requires claude backend; current: codex; remove --strict-teams to allow auto-promote, or switch backend';

export interface DebateArgs {
  sessionDir: string;
  repoRoot: string;
  question: string;
  personas: DebatePersonaName[];
  n: number;
  solo: boolean;
  strictTeams: boolean;
  noStrictTeams: boolean;
  continueDebate: boolean;
  acceptStale: boolean;
  dryRun: boolean;
  agentsDir?: string;
}

export interface DebateRunOptions {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  now?: () => Date;
  stateManager?: StateManager;
  logActivityFn?: typeof logActivity;
  confirmAutoPromote?: (banner: string) => boolean;
}

export interface DebateRunResult {
  exitCode: number;
  briefPath: string;
  brief: string;
  mode: DebateMode;
}

type DebateMode = 'teams' | 'solo' | 'solo (auto)';

interface ResolvedDebateRun {
  args: DebateArgs;
  backend: Backend;
  mode: DebateMode;
  declinedAutoPromote: boolean;
}

interface LoadedDebateState {
  state: State | null;
  statePath: string;
}

interface ValidatedDebateAgent {
  persona: DebatePersonaName;
  agentName: string;
  sourcePath: string;
}

function usage(): never {
  process.stderr.write('Usage: node debate.js "<question>" --session-dir <dir> [--repo-root <dir>] [--personas r,a,i,s] [--n <2-6>] [--solo] [--strict-teams] [--no-strict-teams] [--continue] [--accept-stale] [--dry-run]\n');
  process.exit(1);
}

export function parseArgs(argv: string[]): DebateArgs {
  const sessionDir = readFlag(argv, '--session-dir');
  if (!sessionDir) usage();

  const nValue = readFlag(argv, '--n');
  const n = nValue ? parseCount(nValue) : DEFAULT_PERSONAS.length;
  const personas = resolvePersonas(readFlag(argv, '--personas'), n);
  const question = readQuestion(argv);
  validateQuestion(question);

  return {
    sessionDir: path.resolve(sessionDir),
    repoRoot: path.resolve(readFlag(argv, '--repo-root') ?? process.cwd()),
    question,
    personas,
    n,
    solo: argv.includes('--solo'),
    strictTeams: argv.includes('--strict-teams'),
    noStrictTeams: argv.includes('--no-strict-teams'),
    continueDebate: argv.includes('--continue'),
    acceptStale: argv.includes('--accept-stale'),
    dryRun: argv.includes('--dry-run'),
    agentsDir: readFlag(argv, '--agents-dir'),
  };
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

function flagTakesValue(flag: string): boolean {
  return ['--session-dir', '--repo-root', '--personas', '--n', '--agents-dir'].includes(flag);
}

function readQuestion(argv: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      if (flagTakesValue(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values.join(' ').trim();
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('--n must be an integer from 2 to 6.');
  const count = Number(value);
  if (count < MIN_PERSONA_COUNT || count > MAX_PERSONA_COUNT) {
    throw new Error('--n must be an integer from 2 to 6.');
  }
  return count;
}

function validateQuestion(question: string): void {
  if (question.length === 0) throw new Error('Debate question is required.');
}

function resolvePersonas(csv: string | undefined, n: number): DebatePersonaName[] {
  if (!csv) {
    if (n > DEFAULT_PERSONAS.length) {
      throw new Error(`Only ${DEFAULT_PERSONAS.length} debate personas are available in this build.`);
    }
    return DEFAULT_PERSONAS.slice(0, n);
  }

  const aliases = new Map<string, DebatePersonaName>([
    ['r', 'researcher'],
    ['a', 'architect'],
    ['i', 'implementer'],
    ['s', 'skeptic'],
    ['researcher', 'researcher'],
    ['architect', 'architect'],
    ['implementer', 'implementer'],
    ['skeptic', 'skeptic'],
  ]);
  const seen = new Set<DebatePersonaName>();
  const personas: DebatePersonaName[] = [];
  for (const item of csv.split(',')) {
    const persona = aliases.get(item.trim().toLowerCase());
    if (!persona) throw new Error(`Unknown debate persona: ${item.trim()}`);
    if (!seen.has(persona)) {
      seen.add(persona);
      personas.push(persona);
    }
  }
  if (personas.length < MIN_PERSONA_COUNT) {
    throw new Error(`At least ${MIN_PERSONA_COUNT} debate personas are required.`);
  }
  if (personas.length > n) {
    throw new Error('--personas cannot select more entries than --n.');
  }
  return personas;
}

function validateDebateAgents(args: DebateArgs): ValidatedDebateAgent[] {
  return args.personas.map((persona) => {
    const agentName = `morty-debater-${persona}`;
    const loaded = loadAgentMd(agentName, { agentsDir: args.agentsDir });
    if (!loaded) throw new Error(`Missing debate agent markdown: ${agentName}.md`);
    if (loaded.frontmatter.name !== agentName) {
      throw new Error(`Debate agent ${loaded.path} frontmatter name must be ${agentName}.`);
    }
    if (loaded.frontmatter.tools.join(',') !== REQUIRED_TOOLS.join(',')) {
      throw new Error(`Debate agent ${loaded.path} tools must be exactly Read, Glob, Grep.`);
    }
    return { persona, agentName, sourcePath: loaded.path };
  });
}

export function buildDebateBrief(args: DebateArgs, createdAt: Date, agents = validateDebateAgents(args), mode: DebateMode = args.solo ? 'solo' : 'teams'): string {
  validateQuestion(args.question);
  const personaRows = agents.map((agent) => `- ${agent.persona}: ${agent.agentName} (${agent.sourcePath})`);
  const personaTitles = args.personas
    .map((persona) => DEBATE_PERSONAS.find((definition) => definition.name === persona)?.title ?? persona)
    .join(', ');

  return [
    '# Debate Brief',
    '',
    `Generated: ${createdAt.toISOString()}`,
    `Session root: ${args.sessionDir}`,
    `Repository root: ${args.repoRoot}`,
    '',
    '## Question',
    '',
    args.question,
    '',
    '## Mode Flags',
    '',
    `- mode: ${mode}`,
    `- solo: ${args.solo}`,
    `- strict_teams: ${args.strictTeams}`,
    `- no_strict_teams: ${args.noStrictTeams}`,
    `- continue: ${args.continueDebate}`,
    `- accept_stale: ${args.acceptStale}`,
    `- n: ${args.n}`,
    '',
    '## Persona Agents',
    '',
    ...personaRows,
    '',
    '## Shared Context Budget',
    '',
    `- Cap shared context sent to each subagent at ${SHARED_CONTEXT_WORD_CAP} words.`,
    `- Cap each persona response at ${RESPONSE_WORD_CAP} words.`,
    '- Include the debate question, current repository/session paths, selected personas, and relevant prior debate context when continuing.',
    '',
    '## Orchestrator Contract',
    '',
    '- This helper only prepares the brief. It must not spawn agents, create teams, edit state, or synthesize a verdict.',
    '- The command prompt creates a debate team, dispatches selected persona agents in parallel, deletes the team, and writes the final debate markdown.',
    `- Selected personas: ${personaTitles}.`,
    '- Final output keeps one full section per persona. Synthesis is out of scope for this helper.',
    '',
  ].join('\n');
}

function loadDebateState(sessionDir: string, stateManager: StateManager): LoadedDebateState {
  const statePath = path.join(sessionDir, 'state.json');
  try {
    return { state: stateManager.read(statePath), statePath };
  } catch {
    return { state: null, statePath };
  }
}

function persistStrictTeamsFlag(statePath: string, stateManager: StateManager): void {
  stateManager.update(statePath, (state) => {
    state.flags ??= {};
    state.flags.strict_teams = true;
  });
}

function defaultConfirmAutoPromote(banner: string): boolean {
  void banner;
  if (process.stdin.isTTY) return true;
  try {
    const answer = fs.readFileSync(0, 'utf8').trim().toLowerCase();
    return answer === '' || answer.startsWith('y');
  } catch {
    return true;
  }
}

function resolveDebateRun(input: DebateArgs, opts: DebateRunOptions, out: (message: string) => void): ResolvedDebateRun {
  const stateManager = opts.stateManager ?? new StateManager();
  const { state, statePath } = loadDebateState(input.sessionDir, stateManager);
  const backend = resolveBackend(state);
  const inheritedStrictTeams = state?.flags?.strict_teams === true;
  const strictTeams = input.noStrictTeams ? false : input.strictTeams || inheritedStrictTeams;
  const args = { ...input, strictTeams };

  if (input.strictTeams && state) {
    persistStrictTeamsFlag(statePath, stateManager);
  }

  if (backend === 'codex' && strictTeams) {
    return { args, backend, mode: 'teams', declinedAutoPromote: false };
  }

  if (backend === 'codex' && !args.solo) {
    const confirm = opts.confirmAutoPromote ?? defaultConfirmAutoPromote;
    out(AUTO_PROMOTE_BANNER);
    const accepted = confirm(AUTO_PROMOTE_BANNER);
    if (!accepted) return { args, backend, mode: 'teams', declinedAutoPromote: true };
    const autoArgs = { ...args, solo: true };
    return { args: autoArgs, backend, mode: 'solo (auto)', declinedAutoPromote: false };
  }

  return { args, backend, mode: args.solo ? 'solo' : 'teams', declinedAutoPromote: false };
}

export function runDebate(input: DebateArgs, opts: DebateRunOptions = {}): DebateRunResult {
  const now = opts.now ?? (() => new Date());
  const out = opts.stdout ?? ((message: string) => process.stdout.write(`${message}\n`));
  const err = opts.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const resolved = resolveDebateRun(input, opts, out);
  if (resolved.backend === 'codex' && resolved.args.strictTeams) {
    err(STRICT_TEAMS_CODEX_ERROR);
    return { exitCode: 7, briefPath: '', brief: '', mode: resolved.mode };
  }
  if (resolved.declinedAutoPromote) {
    opts.logActivityFn?.({ event: 'debate_user_declined_auto_promote', source: 'pickle', session: path.basename(input.sessionDir) });
    return { exitCode: 1, briefPath: '', brief: '', mode: resolved.mode };
  }
  if (resolved.mode === 'solo (auto)') {
    (opts.logActivityFn ?? logActivity)({ event: 'debate_solo_auto', source: 'pickle', session: path.basename(input.sessionDir), mode: resolved.mode });
  }

  const createdAt = now();
  const briefPath = path.join(input.sessionDir, `debate_${isoCompactStamp(createdAt)}_brief.md`);
  const agents = validateDebateAgents(resolved.args);
  const brief = buildDebateBrief(resolved.args, createdAt, agents, resolved.mode);

  if (resolved.args.dryRun) {
    out(JSON.stringify({
      brief_path: briefPath,
      personas: resolved.args.personas,
      mode: resolved.mode,
      brief,
    }, null, 2));
    return { exitCode: 0, briefPath, brief, mode: resolved.mode };
  }

  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, brief, 'utf8');
  out(`BRIEF_PATH=${briefPath}`);
  return { exitCode: 0, briefPath, brief, mode: resolved.mode };
}

export function main(argv = process.argv.slice(2)): void {
  try {
    const result = runDebate(parseArgs(argv));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
