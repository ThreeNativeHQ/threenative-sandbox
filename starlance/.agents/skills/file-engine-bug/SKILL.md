---
name: file-engine-bug
description: File a confirmed @threenative/* engine bug on ThreeNativeHQ/threenative using the user's own gh CLI session, and move a game-side patch for it upstream. Use when doctor and a minimal repro separate an engine bug from a game or machine problem, when you have pasted output proving it, or when a patch in patches/ fixes one.
---

# Filing an engine bug

A confirmed engine bug is filed upstream in the same turn you proved it — on the user's behalf,
under the user's own `gh` session. Never create an account, never request a token, never open a
browser flow: `gh` is already authenticated as the user, and that is the identity the report
carries. Keep the report factual; it goes out in their name.

## 1. Confirm it is an engine bug

`npx threenative doctor` and `npx @threenative/playtest doctor` separate project, machine, and
engine failures. It is an engine bug when an `@threenative/*` API is broken, missing, or acts
against its contract (capability detail or `AGENTS.md`), and a minimal repro shows it — not a
fix that lives in this game's source, and not a machine problem doctor names.

Implement the workaround first and continue the game (`AGENTS.md`: never stall on a framework
bug). Filing does not wait for the workaround to be clean.

## 2. A patch is temporary — ship the fix through one PR

A fix inside `@threenative/*` may **start** as a game-side patch
(`patches/@threenative+<package>@<version>.patch`, wired through pnpm `patchedDependencies`, every
hunk commented with the game it came from) so you can iterate and measure it against the game. The
patch is temporary: **once the fixes are settled** — measured, reviewed, regression checks green —
move them into the engine **through one pull request** on the ThreeNative repository, batching every
settled hunk with the checks that prove it rather than opening one PR per fix. Delete the game
patch when a release carrying the merged fixes is pinned. A mechanism that stays in a game patch is
a bug in the process: the next game hits the same wall.

## 3. Search before filing

```sh
gh issue list --repo ThreeNativeHQ/threenative --state open --search "<two or three keywords>"
```

An open issue already covering it: add your repro and output as a comment
(`gh issue comment <number> --body-file <file>`) instead of a new report.

## 4. File it

Write the body to a file first; quoting goes through `--body-file`, never inline:

```sh
gh issue create --repo ThreeNativeHQ/threenative \
  --title "<area>: <what is wrong, stated as behaviour>" \
  --body-file bug-report.md
```

The body carries, in this order:

- **Expected** — what the capability's contract says happens.
- **Actual** — what happened, with the exact error id (`TN_*`) and the output you ran (doctor,
  playtest, perf) pasted, not summarised.
- **Repro** — the smallest game code that shows it, and which template it reproduces in.
- **Environment** — platform and target, browser and adapter for web, `@threenative/*` versions
  from the project's `package.json`.
- **Workaround** — what the game shipped with to keep moving.

## 5. When not to file

- `gh auth status` fails or `gh` is missing: do not authenticate for the user and do not stall —
  hand them the drafted title and body file and name the one command that files it.
- The bug is real but you cannot prove it with pasted output yet: file nothing. Report it to the
  user as suspected, with the repro to run.

The final summary to the user names the issue URL, or the reason no issue exists.
