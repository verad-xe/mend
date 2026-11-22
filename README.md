# mend

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/verad-xe/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/verad-xe/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies an edit an AI model wrote to a tree of text files, whether the model wrote it as a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON. It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, leading-and-trailing-whitespace-insensitive, with re-indentation at the third tier), and writes every change or none: a failed edit changes nothing, and the edits after it still run so every failure is reported. See `SPEC.md` for the full contract.

## Run it

Node 22, standard library only, no dependencies:

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory (the root of the tree); when it is absent or `-`, the patch is read from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`, which detects the format), `--check` (same output and exit code, writes nothing), `--strict` (exact line matching only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and `ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`. Exit 2 is a usage, no-patch, format or parse error.
