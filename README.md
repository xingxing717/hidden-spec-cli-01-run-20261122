# mend — one patch tool for every AI edit format

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xingxing717/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xingxing717/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a single-file command-line tool that applies the edits AI models write — in all four formats they actually produce — to a tree of files:

- **unified diff** (whose line numbers are routinely wrong),
- **SEARCH/REPLACE blocks**,
- **V4A** patches,
- **JSON tool calls**.

It implements the competition's `SPEC.md` exactly: three-tier matching to find the real target lines when the stated ones drift, all-or-nothing atomicity (every file changes or none does), and byte-exact stdout / exit codes.

## Layout

- `main.ts` — the whole tool (the entrypoint; run as `node main.ts [arguments]`)
- `runner.ts` — the kit's harness driver, unchanged
- `SPEC.md` — the specification the tool is built to

Verified locally against the kit's practice set (3 trials, 100/100 checks) plus 113 hand-written edge cases covering the corners of the spec the practice set does not reach.

Entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). MIT licensed.
