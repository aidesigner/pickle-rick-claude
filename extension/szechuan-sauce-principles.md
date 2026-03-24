# Szechuan Sauce Principles Reference

Distilled coding principles for iterative deslopping. Workers read this each iteration to identify violations. Judges score against it.

Based on [Theta-Tech-AI/deslop](https://github.com/Theta-Tech-AI/llm-public-utils/blob/production/slash_commands/deslop.md).

## Quick Diagnostic Guide

| Symptom | Principle | Quick Fix |
|---------|-----------|-----------|
| Function > 50 lines | Small Functions | Extract named helpers |
| Deep nesting (3+ levels) | Guard Clauses, Cognitive Load | Early returns |
| Copy-pasted code (3+ times) | DRY | Extract shared function |
| Magic numbers/strings | Self-Documenting Code | Named constants |
| Class doing many things | SRP, Separation of Concerns | Split by responsibility |
| Long parameter lists (5+) | Encapsulation | Parameter object |
| `a.b().c().d()` chains | Law of Demeter | Delegate to intermediate |
| Speculative features | YAGNI | Delete until needed |
| Comments explaining "what" | Self-Documenting Code | Rename to be obvious |
| Stale/wrong comments | Documentation Discipline | Delete or fix |
| Tests require complex setup | Dependency Injection | Inject dependencies |
| Inheritance > 2 deep | Composition over Inheritance | Compose objects |
| Boolean parameters | Small Functions, KISS | Separate functions |
| Silent failures | Fail-Fast, Observability | Fail loudly, log |
| Getters exposing internals | Encapsulation | Tell, don't ask |
| Migration without rollback | Migration Safety | Add rollback script |
| Non-idempotent migration | Migration Safety | Add IF NOT EXISTS / guards |

## Principle Tensions

| Tension | Resolution |
|---------|------------|
| DRY vs. Coupling | Duplication is cheaper than wrong abstraction. Wait for Rule of Three. |
| YAGNI vs. Extensibility | Build for today, keep code malleable. Don't add extension points. |
| KISS vs. DRY | Three obvious lines beat one clever abstraction. Optimize for reader. |
| DRY vs. Clarity | Obvious > clever. If abstraction hides intent, keep duplicates. |
| Abstraction vs. Indirection | Every layer must earn its keep. Indirection without payoff is slop. |

## Priority Matrix

| Priority | Type | Examples | Fix When |
|----------|------|----------|----------|
| **P0: Critical** | Security, data loss | SQL injection, unvalidated input, race conditions | Immediately |
| **P1: High** | Bugs waiting to happen | Missing error handling, silent failures, unclear ownership | This iteration |
| **P2: Medium** | Maintainability | DRY violations (3+), god classes, deep nesting | When touching file |
| **P3: Low** | Polish | Magic numbers, naming, minor duplication | If time permits |
| **P4: Optional** | Style | Formatting, comment cleanup, minor refactors | Boy Scout Rule |

## Part I: Clean Code

### KISS (Keep It Simple, Stupid)
Avoid unnecessary complexity. Prefer the simplest solution that works. Measuring: cyclomatic complexity, nesting depth, number of concepts per function.

**Violations**: Premature abstraction, speculative generality, over-engineered patterns for simple problems, complex inheritance where composition suffices.

### YAGNI (You Aren't Gonna Need It)
Don't build features, abstractions, or infrastructure until you have a concrete, immediate need. Every unused feature has four costs: build, maintain, understand, remove.

**The Delete Test**: Can you delete this code/feature without breaking anything currently used? If yes, delete it.

### Small Functions
Functions should do one thing, do it well, and do it only. Target: 5-15 lines (hard limit: 50). Name reveals intent. One level of abstraction per function.

**Stepdown Rule**: Read the code top-to-bottom like a narrative. Each function should call functions one abstraction level below.

### Guard Clauses (Early Return)
Handle edge cases and invalid states at the top of a function, then proceed with the happy path unindented.

**When NOT to use**: Resource cleanup requiring finally blocks, complex state machines where early return would skip necessary transitions.

### Cognitive Load
Minimize the mental effort required to understand code. Three types: intrinsic (problem complexity), extraneous (accidental complexity), germane (learning).

**Target extraneous load**: reduce nesting, use consistent naming, avoid clever tricks, limit working memory demands (7 +/- 2 concepts).

### Self-Documenting Code
Names reveal purpose. Code tells how, comments tell why. Three pillars: intention-revealing names, explanatory variables, meaningful constants.

**Comment Balance**: Delete comments that restate code. Keep comments that explain WHY, warn of consequences, or mark TODOs with context.

### Elegance
Beauty through insight and minimality. Elegant code makes you say "of course" — it feels inevitable, not clever. Four criteria: minimal, clear, general, natural.

**Elegance vs. Cleverness**: If you need to explain it, it's clever, not elegant.

## Part II: Architecture

### DRY (Don't Repeat Yourself)
Every piece of knowledge must have a single, unambiguous, authoritative representation within a system. NOT about eliminating similar-looking code — it's about eliminating duplicated KNOWLEDGE.

**Rule of Three**: Don't abstract until the pattern appears 3+ times. Two occurrences might be coincidence.

**Incidental similarity is NOT duplication**: Two functions that happen to look similar but represent different concepts should NOT be merged.

### Single Source of Truth
One location for each piece of data or business rule. If you update something, you should only need to update it in one place.

### Separation of Concerns
Each component should address one well-defined concern. UI shouldn't contain business logic. Data access shouldn't format output.

### Modularity
Independent components with hidden internals. Deep modules: simple interface, complex implementation. Shallow modules (thin wrappers) are usually slop.

### Encapsulation
Bundle data with behavior, hide internals. Tell, Don't Ask: don't get data to make decisions — tell the object to do the thing.

### Law of Demeter
Only talk to immediate friends. `a.getB().getC().doThing()` is a violation. Delegate through intermediate objects.

**Exception**: Fluent APIs, builder patterns, and data transfer objects are OK.

### SOLID Principles
- **S** (SRP): One reason to change per class
- **O** (Open/Closed): Open for extension, closed for modification
- **L** (Liskov): Subtypes must be substitutable for base types
- **I** (Interface Segregation): Prefer small, specific interfaces
- **D** (Dependency Inversion): Depend on abstractions, not concretions

**When NOT to apply**: Simple scripts, glue code, prototypes. SOLID adds structure — only add structure that earns its keep.

### Composition Over Inheritance
Compose objects via has-a relationships instead of extending via is-a. Inheritance creates tight coupling and fragile base class problems.

### Command-Query Separation
Functions either return a value (query) OR change state (command), not both. Exception: stack.pop(), iterator.next() where combining is the natural interface.

## Part III: Reliability

### Fail-Fast
Detect and report errors immediately. Don't pass bad data deeper into the system. Validate at entry points, assert invariants.

### Parse, Don't Validate
Transform data into types that prove validity. Don't check a string is a valid email — parse it into an Email type. Invalid states become unrepresentable.

### Immutability
Prefer immutable data structures. Mutation is a source of bugs, especially with shared state. Copy-on-write when modification is needed.

### Idempotency
Multiple executions produce the same result as one. Critical for retry logic, event handlers, API endpoints.

### Resilience
Continue operating despite partial failures. Patterns: exponential backoff with jitter, circuit breakers, graceful degradation, bulkheads.

### Least Privilege
Minimum permissions necessary. Applies at every level: file access, API scopes, database permissions, function capabilities.

### Observability
Understand what systems do in production. Three pillars: structured logging, metrics, distributed tracing. If you can't observe it, you can't debug it.

### Migration Safety
Database migrations must be idempotent, forward-only by default, and registered in the migration journal. Every migration needs a corresponding rollback script. Never use destructive DDL (`DROP TABLE`, `DROP COLUMN`) without a data-preservation step first. Migrations must be reviewable as source files — they are code, not ops.

**Violations**: Migration not registered in journal, missing rollback script, destructive DDL without backup/copy step, non-idempotent migration (re-running it fails), migration that depends on application runtime state.

### Boy Scout Rule
Leave code better than you found it. Small, incremental improvements compound over time. NOT: rewrite everything you touch. Just: fix one thing nearby.

## Anti-Pattern Quick Reference

| Anti-Pattern | Principle Violated | Fix |
|--------------|-------------------|-----|
| God class / God function | SRP, Small Functions | Split by responsibility |
| Premature abstraction | YAGNI, KISS | Delete until 3+ uses |
| Stringly-typed data | Parse Don't Validate | Use typed structures |
| Shotgun surgery | Modularity, SoC | Consolidate related logic |
| Feature envy | Encapsulation | Move method to data owner |
| Primitive obsession | Parse Don't Validate | Domain types |
| Dead code | YAGNI | Delete it |
| Comment-heavy code | Self-Documenting | Rename, restructure |
| Deep inheritance | Composition | Compose instead |
| Boolean blindness | Self-Documenting | Use enums or named types |
| Defensive copy everywhere | Immutability | Make source immutable |
| Log and throw | Fail-Fast | Pick one |
| Catch Exception | Fail-Fast | Catch specific types |
| Silent swallow | Observability | Log or rethrow |
| DROP without backup | Migration Safety | Copy data first |
| Unregistered migration | Migration Safety | Add to journal |
