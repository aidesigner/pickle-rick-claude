import * as path from 'path';
import { logActivity } from '../services/activity-logger.js';
if (process.argv[1] && path.basename(process.argv[1]) === 'pickle-deprecated.js') {
    process.stderr.write('/pickle is removed. Use /pickle-tmux <args> for the build loop, ' +
        '/pickle-refine-prd for refinement, /pickle-pipeline for the full pipeline.\n');
    try {
        logActivity({
            event: 'pickle_command_deprecated',
            ts: new Date().toISOString(),
            title: '/pickle bare invocation intercepted — migration message shown',
            source: 'persona',
        });
    }
    catch {
        // best-effort; do not suppress the exit
    }
    process.exit(1);
}
