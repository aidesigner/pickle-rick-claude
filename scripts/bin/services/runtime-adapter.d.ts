import type { PickleRickSkillsConfig, SpawnManagerArgs, SpawnWorkerArgs } from '../types/index.js';
export declare function buildManagerSpawnCommand(runtimeName: string, config: PickleRickSkillsConfig, args: SpawnManagerArgs): string[];
export declare function buildWorkerSpawnCommand(runtimeName: string, config: PickleRickSkillsConfig, args: SpawnWorkerArgs): string[];
export declare function buildSpawnCommand(runtimeName: string, config: PickleRickSkillsConfig, args: SpawnManagerArgs | SpawnWorkerArgs): string[];
export declare function formatDryRun(cmd: string[]): string;
export declare function listRuntimes(config: PickleRickSkillsConfig): string;
