#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_ROOT="$EXTENSION_ROOT/src"
AUDIT_DIR="$EXTENSION_ROOT/audit"
DEFAULT_OUTPUT_DIR="${TMPDIR:-$AUDIT_DIR}"
DEFAULT_OUTPUT_TEMPLATE="${DEFAULT_OUTPUT_DIR%/}/subsystem-claude-md.XXXXXX"
OUTPUT_FILE="${OUTPUT_FILE_OVERRIDE:-$(mktemp "$DEFAULT_OUTPUT_TEMPLATE")}"
SUBSYSTEMS=("bin" "hooks" "lib" "services" "types")
STALE_THRESHOLD_DAYS=7

if ! command -v python3 >/dev/null 2>&1; then
  echo "[error: python3 is required]" >&2
  exit 1
fi

mkdir -p "$AUDIT_DIR"

python3 - "$SRC_ROOT" "$OUTPUT_FILE" "${SUBSYSTEMS[@]}" <<'PYEOF'
import sys, os, re, json, datetime

src_root = sys.argv[1]
output_file = sys.argv[2]
subsystems = sys.argv[3:]
stale_threshold_days = 7

def get_mtime_epoch(path):
    return os.path.getmtime(path)

def iso_from_epoch(epoch):
    return datetime.datetime.fromtimestamp(epoch, tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def count_source_files(dirpath):
    count = 0
    for f in os.listdir(dirpath):
        if f.endswith(('.ts', '.json')) and f != 'CLAUDE.md' and os.path.isfile(os.path.join(dirpath, f)):
            count += 1
    return count

def get_newest_source_mtime(dirpath):
    newest = 0
    for f in os.listdir(dirpath):
        if f.endswith(('.ts', '.json')) and f != 'CLAUDE.md' and os.path.isfile(os.path.join(dirpath, f)):
            mt = get_mtime_epoch(os.path.join(dirpath, f))
            if mt > newest:
                newest = mt
    return newest

def get_export_names(dirpath):
    exports = set()
    for f in os.listdir(dirpath):
        if not f.endswith('.ts') or f == 'CLAUDE.md':
            continue
        fpath = os.path.join(dirpath, f)
        if not os.path.isfile(fpath):
            continue
        try:
            with open(fpath) as fh:
                content = fh.read()
            found = re.findall(
                r'^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|abstract\s+class)\s+(\w+)',
                content, re.MULTILINE
            )
            reexports = re.findall(r'^export\s*\{([^}]+)\}', content, re.MULTILINE)
            for block in reexports:
                names = [n.strip().split(' as ')[-1].strip() for n in block.split(',')]
                found.extend([n for n in names if n and not n.startswith('*') and re.match(r'^\w+$', n)])
            exports.update(found)
        except Exception:
            pass
    return exports

results = []

for s in subsystems:
    dirpath = os.path.join(src_root, s)
    claude_path = os.path.join(dirpath, 'CLAUDE.md')
    has_claude_md = os.path.isfile(claude_path)
    file_count = count_source_files(dirpath)

    if not has_claude_md:
        drift_class = 'MISSING'
        last_modified_iso = None
    else:
        claude_mtime = get_mtime_epoch(claude_path)
        last_modified_iso = iso_from_epoch(claude_mtime)
        newest_src = get_newest_source_mtime(dirpath)
        delta_days = (newest_src - claude_mtime) / 86400.0

        if delta_days > stale_threshold_days:
            drift_class = 'STALE'
        else:
            exports = get_export_names(dirpath)
            if not exports:
                drift_class = 'OK'
            else:
                with open(claude_path) as fh:
                    claude_content = fh.read()
                covered = sum(1 for exp in exports if exp in claude_content)
                coverage_pct = covered / len(exports)
                drift_class = 'INCOMPLETE' if coverage_pct < 0.5 else 'OK'

    results.append({
        'subsystem': s,
        'has_claude_md': has_claude_md,
        'last_modified_iso': last_modified_iso,
        'file_count': file_count,
        'drift_class': drift_class,
    })

with open(output_file, 'w') as fh:
    json.dump(results, fh, indent=2)
    fh.write('\n')

print(f'[audit-subsystem-claude-md] wrote {output_file}')
for r in results:
    print(f'  {r["subsystem"]}: {r["drift_class"]} (file_count={r["file_count"]}, has_claude_md={r["has_claude_md"]})')
PYEOF
