#!/usr/bin/env python3
"""Runs the Unreal stress lab and turns its CSV profile into a `stress-loop.mjs record` fair run.

    python3 tools/run.py capture <out.png> [--setup stock|tnmatched]
    python3 tools/run.py measure --setup stock|tnmatched --run <n>     -> rows/<setup>-uncapped-<n>.json
    python3 tools/run.py mean rows/<a>.json rows/<b>.json --out <file>  -> the mean of the valid runs
    python3 tools/run.py selftest

Every launch waits for a quiet host and holds the shared measure lock (~/.cache/tmp-tn/stress-loop/
measure.lock) for its whole life: no `stress-loop.mjs fair` process, 1-minute load under 12 for 60 s,
3 GB VRAM free and GPU under 10 % for 5 s. During the run it samples the host load each second.
Foreign load is the 1-minute load average minus the same moving average of Unreal's own runnable
threads. A run is void when foreign load averages above 12 or peaks above 18.
"""
import csv
import fcntl
import glob
import hashlib
import json
import math
import os
import subprocess
import sys
import time

LAB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UE = os.path.expanduser("~/UnrealEngine-5.8.3")
EDITOR = os.path.join(UE, "Engine/Binaries/Linux/UnrealEditor")
LOCK = os.path.expanduser("~/.cache/tmp-tn/stress-loop/measure.lock")
COMMIT = "UnrealEngine-5.8.3-58210709"
SETUPS = {
    "stock": [],
    # No Lumen: the ThreeNative scene has none. Virtual shadow maps stay.
    "tnmatched": ["r.DynamicGlobalIlluminationMethod 0", "r.ReflectionMethod 2"],
}
UNCAPPED = ["t.MaxFPS 0", "r.VSync 0"]
QUIET_LOAD, VOID_PEAK, VOID_AVG = 12.0, 18.0, 12.0
WINDOW_FRAMES = 120  # the frame-budget meter's window (@threenative/core DEFAULT_WINDOW_FRAMES)
HITCH_MS = 2000.0  # @threenative/core DEFAULT_HITCH_MS
COUNTS = {"trees": 4000, "rocks": 6000, "houses": 120, "props": 600, "crowd": 120, "bodies": 300,
          "particles": 12 * 1500, "lights": 16}
LAYERS = ["trees", "rocks", "houses", "props", "crowd", "bodies", "fires", "lights"]


def log(message):
    print(f"run: {message}", flush=True)


def load1():
    with open("/proc/loadavg") as f:
        return float(f.read().split()[0])


def fair_running():
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            argv = open(path, "rb").read().split(b"\0")
        except OSError:
            continue
        if any(a.endswith(b"stress-loop.mjs") for a in argv) and b"fair" in argv:
            return True
    return False


def gpu():
    out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                                   "--format=csv,noheader,nounits"], text=True).strip().splitlines()[0]
    name, used, total, util = [x.strip() for x in out.split(",")]
    return name, int(total) - int(used), int(util)


def wait_quiet(limit=3600):
    """Blocks until the host is quiet. Raises after `limit` seconds."""
    start, calm, idle = time.monotonic(), 0, 0
    while time.monotonic() - start < limit:
        _, free, util = gpu()
        busy = fair_running()
        calm = calm + 1 if load1() < QUIET_LOAD and not busy else 0
        idle = idle + 1 if free >= 3072 and util < 10 and not busy else 0
        if calm >= 60 and idle >= 5:
            log(f"quiet: load {load1()}, VRAM free {free} MiB, GPU {util} %")
            return
        time.sleep(1)
    raise SystemExit("run: the host did not get quiet within the limit")


def runnable_threads(pid):
    count = 0
    for stat in glob.glob(f"/proc/{pid}/task/*/stat"):
        try:
            state = open(stat).read().rsplit(")", 1)[1].split()[0]
        except (OSError, IndexError):
            continue
        count += state in ("R", "D")
    return count


def launch(mode, setup, uncapped, log_path, env_extra=None):
    """Runs the game to its own quit; returns the load samples [(loadavg1, foreign)]."""
    cmds = UNCAPPED + SETUPS[setup] if uncapped else SETUPS[setup]
    cmds = cmds + [f"py {os.path.join(LAB, 'runtime.py')}"]
    argv = [EDITOR, os.path.join(LAB, "StressLab.uproject"), "/Game/Stress", "-game", "-windowed",
            "-ResX=1280", "-ResY=720", "-nosound", "-nosplash", "-stdout", "-FullStdOutLogOutput",
            "-ExecCmds=" + ", ".join(cmds)]
    env = {**os.environ, "TN_STRESS_MODE": mode, "DISPLAY": os.environ.get("DISPLAY", ":0"), **(env_extra or {})}
    samples, alpha, own = [], 1 - math.exp(-1 / 60), 0.0
    with open(log_path, "w") as out:
        child = subprocess.Popen(argv, cwd=LAB, env=env, stdout=out, stderr=subprocess.STDOUT)
        log(f"{mode} {setup} pid {child.pid}")
        try:
            while child.poll() is None:
                own += alpha * (runnable_threads(child.pid) - own)
                total = load1()
                samples.append((total, round(max(0.0, total - own), 2)))
                time.sleep(1)
                if len(samples) > 600:
                    raise RuntimeError("Unreal ran past 10 minutes")
        finally:
            if child.poll() is None:  # only our own child, by its exact pid
                child.terminate()
                child.wait(30)
    return samples


