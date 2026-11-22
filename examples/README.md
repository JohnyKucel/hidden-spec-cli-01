# Examples

Each patch is run in a fresh directory holding `a.txt` with
`one`, `two`, `three` on three lines — except `bad-ambiguous`, which runs
with `a.txt` holding `two` twice. Run one with:

```sh
node main.ts examples/good-unified.patch
```

## Good — each exits 0 and rewrites `two` as `2`

| File | Format | Expected stdout |
| --- | --- | --- |
| `good-unified.patch` | unified diff | `M a.txt` + `ok: 1 file` |
| `good-search-replace.patch` | SEARCH/REPLACE | `M a.txt` + `ok: 1 file` |
| `good-v4a.patch` | V4A, anchored on `one` | `M a.txt` + `ok: 1 file` |
| `good-json.patch` | JSON tool call, one line | `M a.txt` + `ok: 1 file` |

## Bad — each fails the way the spec says

| File | Expected stdout | Exit |
| --- | --- | --- |
| `bad-no-match.patch` | `error: no-match a.txt` + `failed: 1 of 1 edits` | 1 |
| `bad-ambiguous.patch` | `error: ambiguous a.txt` + `failed: 1 of 1 edits` | 1 |
| `bad-unsafe.patch` | `error: unsafe ../escape.txt` + `failed: 1 of 1 edits` | 1 |
| `bad-parse.patch` | `error: parse 2` (no `=======` after SEARCH) | 2 |

In every bad case `a.txt` is left untouched: a failed edit changes
nothing, and when any edit fails no file is written at all.
