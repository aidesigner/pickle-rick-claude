import type { WriteStream } from 'fs';
import { once } from 'events';

/**
 * Flush sessionLog to disk and exit. Addresses graceful exit only;
 * SIGKILL/segfault/OOM still produce 0-byte logs — R-WSE-2 catches all
 * classes via worker_partial_lifecycle_exit event.
 */
export async function flushAndExit(sessionLog: WriteStream, code: number): Promise<never> {
  sessionLog.end();
  await once(sessionLog, 'close');
  // eslint-disable-next-line pickle/no-process-exit-in-library
  process.exit(code);
}
