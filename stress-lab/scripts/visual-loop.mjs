#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DECISIONS = new Set([
  "continue",
  "replan",
  "accepted",
  "stalled",
  "budget-exhausted",
  "unavailable",
]);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function fail(message) {
  throw new InputError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(root, candidate, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    fail(`${label} escapes its declared artifact root`);
  return resolved;
}

async function assertInside(root, candidate, label) {
  const resolved = safeRelative(root, candidate, label);
  const existing = await realpath(resolved).catch(() => undefined);
  if (existing !== undefined) safeRelative(root, existing, label);
  else {
    const parent = await realpath(path.dirname(resolved)).catch(() => undefined);
    if (parent !== undefined && parent !== root) safeRelative(root, parent, label);
  }
  return resolved;
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function acquireLock(recordFile) {
  const lockFile = `${recordFile}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
      return async () => rm(lockFile, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = JSON.parse(await readFile(lockFile, "utf8").catch(() => "{}"));
      const pid = Number(owner.pid);
      let live = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          live = true;
        } catch {
          live = false;
        }
      }
      if (live) throw new InputError("run is locked by another writer");
      await rm(lockFile, { force: true });
    }
  }
  throw new InputError("could not acquire run lock");
}

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  if (argv.length !== 2 || argv[0] !== "--record" || argv[1] === "")
    fail("usage: node scripts/visual-loop.mjs --record RUN.json");
  return { record: argv[1] };
}

function ensureRecord(record) {
  if (
    !record ||
    record.schemaVersion !== SCHEMA_VERSION ||
    typeof record.runId !== "string" ||
    typeof record.projectRoot !== "string"
  )
    fail("record schemaVersion, runId and projectRoot are required");
  if (!path.isAbsolute(record.projectRoot)) fail("record projectRoot must be absolute");
  if (typeof record.builderIdentity !== "string" || record.builderIdentity === "")
    fail("record builderIdentity is required");
  if (
    !record.limits ||
    !Number.isInteger(record.limits.maxRounds) ||
    record.limits.maxRounds < 1 ||
    !Number.isInteger(record.limits.maxImageRequests) ||
    record.limits.maxImageRequests < 1
  )
    fail("record limits.maxRounds and limits.maxImageRequests are required");
  if (!record.limits.deadlineAt || Number.isNaN(Date.parse(record.limits.deadlineAt)))
    fail("record limits.deadlineAt is required");
  if (
    !record.target ||
    typeof record.target.path !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.target.sha256 ?? "")
  )
    fail("record target path and SHA-256 are required");
  if (!Array.isArray(record.rounds)) fail("record rounds must be an array");
  record.requests ??= {};
  for (const key of ["pending", "completed", "unknown", "failed"]) {
    if (!Array.isArray(record.requests[key])) fail(`record requests.${key} must be an array`);
  }
  return record;
}

function recordRoots(record, recordFile) {
  const projectRoot = path.resolve(record.projectRoot);
  const artifactRoot = path.resolve(
    projectRoot,
    record.artifactRoot ?? path.relative(projectRoot, path.dirname(recordFile)),
  );
  if (artifactRoot !== projectRoot) safeRelative(projectRoot, artifactRoot, "artifactRoot");
  return { projectRoot, artifactRoot };
}

function countRequests(record) {
  return (
    record.requests.pending.length +
    record.requests.completed.length +
    record.requests.unknown.length
  );
}

async function fileHash(root, relativePath, label) {
  const file = await assertInside(root, path.resolve(root, relativePath), label);
  const bytes = await readFile(file).catch(() => {
    throw new InputError(`${label} is missing: ${relativePath}`);
  });
  if (bytes.length === 0) fail(`${label} is empty: ${relativePath}`);
  return { file, sha256: sha256(bytes) };
}

function scoreFor(review) {
  const categories = {
    framing: review.framing,
    lighting: review.lighting,
    material: review.material,
    finish: review.finish,
  };
  const bounds = { framing: 3, lighting: 3, material: 3, finish: 1 };
  for (const [name, maximum] of Object.entries(bounds)) {
    if (!Number.isInteger(categories[name]) || categories[name] < 0 || categories[name] > maximum)
      fail(`critic score '${name}' must be an integer from 0 to ${maximum}`);
  }
  return categories.framing + categories.lighting + categories.material + categories.finish;
}

function normalizedGaps(gaps) {
  return JSON.stringify(
    (Array.isArray(gaps) ? gaps : [])
      .map((gap) => (typeof gap === "string" ? gap : JSON.stringify(gap)))
      .sort(),
  );
}

function allAssertionsPassed(functional) {
  if (!functional || !Array.isArray(functional.assertions) || functional.assertions.length === 0)
    return false;
  return functional.assertions.every(
    (assertion) => assertion?.passed === true || assertion?.status === "passed",
  );
}

function performancePassed(performance) {
  if (!performance || !Number.isFinite(performance.targetFps) || performance.targetFps <= 0)
    return false;
  if (!Number.isFinite(performance.displayMaxFps) || performance.displayMaxFps <= 0) return false;
  if (!Array.isArray(performance.windows) || performance.windows.length === 0) return false;
  return performance.windows.every(
    (window) => Number.isFinite(window?.fps) && window.fps >= performance.targetFps,
  );
}

async function validateRound(record, round, roots) {
  if (
    !round ||
    typeof round.round !== "number" ||
    !Number.isInteger(round.round) ||
    round.round < 1
  )
    fail("round number is invalid");
  const target = await fileHash(roots.projectRoot, record.target.path, "target");
  if (target.sha256 !== record.target.sha256)
    return { accepted: false, decision: "unavailable", reason: "target-hash-mismatch" };
  if (
    !round.capture ||
    typeof round.capture.path !== "string" ||
    !/^[a-f0-9]{64}$/u.test(round.capture.sha256 ?? "")
  )
    return { accepted: false, decision: "unavailable", reason: "capture-receipt-missing" };
  const capture = await fileHash(roots.projectRoot, round.capture.path, "capture");
  if (capture.sha256 !== round.capture.sha256)
    return { accepted: false, decision: "unavailable", reason: "capture-hash-mismatch" };
  if (round.capture.targetSha256 !== record.target.sha256)
    return { accepted: false, decision: "unavailable", reason: "capture-target-stale" };
  if (
    record.currentSourceSha256 !== undefined &&
    round.capture.sourceSha256 !== record.currentSourceSha256
  )
    return { accepted: false, decision: "unavailable", reason: "capture-source-stale" };
  if (!round.platform || !round.adapter)
    return { accepted: false, decision: "unavailable", reason: "capture-platform-missing" };
  if (!allAssertionsPassed(round.functional))
    return { accepted: false, decision: "unavailable", reason: "functional-observation-missing" };
  if (!round.review || !["PASS", "REQUEST_CHANGES", "NOT_OBSERVED"].includes(round.review.status))
    return { accepted: false, decision: "unavailable", reason: "independent-review-missing" };
  if (
    round.review.criticIdentity === undefined ||
    round.review.criticIdentity === record.builderIdentity
  )
    return {
      accepted: false,
      decision: "unavailable",
      reason: "independent-review-identity-missing",
    };
  if (
    round.review.targetSha256 !== record.target.sha256 ||
    round.review.captureSha256 !== round.capture.sha256
  )
    return { accepted: false, decision: "unavailable", reason: "reviewed-artifact-stale" };
  const score = scoreFor(round.review);
  if (!performancePassed(round.performance))
    return {
      accepted: false,
      decision: "unavailable",
      reason: "performance-observation-missing",
      score,
    };
  if (round.review.status !== "PASS")
    return {
      accepted: false,
      decision: "continue",
      reason:
        round.review.status === "NOT_OBSERVED"
          ? "independent-review-not-observed"
          : "critic-requested-changes",
      score,
      gaps: round.review.gaps ?? [],
    };
  if (score < 8)
    return {
      accepted: false,
      decision: "continue",
      reason: "visual-score-below-8",
      score,
      gaps: round.review.gaps ?? [],
    };
  if ((round.review.blockers ?? []).length > 0)
    return {
      accepted: false,
      decision: "continue",
      reason: "visual-blocker-present",
      score,
      gaps: round.review.gaps ?? [],
    };
  return {
    accepted: true,
    decision: "accepted",
    reason: "all-required-evidence-observed",
    score,
    gaps: round.review.gaps ?? [],
  };
}

function reconcilePending(record) {
  if (record.requests.pending.length === 0) return false;
  const now = new Date().toISOString();
  for (const pending of record.requests.pending.splice(0))
    record.requests.unknown.push({ ...pending, finishedAt: now, category: "interrupted" });
  return true;
}

function boundedDecision(record, result) {
  if (result.accepted) return result;
  if (countRequests(record) >= record.limits.maxImageRequests)
    return { ...result, decision: "budget-exhausted", reason: "image-request-limit" };
  if (record.rounds.length >= record.limits.maxRounds)
    return { ...result, decision: "budget-exhausted", reason: "round-limit" };
  if (Date.now() >= Date.parse(record.limits.deadlineAt))
    return { ...result, decision: "budget-exhausted", reason: "deadline" };
  return result;
}

function applyGapStall(record, result) {
  if (
    !result.gaps ||
    result.gaps.length === 0 ||
    record.rounds.length < 2 ||
    result.decision !== "continue"
  )
    return result;
  const previous = record.rounds.at(-2);
  if (normalizedGaps(previous?.review?.gaps) !== normalizedGaps(result.gaps)) return result;
  const latestRound = record.rounds.at(-1).round;
  if (record.replanUsed === true && record.replanRound === latestRound)
    return { ...result, decision: "replan", reason: "repeated-gaps-require-one-replan" };
  if (record.replanUsed === true)
    return { ...result, decision: "stalled", reason: "replan-did-not-improve-repeated-gaps" };
  record.replanUsed = true;
  record.replanRound = latestRound;
  return { ...result, decision: "replan", reason: "repeated-gaps-require-one-replan" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/visual-loop.mjs --record RUN.json");
    return;
  }
  const recordFile = path.resolve(process.cwd(), options.record);
  const record = ensureRecord(JSON.parse(await readFile(recordFile, "utf8")));
  const roots = recordRoots(record, recordFile);
  const release = await acquireLock(recordFile);
  try {
    const reconciled = reconcilePending(record);
    const latest = record.rounds.at(-1);
    let result =
      latest === undefined
        ? { decision: "continue", reason: "no-round-evidence", gaps: [] }
        : await validateRound(record, latest, roots);
    result = applyGapStall(record, result);
    result = boundedDecision(record, result);
    if (reconciled && result.decision === "continue") {
      result = { ...result, decision: "unavailable", reason: "interrupted-request-reconciled" };
    }
    if (!DECISIONS.has(result.decision)) fail(`invalid decision '${result.decision}'`);
    const decision = { at: new Date().toISOString(), round: latest?.round ?? 0, ...result };
    record.decision = decision;
    record.decisionHistory.push(decision);
    await atomicWriteJson(recordFile, record);
    console.log(JSON.stringify(decision));
  } finally {
    await release();
  }
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      action: "failed",
      decision: "unavailable",
      category: "invalid-input",
      message: error instanceof Error ? error.message : "invalid record",
    }),
  );
  process.exitCode = 2;
});
