#!/usr/bin/env bash
# Screenshot the offline dashboard demo in every view, for design review.
#
#   python3 tools/ui_demo.py && bash tools/ui_shots.sh [outdir]
#
# Requires Google Chrome. Not part of the app or its tests.
#
# --force-prefers-reduced-motion matters: the dashboard has several infinite
# animations (the live dot, the recording pill, the thinking indicator) and
# headless Chrome will not exit while they are running.
set -u
D="${1:-${TMPDIR:-/tmp}/mindcraft-demo}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
# a fresh profile per run: a leftover SingletonLock from an interrupted run
# makes every subsequent Chrome abort before it renders anything
PROFILE="$(dirname "$D")/chrome-shot-profile-$$"
trap 'rm -rf "$PROFILE"' EXIT

shot() {   # shot <name> <url-fragment> <width> <height>
    local out="$D/shot-$1.png"
    rm -f "$out"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
        --no-first-run --no-default-browser-check --disable-crash-reporter \
        --force-prefers-reduced-motion --disable-lcd-text \
        --user-data-dir="$PROFILE" --virtual-time-budget=2500 \
        --window-size="$3,$4" --screenshot="$out" \
        "file://$D/demo.html$2" >/dev/null 2>&1 &
    local pid=$!
    # Chrome often lingers after writing the file; wait for the PNG, not the exit
    for _ in $(seq 1 40); do
        sleep 0.5
        if [ -s "$out" ]; then sleep 0.4; break; fi
        kill -0 "$pid" 2>/dev/null || break
    done
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    if [ -s "$out" ]; then echo "  $1  $(wc -c < "$out" | tr -d ' ') bytes"; else echo "  $1  FAILED"; fi
}

echo "screenshots -> $D"
shot agents        '#agents?dark'    1500 1000
shot sim           '#sim?dark'       1500 1450
shot reports       '#reports?dark'   1500 1750
shot tv            '#sim?tv,dark'    1920 1080
shot agents-light  '#agents?light'   1500 1000
shot sim-light     '#sim?light'      1500 1450
shot reports-light '#reports?light'  1500 1750
shot modal-new     '#agents?dark,newagent'  1500 1000
