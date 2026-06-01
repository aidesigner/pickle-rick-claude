import * as fs from 'fs';
import * as path from 'path';
import { VALID_ACTIVITY_EVENTS, ActivityEventType, BACKENDS, Backend } from '../types/index.js';
import { isBackend } from '../services/backend-spawn.js';
import { logActivity } from '../services/activity-logger.js';
import { safeErrorMessage } from '../services/pickle-utils.js';

const USAGE = `Usage: log-activity <event_type> "<title>" [--gate-payload <json-object>] [--backend <name>]
Valid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`;

type ActivitySchemaDefinition = {
  required?: unknown;
  properties?: Record<string, unknown>;
};

let schemaDefinitionsCache: Record<string, ActivitySchemaDefinition> | null = null;

function parseGatePayload(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.error(`--gate-payload is not valid JSON: ${safeErrorMessage(err)}`);
    process.exit(1);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('--gate-payload must be a JSON object (not array, not null, not scalar).');
    process.exit(1);
  }
  return parsed as Record<string, unknown>;
}

function parseBackend(value: string): Backend {
  if (!isBackend(value)) {
    console.error(`--backend must be one of: ${BACKENDS.join(', ')} (got "${value}").`);
    process.exit(1);
  }
  return value;
}

function loadSchemaDefinitions(): Record<string, ActivitySchemaDefinition> {
  if (schemaDefinitionsCache) return schemaDefinitionsCache;
  const candidates = [
    new URL('../src/types/activity-events.schema.json', import.meta.url),
    new URL('../activity-events.schema.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const p = candidate.pathname;
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { definitions?: Record<string, ActivitySchemaDefinition> };
      schemaDefinitionsCache = parsed.definitions ?? {};
      return schemaDefinitionsCache;
    } catch {
      // try next candidate
    }
  }
  console.error('Failed to load activity schema: no candidate path resolved — validation skipped');
  schemaDefinitionsCache = {};
  return schemaDefinitionsCache;
}

function asRequiredFields(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function validateCliPayloadShape(
  eventType: ActivityEventType,
  payload: Record<string, unknown>,
  gatePayload: Record<string, unknown> | undefined,
): void {
  const definition = loadSchemaDefinitions()[eventType];
  if (!definition) return;

  const missingTopLevel = asRequiredFields(definition.required)
    .filter((field) => !(field in payload));
  if (missingTopLevel.length > 0) {
    console.error(`Event "${eventType}" requires CLI-backed fields: ${missingTopLevel.join(', ')}.`);
    process.exit(1);
  }

  const gatePayloadSchema = definition.properties?.gate_payload;
  if (!gatePayloadSchema || typeof gatePayloadSchema !== 'object' || gatePayloadSchema === null) return;

  const missingGatePayload = asRequiredFields((gatePayloadSchema as ActivitySchemaDefinition).required)
    .filter((field) => !gatePayload || !(field in gatePayload));
  if (missingGatePayload.length > 0) {
    console.error(`Event "${eventType}" requires gate_payload keys: ${missingGatePayload.join(', ')}.`);
    process.exit(1);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'log-activity.js') {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let gatePayload: Record<string, unknown> | undefined;
  let backend: Backend | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--gate-payload') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--gate-payload requires a JSON-object value.');
        process.exit(1);
      }
      gatePayload = parseGatePayload(next);
      i++;
    } else if (arg === '--backend') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--backend requires a value.');
        process.exit(1);
      }
      backend = parseBackend(next);
      i++;
    } else {
      positional.push(arg);
    }
  }

  const [eventType, rawTitle] = positional;

  if (!eventType || eventType.startsWith('--')) {
    console.error(USAGE);
    process.exit(1);
  }

  if (!VALID_ACTIVITY_EVENTS.includes(eventType as ActivityEventType)) {
    console.error(`Unknown event type "${eventType}". Valid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`);
    process.exit(1);
  }

  if (!rawTitle || rawTitle.startsWith('--')) {
    console.error('Title is required and must not start with "--".');
    process.exit(1);
  }

  // Strip all control characters (C0/C1) and ANSI escape sequences
  const title = rawTitle.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);

  if (title.trim().length === 0) {
    console.error('Title must not be empty after sanitization.');
    process.exit(1);
  }

  const payload = {
    event: eventType as ActivityEventType,
    ts: new Date().toISOString(),
    title,
    source: 'persona' as const,
    ...(gatePayload ? { gate_payload: gatePayload } : {}),
    ...(backend ? { backend } : {}),
  };
  validateCliPayloadShape(eventType as ActivityEventType, payload, gatePayload);

  try {
    logActivity(payload);
  } catch (err) {
    console.error(`Failed to log activity: ${safeErrorMessage(err)}`);
    process.exit(1);
  }
}
