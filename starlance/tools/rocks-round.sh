#!/usr/bin/env bash
# Rock-lane capture set into ~/Downloads/starlance-env/rocks/round-NN: low chase among towers, canyon,
# mesas on the plain, arena. Needs a fresh `pnpm build:web`. Usage: tools/rocks-round.sh 01
cd "$(dirname "$0")/.." || exit 1
N=${1:?round number}
OUT=$HOME/Downloads/starlance-env/rocks/round-$N
PORT=${ROCKS_PORT:-5331}
mkdir -p "$OUT" artifacts/rocks-$N
run() { # scenario skipTo name
  tools/capture-lock.sh pnpm exec threenative-playtest --scenario "playtests/$1.playtest.json" \
    --browser-recipe webgpu --headed --artifacts "artifacts/rocks-$N/$3" \
    --url "http://127.0.0.1:$PORT/?skipTo=$2" --port "$PORT" \
    --server-command "pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort" >"artifacts/rocks-$N/$3.log" 2>&1
  f=$(find "artifacts/rocks-$N/$3" -name '*.png' | head -1)
  [ -n "$f" ] && cp "$f" "$OUT/$3.png" || echo "no png for $3"
}
run rocks-low 600 a-low-towers
run rocks-view 1690 b-canyon
run rocks-view 3300 c-mesas
run rocks-view 4900 d-arena
ls "$OUT"