def locked(fn):
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            wait_quiet()
            return fn()
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


# --- CSV ------------------------------------------------------------------------------------------
def read_csv(path):
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    header = rows[0]
    frames = []
    for row in rows[1:]:
        try:
            frames.append({name: float(row[i]) for i, name in enumerate(header) if i < len(row) and row[i] != ""
                           and name in ("FrameTime", "GameThreadTime", "RenderThreadTime", "RHIThreadTime",
                                        "GPUTime")})
        except ValueError:
            break  # the metadata rows at the end
    for name in ("FrameTime", "GameThreadTime", "RenderThreadTime", "GPUTime"):
        if not frames or name not in frames[0]:
            raise SystemExit(f"run: {path} has no {name} column")
    return frames


def pct(values, p):
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, math.ceil(p * len(ordered)) - 1))]


def median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def metrics_of(frames):
    """The stress report's definitions: per 120-frame window p50/p95, then the median of the windows."""
    def cpu(f):
        return max(f["GameThreadTime"], f["RenderThreadTime"], f.get("RHIThreadTime", 0.0))
    windows = [frames[i:i + WINDOW_FRAMES] for i in range(0, len(frames) - WINDOW_FRAMES + 1, WINDOW_FRAMES)]
    if not windows:
        raise SystemExit(f"run: only {len(frames)} frames, need {WINDOW_FRAMES}")
    pick = lambda read, p: round(median([pct([read(f) for f in w], p) for w in windows]), 3)
    counted = [f for w in windows for f in w]
    seconds = sum(f["FrameTime"] for f in counted) / 1000
    hitches = sum(1 for f in counted if f["FrameTime"] >= HITCH_MS)
    return round(seconds, 2), len(windows), {
        "presentedP50Ms": pick(lambda f: f["FrameTime"], 0.5),
        "presentedP95Ms": pick(lambda f: f["FrameTime"], 0.95),
        "rafStampP95Ms": None,
        "presentedP99Ms": round(pct([f["FrameTime"] for f in counted], 0.99), 3),
        "frameP99Ms": round(pct([cpu(f) for f in counted], 0.99), 3),
        "frameWorstP95Ms": round(max(pct([cpu(f) for f in w], 0.95) for w in windows), 3),
        "renderSkipPct": None,
        "fps": round(median([1000 * len(w) / sum(f["FrameTime"] for f in w) for w in windows]), 2),
        "gpuP50Ms": pick(lambda f: f["GPUTime"], 0.5),
        "gpuP95Ms": pick(lambda f: f["GPUTime"], 0.95),
        "gpuMainMs": None, "gpuShadowMs": None, "gpuOtherMs": None,
        "renderP50Ms": pick(lambda f: f["RenderThreadTime"], 0.5),
        "updateP50Ms": pick(lambda f: f["GameThreadTime"], 0.5),
        "frameP50Ms": pick(cpu, 0.5),
        "frameP95Ms": pick(cpu, 0.95),
        "mainDraws": None, "shadowDraws": None, "mainTrianglesM": None, "shadowTrianglesM": None,
        "hitchesPerMin": round(hitches / seconds * 60, 2),
        "longTasks": None, "loadMs": None,
        "bridgeCrossingsP50": None, "hostCallsP50": None, "gpuUploadKbP50": None, "jsAllocKbP50": None,
    }


