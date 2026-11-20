# potty

A Bun CLI that counts swears, manners, love and apologies in what the user typed
to coding agents. TypeScript, Effect 4, `bun:sqlite`. No build step: the published
package runs `src/cli.ts` directly.

## Commands

- `bun install`
- `bun run check`: typecheck (`tsrs`), lint (`oxlint`), format check (`oxfmt`), tests. Run it before finishing.
- `bun run format`: fix formatting.
- `bun test test/match.test.ts`: matcher tests only.
- `bun src/cli.ts <command> --help`: every command documents its flags and examples.
- `bun run gen:safe`: regenerate `src/safe.gen.ts` (needs the network).

## Layout

- `src/lexicon.ts`: the word lists. `src/match.ts`: normalising and typo matching. `src/safe.gen.ts`: generated, never edit by hand.
- `src/adapters/`: one reader per harness. `util.ts` has the `Adapter`, `Source` and `Message` types.
- `src/sync.ts`: scans changed sources into the index. `src/store.ts`: the SQLite index. `src/report.ts`: tables and JSON data. `src/cli.ts`: argument parsing and output.

## Rules

- Never read the user's real session directories to build fixtures, and never put real session text, paths or names in the repo. Fixtures are hand-written.
- When running the CLI during development, set `POTTY_INDEX` to a scratch path. `HOME` can point at a fixture directory, as `test/sync.test.ts` does.
- After changing `src/lexicon.ts`, bump `LEXICON_VERSION` and run `bun run gen:safe`. After changing what an adapter extracts or the index tables, bump `SCHEMA` in `src/store.ts`.
- The index stores counts and matched words only. Do not add message text to it.
- Every command supports `--json`; keep table output and JSON output built from the same data in `src/report.ts`.
- Usage mistakes throw `UsageError` with a working example and exit 2. Results go to stdout, warnings and errors to stderr.
- A new adapter starts with `verified: false` until it has been run against real sessions.

`CONTRIBUTING.md` has the steps for adding a harness and changing the word lists.
