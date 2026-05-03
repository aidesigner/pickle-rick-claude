# Section C.0 PRECHECK: PostToolUseFailure Hook

Verdict: EXISTS

## Decision

`PostToolUseFailure` is a real Claude Code hook event. The current official Claude Code hooks reference lists it between `PostToolUse` and `PostToolBatch`. `https://code.claude.com/docs/en/hooks:90`

The official hook event table distinguishes the success and failure hooks: `PostToolUse` fires after a tool call succeeds, and `PostToolUseFailure` fires after a tool call fails. `https://code.claude.com/docs/en/hooks:198`

The official `PostToolUseFailure` event section says it runs after tool execution fails, including thrown errors and failure results. `https://code.claude.com/docs/en/hooks:1295`

The official input schema for the event includes `hook_event_name: "PostToolUseFailure"` plus tool identity, input, tool use id, error, interrupt flag, and duration fields. `https://code.claude.com/docs/en/hooks:1302`

The official decision-control section says `PostToolUseFailure` hooks can add context for Claude after a tool failure via `additionalContext`. `https://code.claude.com/docs/en/hooks:1325`

## Local Harness Check

The local PRD already names `PostToolUseFailure` as the intended hook architecture for intra-session retry tracking. `prds/tool-error-retry-tracking.md:11`

The PRD's hook input contract uses `hook_event_name: 'PostToolUseFailure'`, matching the official event name. `prds/tool-error-retry-tracking.md:81`

The local dispatcher does not maintain a fixed hook-event enum; it reads the handler name from `process.argv`, rejects path traversal, and maps that argument to a handler file. `extension/src/hooks/dispatch.ts:63`

The local dispatcher forwards stdin to the selected handler and parses only `decision: 'approve'` or `decision: 'block'` from handler stdout. `extension/src/hooks/dispatch.ts:137`

The installed Claude settings currently configure `Stop`, `PostToolUse`, and `PreToolUse`, but they do not configure `PostToolUseFailure`. `/Users/gregorydickson/.claude/settings.json:13`

The Codex runtime validation list currently includes `SessionStart`, `Stop`, `PreToolUse`, and `PostToolUse`; it does not list `PostToolUseFailure`. `/Users/gregorydickson/.codex/pickle-rick/config.json:26`

The Codex validation document says hook usage is gated by local validation of the installed build. `/Users/gregorydickson/.codex/pickle-rick/docs/codex-api-validation.md:9`

## Consequence

Section C.1/C.2 may proceed using the existing `PostToolUseFailure` name; the ticket only requires a PRD amendment when the verdict is `RENAME`. `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/23a6dc03/linear_ticket_23a6dc03.md:31`
