// Codex plain-text block delimiters. A line matching this regex marks the
// start of a new named block; content between a 'codex' delimiter and the
// next delimiter (or EOF) is assistant output. All other blocks are dropped.
export const CODEX_DELIMITER_RE = /^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/;

function isAssistantJsonLine(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.type === 'assistant';
  } catch {
    return false;
  }
}

/** True when the line parses as a JSON object (any `type`) — i.e. structured
 *  stream-json output, not free prose. Keeps the plain-text fallback from
 *  leaking promise tokens embedded in non-assistant JSON lines. */
function isJsonObjectLine(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function extractStreamJsonContent(lines: string[]): string[] {
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'assistant') {
        collectAssistantContent(parts, parsed.message?.content);
      } else if (parsed.type === 'result' && typeof parsed.result === 'string') {
        parts.push(parsed.result);
      }
    } catch {
      // skip non-JSON in stream-json mode
    }
  }
  return parts;
}

function collectAssistantContent(parts: string[], content: unknown): void {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return;
  }
  if (typeof content === 'string') {
    parts.push(content);
  }
}

function extractCodexBlockContent(lines: string[]): string[] {
  const parts: string[] = [];
  let inCodexBlock = false;
  for (const line of lines) {
    if (CODEX_DELIMITER_RE.test(line)) {
      inCodexBlock = /^codex\s*$/.test(line);
      continue;
    }
    if (inCodexBlock) parts.push(line);
  }
  return parts;
}

function isSetupJsInvocation(command: string): boolean {
  return /(?:^|\s)node\s+(?:[^\s]*[/\\])?setup\.js(?:\s|$)/.test(command);
}

function extractArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function readStringField(obj: unknown, field: string): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const val = (obj as Record<string, unknown>)[field];
  return typeof val === 'string' ? val : null;
}

function extractBashFromAnthropicToolUse(obj: Record<string, unknown>): string | null {
  if (obj.type !== 'tool_use' || obj.name !== 'Bash') return null;
  return readStringField(obj.input, 'command');
}

function extractBashFromCodexInvocation(obj: Record<string, unknown>): string | null {
  if (obj.name !== 'Bash') return null;
  const fromParams = readStringField(obj.parameters, 'command');
  if (fromParams !== null) return fromParams;
  if (typeof obj.command === 'string') return obj.command;
  if (typeof obj.arguments === 'string') {
    try {
      return readStringField(JSON.parse(obj.arguments), 'command');
    } catch { /* not parseable */ }
  }
  return null;
}

function extractBashCommandFromJson(obj: Record<string, unknown>): string | null {
  return extractBashFromAnthropicToolUse(obj) ?? extractBashFromCodexInvocation(obj);
}

type BashObservation = { isSetupInvocation: boolean; argv: string[] };

function classifyBashCommand(cmd: string): BashObservation {
  return { isSetupInvocation: isSetupJsInvocation(cmd), argv: extractArgv(cmd) };
}

function observeBashFromObject(obj: Record<string, unknown>): BashObservation | null {
  const cmd = extractBashCommandFromJson(obj);
  return cmd === null ? null : classifyBashCommand(cmd);
}

function observeBashFromAnthropicAssistant(obj: Record<string, unknown>): BashObservation | null {
  if (obj.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const result = observeBashFromObject(block as Record<string, unknown>);
    if (result !== null) return result;
  }
  return null;
}

function observeStreamJsonLine(trimmed: string): BashObservation | null {
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const fromAssistant = observeBashFromAnthropicAssistant(obj);
  if (fromAssistant !== null) return fromAssistant;
  if (obj.type === 'function_call' || obj.type === 'tool_call' || obj.name === 'Bash') {
    return observeBashFromObject(obj);
  }
  return null;
}

function observeCodexBlockLine(trimmed: string): BashObservation | null {
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return observeBashFromObject(parsed);
  } catch { /* not JSON — fall through to plain text */ }
  return isSetupJsInvocation(trimmed) ? classifyBashCommand(trimmed) : null;
}

/** Observes a single stream line for a Bash tool-call invoking setup.js; returns null if not a Bash tool-call. */
export function observeCodexToolCallStream(
  streamLine: string,
  mode: 'codex-block' | 'stream-json',
): BashObservation | null {
  try {
    const trimmed = streamLine.trim();
    if (!trimmed) return null;
    if (mode === 'stream-json') return observeStreamJsonLine(trimmed);
    if (mode === 'codex-block') return observeCodexBlockLine(trimmed);
    return null;
  } catch {
    return null;
  }
}

/** Infers output format from raw codex output text (stream-json › codex-block › plain-text). */
export function detectOutputFormat(output: string): 'stream-json' | 'codex-block' | 'plain-text' {
  const lines = output.split('\n');
  if (lines.some(isAssistantJsonLine)) return 'stream-json';
  if (lines.some(line => CODEX_DELIMITER_RE.test(line))) return 'codex-block';
  return 'plain-text';
}

/** Extracts assistant-role text from codex output, handling stream-json, codex-block, and plain-text modes. */
export function extractAssistantContent(output: string): string {
  switch (detectOutputFormat(output)) {
    case 'stream-json':
      return extractStreamJsonContent(output.split('\n')).join('\n');
    case 'codex-block':
      return extractCodexBlockContent(output.split('\n')).join('\n');
    default: {
      // Mode 3: plain-text fallback. JSON-structured output lacking an
      // assistant line is NOT prose — its assistant content is empty, so
      // promise tokens embedded in user/tool_result lines must not leak.
      // Only genuine non-JSON prose returns as-is.
      const lines = output.split('\n');
      const nonEmpty = lines.filter(line => line.trim());
      if (nonEmpty.length > 0 && nonEmpty.every(isJsonObjectLine)) {
        return extractStreamJsonContent(lines).join('\n');
      }
      return output;
    }
  }
}
