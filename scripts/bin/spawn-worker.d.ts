import type { SpawnManagerArgs, SpawnWorkerArgs, SpawnResult } from './types/index.js';
export declare function killWithEscalation(pid: number, graceSeconds: number): Promise<void>;
export declare function spawnManager(args: SpawnManagerArgs): Promise<SpawnResult>;
export declare function spawnWorker(args: SpawnWorkerArgs): Promise<SpawnResult>;