def engine_sha():
    digest = hashlib.sha256()
    with open(os.path.join(UE, "Engine/Binaries/Linux/libUnrealEditor-Engine.so"), "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()[:12]


def fair_run(frames, adapter, samples, setup, uncapped):
    seconds, windows, metrics = metrics_of(frames)
    foreign = [s[1] for s in samples]
    return {
        "report": {"schema": "stress-lab-report/1", "commit": COMMIT, "preset": "real", "layers": LAYERS,
                   "adapter": adapter, "viewport": "1280x720", "counts": COUNTS, "seconds": seconds,
                   "windows": windows, "metrics": metrics},
        "build": {"kind": "native", "sha256": engine_sha(), "commit": COMMIT},
        "load": foreign,
        "dpr": 1,
        "pass": "uncapped" if uncapped else "vsync",
        "setup": setup,
        "loadavg1Peak": max(s[0] for s in samples),
        "void": void_reason(foreign),
    }


def void_reason(foreign):
    avg, peak = sum(foreign) / len(foreign), max(foreign)
    return f"foreign avg {avg:.2f} peak {peak:.2f}" if avg > VOID_AVG or peak > VOID_PEAK else None


# --- commands -------------------------------------------------------------------------------------
def capture(out, setup):
    before = set(glob.glob(os.path.join(LAB, "Saved/Screenshots/**/*.png"), recursive=True))
    locked(lambda: launch("capture", setup, False, os.path.join(LAB, "Saved/capture.log")))
    shots = set(glob.glob(os.path.join(LAB, "Saved/Screenshots/**/*.png"), recursive=True)) - before
    if len(shots) != 1:
        raise SystemExit(f"run: expected one new screenshot, found {sorted(shots)}")
    os.replace(shots.pop(), out)
    log(f"wrote {out}")


def measure(setup, run):
    csv_dir = os.path.join(LAB, "Saved/Profiling/CSV")
    before = set(glob.glob(os.path.join(csv_dir, "*.csv")))
    log_path = os.path.join(LAB, f"Saved/measure-{setup}-{run}.log")
    samples = locked(lambda: launch("measure", setup, True, log_path))
    files = sorted(set(glob.glob(os.path.join(csv_dir, "*.csv"))) - before)
    if len(files) != 1:
        raise SystemExit(f"run: expected one new CSV, found {files}")
    adapter = gpu()[0]
    if adapter not in open(log_path, errors="replace").read():
        raise SystemExit(f"run: the Unreal log never names {adapter}")
    os.makedirs(os.path.join(LAB, "rows"), exist_ok=True)
    stem = os.path.join(LAB, "rows", f"{setup}-uncapped-{run}")
    os.replace(files[0], stem + ".csv")
    result = fair_run(read_csv(stem + ".csv"), adapter, samples, setup, True)
    with open(stem + ".json", "w") as f:
        json.dump(result, f, indent=1)
    m = result["report"]["metrics"]
    log(f"{stem}.json fps {m['fps']} presented p95 {m['presentedP95Ms']} cpu p95 {m['frameP95Ms']} "
        f"gpu p95 {m['gpuP95Ms']} void {result['void']}")


def mean(paths, out):
    runs = [json.load(open(p)) for p in paths]
    valid = [r for r in runs if r["void"] is None]
    if not valid:
        raise SystemExit("run: no valid run")
    first = valid[0]
    def avg(key):
        values = [r["report"]["metrics"][key] for r in valid]
        return None if any(v is None for v in values) else round(sum(values) / len(values), 3)
    report = {**first["report"], "metrics": {k: avg(k) for k in first["report"]["metrics"]},
              "seconds": round(sum(r["report"]["seconds"] for r in valid) / len(valid), 2),
              "windows": round(sum(r["report"]["windows"] for r in valid) / len(valid))}
    foreign = [x for r in valid for x in r["load"]]
    names = [os.path.basename(p) for p, r in zip(paths, runs) if r["void"] is None]
    voided = [f"{os.path.basename(p)} ({r['void']})" for p, r in zip(paths, runs) if r["void"] is not None]
    notes = (f"Unreal 5.8.3 {first['setup']}, {first['pass']} pass, 1280x720 windowed on :0, 60 s settle + 15 s CSV "
             f"profile, mean of {len(valid)} valid run(s) {names}; foreign load avg {sum(foreign) / len(foreign):.2f} "
             f"peak {max(foreign):.2f} (loadavg1 peak {max(r['loadavg1Peak'] for r in valid):.2f}); void (foreign "
             f"avg>12 or peak>18): {voided or 'none'}; gate: no stress-loop fair, load<12 for 60 s, VRAM free>=3 GB + "
             f"util<10% x5 s, measure.lock held. runs: sandbox/stress-lab-unreal/rows/")
    with open(out, "w") as f:
        json.dump({**first, "report": report, "load": foreign, "notes": notes}, f, indent=1)
    log(f"wrote {out}\n{notes}")


def selftest():
    frames = [{"FrameTime": 10.0 + (i % 10), "GameThreadTime": 8.0, "RenderThreadTime": 9.0 + (i % 2),
               "RHIThreadTime": 1.0, "GPUTime": 7.0} for i in range(360)]
    seconds, windows, m = metrics_of(frames)
    assert windows == 3 and seconds == 5.22, (windows, seconds)
    assert m["presentedP50Ms"] == 14.0 and m["presentedP95Ms"] == 19.0, m
    assert m["frameP50Ms"] == 9.0 and m["frameP95Ms"] == 10.0 and m["gpuP95Ms"] == 7.0, m
    assert m["hitchesPerMin"] == 0 and m["mainDraws"] is None
    assert void_reason([5, 19]) and void_reason([13, 13]) and void_reason([5, 17]) is None
    print("selftest ok")


def main(argv):
    flag = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
    if argv[:1] == ["capture"] and len(argv) > 1:
        return capture(os.path.abspath(argv[1]), flag("--setup", "stock"))
    if argv[:1] == ["measure"] and flag("--setup") in SETUPS and flag("--run"):
        return measure(flag("--setup"), flag("--run"))
    if argv[:1] == ["mean"] and flag("--out"):
        return mean([a for a in argv[1:argv.index("--out")]], flag("--out"))
    if argv[:1] == ["selftest"]:
        return selftest()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
