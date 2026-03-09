export declare function withSessionMapLock<T>(fn: () => Promise<T>): Promise<T>;
export declare function updateSessionMap(cwd: string, sessionPath: string): Promise<void>;
export declare function removeFromSessionMap(cwd: string): Promise<void>;
export declare function getSessionForCwd(cwd: string): Promise<string | null>;
export declare function listSessions(): Promise<Array<{
    cwd: string;
    sessionDir: string;
}>>;
export declare function pruneSessionMap(maxAgeDays?: number): Promise<void>;
export declare function findLastSessionForCwd(targetCwd: string): Promise<string | null>;
