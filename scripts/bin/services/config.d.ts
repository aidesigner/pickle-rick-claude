import type { RuntimeConfig, PickleRickSkillsConfig } from '../types/index.js';
export declare const VERIFIED_RUNTIMES: Record<string, RuntimeConfig>;
export declare const PENDING_RUNTIMES: Record<string, RuntimeConfig>;
export declare const COMMUNITY_RUNTIMES: Record<string, RuntimeConfig>;
export declare const ALL_DEFAULT_RUNTIMES: Record<string, RuntimeConfig>;
export declare const DEFAULT_CONFIG_DEFAULTS: PickleRickSkillsConfig['defaults'];
export declare function getExtensionRoot(): string;
export declare function getDefaultConfigPath(): string;
export declare function loadConfig(configPath?: string): PickleRickSkillsConfig;
