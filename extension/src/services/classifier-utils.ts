// Codex plain-text block delimiters. A line matching this regex marks the
// start of a new named block; content between a 'codex' delimiter and the
// next delimiter (or EOF) is assistant output. All other blocks are dropped.
const CODEX_DELIMITER_RE = /^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/;

function isAssistantJsonLine(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.type === 'assistant';
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

/**
 * Detects the output format of a log without extracting content.
 *
 * Precedence mirrors extractAssistantContent:
 * 1. 'stream-json'  — ≥1 line is a {type:'assistant',...} JSON object
 * 2. 'codex-block'  — ≥1 line matches CODEX_DELIMITER_RE
 * 3. 'plain-text'   — neither; caller with codex context should treat as drift
 */
export function detectOutputFormat(output: string): 'stream-json' | 'codex-block' | 'plain-text' {
  const lines = output.split('\n');
  if (lines.some(isAssistantJsonLine)) return 'stream-json';
  if (lines.some(line => CODEX_DELIMITER_RE.test(line))) return 'codex-block';
  return 'plain-text';
}

/**
 * Extracts text content from assistant messages.
 *
 * Detection precedence:
 * 1. Stream-json: >=1 line is a {type:'assistant',...} JSON object. Non-assistant
 *    typed objects ({type:'system'}, {type:'user'}) and bare JSON values do NOT
 *    trigger this mode. Extracts only assistant text blocks and result blocks;
 *    all other JSON types are skipped.
 * 2. Codex plain-text: >=1 line matches CODEX_DELIMITER_RE. Extracts content
 *    between 'codex' delimiters only; user/exec/tokens/reasoning/tool_call
 *    blocks are dropped. Multi-turn: union of all surviving codex blocks.
 * 3. Pure plain-text fallback: returns output as-is.
 *
 * Promise tokens embedded in reviewed source (tool_result, user prompts,
 * codex user blocks) are excluded in all modes.
 */
export function extractAssistantContent(output: string): string {
  switch (detectOutputFormat(output)) {
    case 'stream-json':
      return extractStreamJsonContent(output.split('\n')).join('\n');
    case 'codex-block':
      return extractCodexBlockContent(output.split('\n')).join('\n');
    default:
      // Mode 3: pure plain-text fallback - return everything.
      return output;
  }
}
