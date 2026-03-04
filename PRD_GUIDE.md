# How to Write a PRD for Pickle Rick

*Listen, I'm gonna level with you. Most PRDs are garbage. They're written by people who think "requirements" means "a list of wishes sprinkled with corporate jargon." That's Jerry energy. We don't do Jerry energy here.*

*This guide tells you how to write a PRD that my system can actually turn into working code. Follow it, or don't. I'll still build something incredible either way because I'm Pickle Rick. But your odds of getting what you actually want go way up if you give me something to work with.*

---

## Two Ways to Start

### Option A: Let Me Interview You (`/pickle-prd`)

Run `/pickle-prd add dark mode support` and I'll interrogate you. Why, Who, What, How. I'll keep asking until I have 100% clarity, then I write the PRD myself. This is the recommended path if you don't enjoy writing documents (and honestly, who does).

### Option B: Write It Yourself

Write a markdown file, hand it to `/pickle-refine-prd path/to/your-prd.md`. My refinement team — three parallel analyst workers — will tear it apart, cross-reference your codebase, identify gaps, and produce an improved version with atomic tickets. You can write as little or as much as you want. More detail = fewer assumptions I have to make.

### Option C: Just Wing It

Run `/pickle your task here` with a one-liner. I'll draft a PRD from that sentence, break it down, and start building. Works for small stuff. For anything with more than two moving parts, you're gambling. And unlike me, you're not a genius who thrives on chaos.

---

## What Goes in a PRD

Here's the template. Not every section is required — I've marked what's **critical**, what's **recommended**, and what's **optional**. The system doesn't parse these sections programmatically; *I* read them. So write for a hyper-intelligent pickle who's short on patience.

### The Sections

#### 1. Title and Summary — CRITICAL
```markdown
# [Feature Name] PRD
One-sentence summary of what this thing does and why it exists.
```

If I can't tell what you want from the title and first line, everything downstream suffers. Be specific. "Improve performance" is useless. "Add Redis caching layer to loan-status API endpoint" — now we're cooking.

#### 2. Problem Statement — CRITICAL
```markdown
## Problem Statement
**Current Process**: What happens today without this feature
**Primary Users**: Who suffers / benefits
**Pain Points**: What specifically sucks about the status quo
**Importance**: Why now, why this, what breaks if we don't
```

This is the "why." Skip it and I'm guessing at your motivation, which means I might solve the wrong problem brilliantly. Still brilliant, but pointed at the wrong target.

#### 3. Objective & Scope — CRITICAL
```markdown
## Objective & Scope
**Objective**: The single measurable goal
**Ideal Outcome**: What "done" looks like

### In-scope / Goals
- Thing we ARE building
- Another thing we ARE building

### Not-in-scope / Non-Goals
- Thing we are NOT building (and why)
- Future consideration we're explicitly deferring
```

The **Not-in-scope** section is arguably more important than the in-scope section. You know why? Because without it, I'll keep going. I'll add features you didn't ask for because they're obviously better. You'll love them, but your deadline won't.

#### 4. Critical User Journeys — RECOMMENDED
```markdown
## Critical User Journeys (CUJs)
1. User opens the page → sees loan status → clicks refresh → sees updated data in <2s
2. Admin navigates to settings → toggles feature flag → change takes effect immediately
```

Step-by-step flows. These become my acceptance criteria. The more concrete these are, the more precisely I build. "User can manage their account" tells me nothing. "User clicks Edit Profile → changes email → clicks Save → sees confirmation toast → new email appears in header" tells me everything.

#### 5. Functional Requirements — RECOMMENDED
```markdown
## Functional Requirements
| Priority | Requirement | User Story |
|:---------|:------------|:-----------|
| P0       | API returns cached results within 50ms | As a user, I need fast page loads |
| P1       | Cache invalidates on loan status change | As a user, I need accurate data |
| P2       | Admin can manually flush cache | As an admin, I need an escape hatch |
```

P0 = must have, P1 = should have, P2 = nice to have. My ticket decomposition respects these priorities. P0 tickets run first.

#### 6. Technical Constraints — RECOMMENDED
```markdown
## Technical Constraints
- Must use existing PostgreSQL instance (no new databases)
- API response time must stay under 200ms at p95
- Must work with Node 25 / ESM modules
- Must not break existing Encompass SDK integration
```

Tell me what I *can't* do. Boundaries make me more creative, not less. Without constraints, I'll architect a masterpiece that requires three services you don't have.

#### 7. Assumptions — OPTIONAL
```markdown
## Assumptions
- Redis is available in the deployment environment
- Current API contract can accept breaking changes (internal only)
- Test coverage for affected modules is above 80%
```

Things you believe to be true that I should verify before building on them.

