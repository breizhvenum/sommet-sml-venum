#!/usr/bin/env bash
# Runs every automatic check that needs no watch and no network, and says plainly whether
# anything broke. Run it before every commit:
#
#     tools/check.sh           # everything (about 20 s)
#     tools/check.sh python    # only the Python tools and the desktop backend
#     tools/check.sh android   # only the Android/iOS app logic
#
# Exit code 0 = all passed. Anything else = something that worked before is now broken.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
what="${1:-all}"
failed=()

step() {   # step <label> <command...>
    local label="$1"; shift
    local out
    if out="$("$@" 2>&1)"; then
        printf '  ok    %s\n' "$label"
    else
        printf '  FAIL  %s\n' "$label"
        printf '%s\n' "$out" | tail -25 | sed 's/^/        /'
        failed+=("$label")
    fi
}

in_dir() {   # in_dir <folder> <command...>  (plain cd: "env -C" does not exist on every Mac)
    local d="$1"; shift
    (cd "$d" && "$@")
}

if [ "$what" = all ] || [ "$what" = python ]; then
    echo "Desktop backend and Python tools"
    step "backend compiles (desktop/backend/server.py)" \
        python3 -m py_compile "$ROOT/desktop/backend/server.py"
    for t in "$ROOT"/tools/test_*.py; do
        step "$(basename "$t")" in_dir "$ROOT/tools" python3 "$t"
    done
fi

if [ "$what" = all ] || [ "$what" = android ]; then
    echo "Android / iOS app logic"
    if [ -d "$ROOT/android/node_modules" ]; then
        step "jest (android/src)" in_dir "$ROOT/android" npx jest --silent
    else
        echo "  SKIPPED jest: android/node_modules is missing here (run 'npm ci' in android/)"
    fi
fi

echo
if [ ${#failed[@]} -eq 0 ]; then
    echo "All checks passed."
else
    echo "${#failed[@]} check(s) FAILED:"
    printf '  - %s\n' "${failed[@]}"
    exit 1
fi
