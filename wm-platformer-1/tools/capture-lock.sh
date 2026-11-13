#!/usr/bin/env bash
# Serialise headed WebGPU captures AND keep them off the real desktop.
#
# Three problems, one wrapper:
#
# 1. Headless Chromium cannot render WebGPU here — headless serves WebGPU from
#    SwiftShader and hands back a black canvas — so captures must be HEADED.
# 2. Headed Chromium hangs on launch under a native Wayland session: the process
#    spawns but never answers the CDP pipe, Playwright dies at 120–180 s, and
#    every failed launch strands ~5 chrome processes. Forcing X11/XWayland took
#    launch from that timeout to ~175 ms.
# 3. A headed capture opens a REAL window on your desktop and holds a GPU
#    context rendering a ~380k-triangle scene at 60 fps. Several of those at
#    once starve the compositor and make the desktop unusable.
#
# So this wrapper does all three:
#   - `flock`: exactly one capture machine-wide; waits its turn instead of
#     failing, so several agents can call it concurrently (CAPTURE_LOCK_TIMEOUT
#     bounds the wait). Queue visibility included: waiters leave marker files,
#     so contention prints WHO holds the display and how deep the queue is,
#     and a timeout announces itself as a LOCK TIMEOUT, not a test failure —
#     the false-FAIL-via-lock-timeout trap from the 2026-08-22 session retro.
#   - reaps profiles stranded by earlier timed-out launches while holding the lock.
#   - runs the capture on a PRIVATE VIRTUAL DISPLAY (Xvfb), never your desktop.
#     Verified 2026-08-22 on this host (RTX 2080, Wayland session): under Xvfb,
#     navigator.gpu reports the REAL NVIDIA adapter ("nvidia | turing", not
#     SwiftShader) and frames render correctly with the usual recipe flags.
#     Same launch flags, same code path — only DISPLAY differs.
#
#   tools/capture-lock.sh node tour-tmp.mjs /tmp/shots
#   tools/capture-lock.sh npx @threenative/playtest --scenario ... --headed
#
# Opt out of the virtual display and capture on the visible desktop (old
# behaviour) with CAPTURE_ON_DESKTOP=1. To reuse an already-running virtual
# display instead of spawning a throwaway one, set CAPTURE_DISPLAY=<number>.
# Screen size: CAPTURE_SCREEN (default 1600x900x24), which every 1280x720
# viewport fits inside.
set -euo pipefail

lock="${CAPTURE_LOCK_FILE:-/tmp/threenative-capture.lock}"
timeout="${CAPTURE_LOCK_TIMEOUT:-900}"

if [ "$#" -eq 0 ]; then
  echo "usage: tools/capture-lock.sh <command> [args...]" >&2
  exit 64
fi

tmpdir="$(mktemp -d)"
cleanup() {
  kill "${xvfb_pid:-}" 2>/dev/null || true
  rm -rf "$tmpdir"
  rm -f "${marker:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Append mode, never plain >: a plain open TRUNCATES, so every waiter would
# wipe the holder's identity line right before trying to read it.
exec 9>>"$lock"

# Queue visibility: every waiter leaves <pid>-<epoch> in a side directory, so a
# contended acquire can report real depth and dead owners are pruned by pid.
queuedir="${lock}.queue"
mkdir -p "$queuedir"
marker="$queuedir/$$-$(date +%s)"
touch "$marker"

if flock -n 9; then
  rm -f "$marker"
else
  # Prune markers whose owner died mid-wait (killed, timed out elsewhere).
  for m in "$queuedir"/*; do
    [ -e "$m" ] || continue
    owner="${m##*/}"
    owner="${owner%%-*}"
    kill -0 "$owner" 2>/dev/null || rm -f "$m"
  done
  depth="$(find "$queuedir" -type f | wc -l)" # includes this process
  holder="$(tr '\n' ';' <"$lock" 2>/dev/null || true)"
  echo "capture-lock: display busy${holder:+ — ${holder%;};} $depth waiting; holding for up to ${timeout}s…" >&2
  if ! flock --wait "$timeout" 9; then
    echo "capture-lock: LOCK TIMEOUT after ${timeout}s — this is NOT a test failure." >&2
    echo "capture-lock: another capture still held the display; last holder: $(tr '\n' ' ' <"$lock" 2>/dev/null || echo unknown)" >&2
    exit 75
  fi
  rm -f "$marker"
fi

# We hold the lock. Record who we are for the next contended waiter.
printf 'pid=%s started=%s cmd=%s\n' "$$" "$(date -Is)" "$*" >"$lock"

# Reap anything a previous timed-out launch stranded; we hold the lock, so no
# live capture can own these.
pkill -f playwright_chromiumdev_profile >/dev/null 2>&1 || true

if [ "${CAPTURE_ON_DESKTOP:-0}" = "1" ]; then
  rm -f "$marker" # exec replaces this process; the EXIT trap never runs
  exec env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 "$@"
fi

screen="${CAPTURE_SCREEN:-1600x900x24}"

# A caller-managed virtual display wins; skip spawning our own.
if [ -n "${CAPTURE_DISPLAY:-}" ]; then
  rm -f "$marker" # exec replaces this process; the EXIT trap never runs
  env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 DISPLAY=":${CAPTURE_DISPLAY}" "$@"
  exit $?
fi

# Xvfb picks its own free display number via -displayfd, which sidesteps every
# stale-socket / already-in-use case. It dies with this script via the trap.
# NOTE: -screen takes TWO words deliberately unquoted.
Xvfb -displayfd 1 -screen 0 $screen -nolisten tcp >"$tmpdir/display" 2>"$tmpdir/xvfb.err" &
xvfb_pid=$!

ok=""
for _ in $(seq 1 100); do
  [ -s "$tmpdir/display" ] && ok=1 && break
  kill -0 "$xvfb_pid" 2>/dev/null || break
  sleep 0.1
done
if [ -z "$ok" ]; then
  echo "capture-lock: Xvfb failed to start:" >&2
  cat "$tmpdir/xvfb.err" >&2
  exit 70
fi
display_num="$(tr -dc '0-9' <"$tmpdir/display")"
if [ -z "$display_num" ]; then
  echo "capture-lock: Xvfb started but reported no display number" >&2
  exit 70
fi

env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 DISPLAY=":${display_num}" "$@"
