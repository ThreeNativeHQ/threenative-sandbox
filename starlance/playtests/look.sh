#!/usr/bin/env bash
# Look-lane captures: dunes, canyon + arch, plain, arena. The playtest bridge cannot write game
# state, so the course position comes from the URL seam `?skipTo=<metres>` (src/render/hud.ts).
# Usage: playtests/look.sh            (all four)    playtests/look.sh look-b 1690   (one)
cd "$(dirname "$0")/.." || exit 1
PORT=${LOOK_PORT:-5293}
run() {
  tools/capture-lock.sh pnpm exec threenative-playtest --scenario "playtests/$1.playtest.json" \
    --browser-recipe webgpu --headed --artifacts artifacts/look \
    --url "http://127.0.0.1:$PORT/?skipTo=$2" --port "$PORT" \
    --server-command "pnpm exec vite --host 127.0.0.1 --port $PORT --strictPort"
}
if [ $# -ge 2 ]; then run "$1" "$2"; exit $?; fi
status=0
run look 400 || status=1
run look-b 1690 || status=1
run look-c 3300 || status=1
run look-arena 4900 || status=1
exit $status
