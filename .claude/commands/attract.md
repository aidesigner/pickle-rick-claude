Submit a `.dot` pipeline to the attractor server for execution.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

> **Tip:** Need a `.dot` file from a PRD? Run `/pickle-dot` first.

## Step 1: Acquire Pipeline

From `$ARGUMENTS`:
- File path (contains `/` or `.dot`) → use as DOT file
- Empty → look for the most recently modified `.dot` file in the current directory and Pickle Rick session root. If multiple found, present choices. If none, ask user.

Resolve to absolute path. Verify it exists:
```bash
test -f "$DOT_FILE" && echo "OK: $DOT_FILE" || echo "ERROR: not found"
```

## Step 2: Validate Locally

Find attractor and validate before submitting:

```bash
ATTRACTOR_ROOT="${ATTRACTOR_ROOT:-$(find ~/loanlight -maxdepth 2 -type f -name "cli.ts" -path "*/packages/attractor/src/cli.ts" 2>/dev/null | head -1 | sed 's|/packages/attractor/src/cli.ts||')}"
echo "ATTRACTOR_ROOT=$ATTRACTOR_ROOT"
```

```bash
cd "$ATTRACTOR_ROOT" && bun packages/attractor/src/cli.ts validate "$DOT_FILE"
```

- Errors → show diagnostics, **stop**.
- Warnings → show them, continue.

## Step 3: Check Server

```bash
ATTRACTOR_URL="${ATTRACTOR_URL:-http://localhost:7777}"
curl -sf "$ATTRACTOR_URL/health" | jq .
```

If the server is unreachable:
1. Check if Docker is running: `docker compose -f "$ATTRACTOR_ROOT/docker-compose.yml" ps`
2. Offer to start it: `cd "$ATTRACTOR_ROOT" && docker compose up -d`
3. Wait up to 15s for health check to pass, polling every 2s
4. If still unreachable after 15s, report error and suggest running locally with `/pickle-portal`

## Step 4: Submit Pipeline

Read the DOT file and submit via HTTP:

```bash
DOT_CONTENT=$(cat "$DOT_FILE")
PIPELINE_ID=$(curl -sf -X POST "$ATTRACTOR_URL/pipelines" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ATTRACTOR_API_KEY:-}" \
  -d "$(jq -n --arg dot "$DOT_CONTENT" '{dot: $dot}')" \
  | jq -r '.id')
echo "PIPELINE_ID=$PIPELINE_ID"
```

If submission fails, show the error response and stop.

Track the pipeline ID for the monitor dashboard:
```bash
echo "$PIPELINE_ID" >> /tmp/attractor-monitor-pipelines.txt
```

## Step 5: Monitor Execution

Report the submission, then poll for status every 5s until completion:

```bash
POLL_TIMEOUT="${POLLING_TIMEOUT:-3600}"
POLL_START=$(date +%s)
while true; do
  STATUS_JSON=$(curl -sf "$ATTRACTOR_URL/pipelines/$PIPELINE_ID" -H "x-api-key: ${ATTRACTOR_API_KEY:-}")
  STATUS=$(echo "$STATUS_JSON" | jq -r '.status')
  ELAPSED=$(( $(date +%s) - POLL_START ))
  echo "$(date +%H:%M:%S) Status: $STATUS (${ELAPSED}s elapsed)"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$STATUS_JSON" | jq .
    break
  fi
  if [ "$POLL_TIMEOUT" -gt 0 ] && [ "$ELAPSED" -ge "$POLL_TIMEOUT" ]; then
    echo "⏱ Polling timeout (${POLL_TIMEOUT}s) exceeded. Pipeline ID: $PIPELINE_ID"
    echo "Resume monitoring: curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID | jq ."
    break
  fi
  sleep 5
done
```

While polling, also check for pending human gate questions:
```bash
QUESTION=$(curl -sf "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/question" -H "x-api-key: ${ATTRACTOR_API_KEY:-}")
if echo "$QUESTION" | jq -e '.questionId' > /dev/null 2>&1; then
  QID=$(echo "$QUESTION" | jq -r '.questionId')
  PROMPT=$(echo "$QUESTION" | jq -r '.prompt // .label // "Approve?"')
  OPTIONS=$(echo "$QUESTION" | jq -r '.options // empty')
  # Present to user and ask for their answer
fi
```

When a human gate is detected:
1. Show the gate prompt and options to the user
2. Ask for their response
3. Submit the answer:
```bash
curl -sf -X POST "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/questions/$QID/answer" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ATTRACTOR_API_KEY:-}" \
  -d "$(jq -n --arg value "$ANSWER" '{value: $value}')"
```

## Step 6: Report Results

When the pipeline completes or fails:

1. **Status**: completed or failed
2. **Pipeline ID**: full UUID + short form
3. **Duration**: from submission to completion
4. Fetch final context: `curl -sf "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/context" -H "x-api-key: ${ATTRACTOR_API_KEY:-}" | jq .`

If failed, suggest:
- Check logs in the monitor: `./scripts/monitor.sh`
- View events: `curl -sN $ATTRACTOR_URL/pipelines/$PIPELINE_ID/events`
- Resume from checkpoint (if available): `curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID/checkpoint`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATTRACTOR_URL` | `http://localhost:7777` | Server URL |
| `ATTRACTOR_API_KEY` | _(unset)_ | API key if server auth is enabled |
| `ATTRACTOR_ROOT` | _(auto-detected)_ | Path to attractor repo root |
| `POLLING_TIMEOUT` | `3600` | Polling timeout in seconds (0 = unlimited) |
