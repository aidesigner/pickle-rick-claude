import * as fs from 'fs';
import * as path from 'path';
import { run_cmd, extractFrontmatter } from './pickle-utils.js';
export function run_git(cmd, cwd, check = true) {
    return run_cmd(['git', ...cmd], { cwd, check });
}
export function get_github_user() {
    try {
        return run_cmd(['gh', 'api', 'user', '-q', '.login']);
    }
    catch {
        try {
            return run_cmd(['git', 'config', 'user.name']).replace(/\s+/g, '');
        }
        catch {
            return 'pickle-rick';
        }
    }
}
export function get_branch_name(task_id) {
    const user = get_github_user();
    const lowerId = task_id.toLowerCase();
    const type = ['fix', 'bug', 'patch', 'issue'].some((x) => lowerId.includes(x)) ? 'fix' : 'feat';
    return `${user}/${type}/${task_id}`;
}
export function update_ticket_status(ticket_id, new_status, session_dir) {
    // 1. Find the ticket file
    // Search recursively in the session directory
    const find_ticket = (dir, depth = 0) => {
        if (depth > 10)
            return null; // prevent runaway recursion from symlink cycles
        let files;
        try {
            files = fs.readdirSync(dir);
        }
        catch {
            return null;
        }
        for (const file of files) {
            const fullPath = path.join(dir, file);
            let stat;
            try {
                stat = fs.lstatSync(fullPath); // lstat: don't follow symlinks into directories
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                const res = find_ticket(fullPath, depth + 1);
                if (res)
                    return res;
            }
            else if (file === `linear_ticket_${ticket_id}.md`) {
                return fullPath;
            }
        }
        return null;
    };
    const ticket_path = find_ticket(session_dir);
    if (!ticket_path) {
        throw new Error(`Ticket linear_ticket_${ticket_id}.md not found in ${session_dir}`);
    }
    // 2. Read and update the frontmatter
    let content = fs.readFileSync(ticket_path, 'utf-8');
    const today = new Date().toISOString().split('T')[0];
    // Track whether the status: line was actually found and replaced
    let statusReplaced = false;
    // Replace only within the YAML frontmatter block (between the first pair of --- delimiters).
    // Using a global replace here would corrupt any "status:" lines in the ticket body.
    const fm = extractFrontmatter(content);
    if (fm) {
        let fmSection = content.slice(0, fm.end);
        if (/^status:.*$/m.test(fmSection)) {
            fmSection = fmSection.replace(/^status:.*$/m, `status: "${new_status}"`);
            statusReplaced = true;
        }
        if (/^updated:.*$/m.test(fmSection)) {
            fmSection = fmSection.replace(/^updated:.*$/m, `updated: "${today}"`);
        }
        else {
            // Insert updated field before closing --- if missing
            fmSection = fmSection.replace(/\n---(\r?\n?)$/, `\nupdated: "${today}"\n---$1`);
        }
        content = fmSection + content.slice(fm.end);
    }
    else {
        // No frontmatter delimiters found — warn and fall back to full-file replace
        console.warn(`Warning: ticket ${ticket_id} has no valid YAML frontmatter — status replacement may be imprecise`);
        if (/^status:.*$/m.test(content)) {
            content = content.replace(/^status:.*$/m, `status: "${new_status}"`);
            statusReplaced = true;
        }
        content = content.replace(/^updated:.*$/m, `updated: "${today}"`);
    }
    if (!statusReplaced) {
        console.warn(`Warning: no "status:" field found in ticket ${ticket_id} — status not updated`);
    }
    const tmp = ticket_path + '.tmp';
    try {
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, ticket_path);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
    if (statusReplaced) {
        console.log(`Successfully updated ticket ${ticket_id} to status "${new_status}"`);
    }
}
