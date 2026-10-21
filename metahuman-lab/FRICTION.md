
**0.3.6 attempt, 2026-10-21 (PRD-637): the tarball stays.** Registry 0.3.6 installs once the old local
`three@0.185.1` patch is dropped (core 0.3.6 applies its own), but `pnpm test` fails with
`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`: a playtest observation this game asserts is not produced by the
native engine default. Repoint to npm when that observation exists on the native engine. The package.json,
lockfile and workspace file are back on the committed lane tarball pins.
