import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineKeysRegistry } from '../types/engine-keys-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../data/engine-injected-keys.json');

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function loadEngineKeysRegistry(registryPath?: string): EngineKeysRegistry {
  const p = registryPath ?? DEFAULT_REGISTRY_PATH;
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw) as EngineKeysRegistry;
  if (data.schema_version !== 1) {
    throw new Error(
      `engine-injected-keys.json: unsupported schema_version ${data.schema_version} (loader supports 1)`
    );
  }
  return data;
}

export function isUserWritten(key: string, registry: EngineKeysRegistry): boolean {
  return registry.user_written_patterns.some(p => globToRegExp(p).test(key));
}

export function isEngineWritten(key: string, registry: EngineKeysRegistry): boolean {
  if (isUserWritten(key, registry)) return false;
  if (registry.engine_keys.includes(key)) return true;
  return registry.engine_key_patterns.some(p => globToRegExp(p).test(key));
}
