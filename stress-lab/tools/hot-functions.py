#!/usr/bin/env python3
"""Rank the hottest functions in a Chrome DevTools trace by self time.

Usage: python3 tools/hot-functions.py <trace.json[.gz]> [--top 25]

Release engine frames print as `wasm-function[N]`: a `--profiling-funcs` link changes the code
section, so its indices do not name a release build's frames.

Reads the V8 CPU profile carried in the trace's ProfileChunk events and sums each sample's
interval into the function on top of the stack (self) and every function on it (total).
"""
import argparse
import collections
import gzip
import json


def load(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt") as handle:
        data = json.load(handle)
    return data["traceEvents"] if isinstance(data, dict) else data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("trace")
    parser.add_argument("--top", type=int, default=25)
    args = parser.parse_args()
    events = load(args.trace)
    nodes, parent = {}, {}
    samples, deltas = [], []
    for event in events:
        if event.get("name") != "ProfileChunk":
            continue
        chunk = event["args"]["data"].get("cpuProfile", {})
        for node in chunk.get("nodes", []):
            frame = node["callFrame"]
            url = frame.get("url", "").rsplit("/", 1)[-1].split("?")[0]
            nodes[node["id"]] = f'{frame.get("functionName") or "(anonymous)"} {url}:{frame.get("lineNumber", -1) + 1}'
            if "parent" in node:
                parent[node["id"]] = node["parent"]
        samples += chunk.get("samples", [])
        deltas += event["args"]["data"].get("timeDeltas", [])
    if not samples:
        raise SystemExit("no ProfileChunk samples in this trace")
    self_ms, total_ms = collections.Counter(), collections.Counter()
    for node_id, delta in zip(samples, deltas[1:] + [0]):
        ms = max(delta, 0) / 1000
        self_ms[nodes.get(node_id, "?")] += ms
        seen, cursor = set(), node_id
        while cursor is not None:
            name = nodes.get(cursor, "?")
            if name not in seen:
                total_ms[name] += ms
                seen.add(name)
            cursor = parent.get(cursor)
    wall = sum(self_ms.values())
    print(f"sampled {wall:.0f} ms")
    print(f"{'self ms':>9} {'self %':>7} {'total ms':>9}  function")
    for name, ms in self_ms.most_common(args.top):
        print(f"{ms:9.1f} {100 * ms / wall:6.1f}% {total_ms[name]:9.1f}  {name}")


if __name__ == "__main__":
    main()