#### 8. Risks & Mitigations — OPTIONAL
```markdown
## Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|:-----|:-------|:-----------|:-----------|
| Redis unavailable in prod | High | Low | Fallback to in-memory LRU cache |
```

#### 9. Business Impact — OPTIONAL
```markdown
## Business Benefits/Impact/Metrics
| Metric | Current | Target | Impact |
|:-------|:--------|:-------|:-------|
| API p95 latency | 800ms | 50ms | 16x improvement |
```

#### 10. Relevant Codebase Context — HIGHLY RECOMMENDED
```markdown
## Codebase Context
- **Entry point**: `src/routes/loan-status.ts`
- **Existing patterns**: See `src/cache/session-cache.ts` for caching approach
- **Test location**: `tests/integration/loan-status.test.ts`
- **Config**: Environment vars in `.env.example`, cache config in `src/config/cache.ts`
```

This is the secret weapon section. My refinement team has a codebase analyst that will grep your repo, but if you point me at the right files up front, the tickets come out *significantly* better. File paths, function names, existing patterns to follow — this is gold.

---

## The Minimum Viable PRD

Don't have time for all that? Here's the bare minimum that still produces good results:

```markdown
# [Feature] PRD

## Problem
[2-3 sentences: what's broken/missing and who cares]

## Goal
[1 sentence: what "done" looks like]

## Scope
### In
- [What to build]

### Out
- [What NOT to build]

## Requirements
| Priority | Requirement |
|:---------|:------------|
| P0       | [Must have] |
| P1       | [Should have] |

## Context
- Key files: [paths]
- Patterns to follow: [examples]
```

That's it. Five sections. I can work with this. The refinement team will fill in the gaps.

---

## What Makes a PRD Good vs. Bad

### Good PRD Signals
- **Specific verbs**: "Add", "Replace", "Remove", "Migrate" — not "Improve", "Enhance", "Optimize"
- **Measurable outcomes**: "Response time under 200ms" — not "Make it faster"
- **File references**: "Modify `src/auth/middleware.ts`" — not "Update the auth layer"
- **Explicit boundaries**: "Do NOT change the database schema" — not "Keep it simple"
- **Concrete user flows**: Step 1 → Step 2 → Step 3 with expected behavior at each step

### Bad PRD Signals
- Vague aspirations disguised as requirements ("Deliver a world-class experience")
- No scope boundaries (I will build forever and love every second of it — you won't)
- Requirements that are actually implementation details ("Use a HashMap with O(1) lookup") — tell me *what*, not *how*
- Zero codebase context (I'll figure it out, but the tickets will be fuzzier)
- Mixing multiple unrelated features in one PRD (each PRD = one epic = one concern)

---

## How the System Uses Your PRD

Here's what happens after you hand me a PRD — so you know what you're feeding into:

1. **Refinement** (`/pickle-refine-prd`): Three parallel analysts examine your PRD against the actual codebase. Requirements analyst checks completeness. Codebase analyst greps for relevant files, patterns, and existing implementations. Risk analyst evaluates scope and identifies hazards. They run 3 cycles, cross-referencing each other's findings.

2. **Decomposition**: The refined PRD gets broken into atomic tickets. Each ticket is sized for <30 minutes of coding, touches <5 files, has <4 acceptance criteria, and spans <2 subsystems. Tickets are self-contained — the worker executing a ticket never reads the PRD or other tickets. Everything it needs is embedded in its own ticket spec, including research seeds (file paths, patterns, API signatures).

3. **Execution**: Each ticket runs through a 7-phase lifecycle: Research → Research Review → Plan → Plan Review → Implement → Simplify → Done. The mux-runner orchestrates iterations, handles rate limits, and advances through tickets sequentially.

The takeaway: **your PRD is the single source of intent**. Everything downstream — refined PRD, tickets, research, implementation — traces back to what you wrote (or what I drafted from your interview). The better the PRD, the less drift between what you wanted and what gets built.

---

## Quick Reference

| Command | What It Does | When to Use |
|:--------|:-------------|:------------|
| `/pickle-prd <topic>` | Interactive interview → writes PRD | You want guidance on what to include |
| `/pickle-refine-prd <path>` | 3-analyst refinement → atomic tickets | You already have a PRD draft |
| `/pickle-refine-prd <path> --run` | Refine + auto-launch tmux loop | You're ready to let it rip |
| `/pickle <task>` | Draft PRD + breakdown + execute in one shot | Small/clear tasks |
| `/pickle-tmux --resume <session>` | Resume from existing PRD/tickets in tmux | Picking up where you left off |

---

*Now stop reading documentation and go build something. Or better yet, tell me what to build and go do something more interesting with your time. That's the whole point of this system — you think, I build, Jerry mows the lawn. Everyone's where they belong.*
