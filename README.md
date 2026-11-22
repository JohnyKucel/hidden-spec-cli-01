# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JohnyKucel/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JohnyKucel/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Agent harnesses apply edits that models write, and models write them in
four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. `mend`
reads all four to one written specification, finds the lines an edit names
even when the model drifted their whitespace or indentation, and changes
every file or none.

Node 22, standard library only, no dependencies. Deterministic: the same
check gives the same exit code, stdout and files every run.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read the patch from standard
input. `--format` is `auto` (the default), `unified`, `search-replace`,
`v4a` or `json`. `--check` reports what would change without writing
anything. `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`
for a move) and `ok: N files`. Exit 1 prints one `error: <code> <path>`
line per failed edit and `failed: k of n edits`, and writes nothing.
Exit 2 prints one line for a usage, missing-patch, format or parse error.
`SPEC.md` is the whole contract.

## Matching

An edit's old lines are found at the first of three tiers where they occur
at least once: exact, ignoring trailing spaces and tabs, ignoring leading
and trailing spaces and tabs. Context lines are written back as the file's
own lines, and at tier 2 the new lines are re-indented to the file's
indentation. A unified hunk takes the occurrence nearest its (possibly
wrong) line number; a SEARCH/REPLACE block needs exactly one occurrence;
a V4A chunk works from a cursor that moves through the file.

## Examples

`examples/` holds one good patch per format and four bad ones, each with
the output `mend` gives. Run the good unified example:

```sh
mkdir -p /tmp/mend-demo && cd /tmp/mend-demo
printf 'one\ntwo\nthree\n' > a.txt
node /path/to/main.ts /path/to/examples/good-unified.patch
cat a.txt
```

## Score it

```sh
node check.ts <practice.json>   # the kit's 100 public practice checks
node scripts/selftest.mjs <practice.json>
```

`selftest.mjs` runs the practice set five rounds in a row (the result must
be identical every round), the good and bad examples, and 48 hand-written
edge cases: CRLF files, files without a final line break, tier-2
re-indentation, nearest-offset hunks, V4A anchors and cursors, moves,
`--check`, `--strict`, and all-or-nothing failure. Its results are recorded
in `SELFTEST.md`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jy3a6hm3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
