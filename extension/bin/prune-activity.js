import * as path from 'path';
import { pruneActivity } from '../services/activity-logger.js';
export { pruneActivity };
if (process.argv[1] && path.basename(process.argv[1]) === 'prune-activity.js') {
    try {
        const deleted = pruneActivity();
        if (deleted > 0)
            console.log(`Pruned ${deleted} old activity file${deleted === 1 ? '' : 's'}.`);
    }
    catch (err) {
        console.error(`Activity prune failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
