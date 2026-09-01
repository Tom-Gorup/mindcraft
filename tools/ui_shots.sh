#!/usr/bin/env bash
# Screenshot the offline dashboard demo in every view, for design review.
#
#   python3 tools/ui_demo.py <outdir> && bash tools/ui_shots.sh <outdir>
#
# Requires Google Chrome. Not part of the app or its tests.
#
# SAFETY — this launches Chrome and must never disturb the user's browser:
#   · every launch is pinned to a throwaway --user-data-dir, so the real
#     profile is never opened, locked or written to;
#   · cleanup kills only THIS script's own child PIDs. Never
#     `pkill -f "Google Chrome"` — that pattern matches the user's normal
#     browser too, and killing it mid-write leaves stale Singleton* lock files
#     that stop Chrome restarting at all;
#   · a trap fires on exit, interrupt and timeout, because headless Chrome does
#     not reliably exit once it has written the PNG. An orphan matters more
#     than it sounds: macOS routes a launch request to the already-running
#     Chrome, so a leftover window-less instance makes the real browser look
#     like it "won't open".
#
# --force-prefers-reduced-motion is also load-bearing: the dashboard has several
# infinite animations and Chrome will not settle while they run.
set -u

D="${1:-${TMPDIR:-/tmp}/mindcraft-demo}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
# A fresh profile per run: a leftover SingletonLock from an interrupted run
# makes every subsequent Chrome abort before it renders anything.
PROFILE="$(dirname "$D")/chrome-shot-profile-$$"

PIDS=()
cleanup() {
    for pid in "${PIDS[@]:-}"; do
        [ -n "${pid:-}" ] || continue
        kill -TERM "$pid" 2>/dev/null
    done
    sleep 1
    for pid in "${PIDS[@]:-}"; do
        [ -n "${pid:-}" ] || continue
        kill -KILL "$pid" 2>/dev/null
    done
    # helper processes (renderer/gpu/network) are matched by OUR profile path
    # only — never by the Chrome binary name
    pkill -KILL -f "user-data-dir=$PROFILE" 2>/dev/null
    rm -rf "$PROFILE"
}
trap cleanup EXIT INT TERM

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
    PIDS+=("$pid")

    # Wait for the PNG, not for Chrome to exit — it frequently does not.
    for _ in $(seq 1 40); do
        sleep 0.5
        if [ -s "$out" ]; then sleep 0.4; break; fi
        kill -0 "$pid" 2>/dev/null || break
    done

    kill -TERM "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    # confirm this one is really gone before starting the next
    for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
    done
    kill -KILL "$pid" 2>/dev/null
    pkill -KILL -f "user-data-dir=$PROFILE" 2>/dev/null

    if [ -s "$out" ]; then echo "  $1  $(wc -c < "$out" | tr -d ' ') bytes"; else echo "  $1  FAILED"; fi
}

echo "screenshots -> $D"
shot agents        '#agents?dark'    1500 1000
shot sim           '#sim?dark'       1500 2400
shot reports       '#reports?dark'   1500 1750
shot tv            '#sim?tv,dark'    1920 1080
shot agents-light  '#agents?light'   1500 1000
shot sim-light     '#sim?light'      1500 1450
shot reports-light '#reports?light'  1500 1750
shot modal-new     '#agents?dark,newagent'  1500 1000

leftover=$(pgrep -f "user-data-dir=$PROFILE" 2>/dev/null | wc -l | tr -d ' ')
[ "$leftover" != "0" ] && echo "WARNING: $leftover leftover Chrome process(es) on the shot profile"
echo "done"
