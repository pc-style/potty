# Contributing

potty needs [Bun](https://bun.sh) 1.2 or newer.

```sh
bun install
bun run check     # typecheck (tsrs), lint (oxlint), format check (oxfmt), tests
bun src/cli.ts    # run from source
```

`bun run format` fixes formatting. CI runs `bun run check` on Linux and macOS.

## Privacy rule

Session files hold private conversations. Never commit real session text, file
paths or names: not in fixtures, tests, docs, issues or commit messages. Write
fixtures by hand, as `test/sync.test.ts` does.

## Add a harness

1. Find where the harness stores sessions and what one user message looks like.
2. Add an `Adapter` to `src/adapters/jsonl.ts` (JSON and JSONL logs) or
   `src/adapters/sqlite.ts` (SQLite), and list it in `src/adapters/index.ts`.
   `discover()` returns one `Source` per file or database; `read()` returns the
   messages a person typed, with time, model and repo where the harness records them.
3. Leave out anything the user did not type: tool results, injected context,
   subagent prompts, sessions driven by an SDK or another agent.
4. Set `verified: true` only after running it against real sessions. Otherwise
   set it to `false`; `potty harnesses` then says the parser is unchecked.
5. Add a hand-written fixture for it to `test/sync.test.ts`.
6. Add a row to the table in `README.md`.

To use local data while developing, point `POTTY_INDEX` at a scratch file so your
real index is untouched: `POTTY_INDEX=/tmp/potty.sqlite bun src/cli.ts harnesses`.

## Change the word lists

Everything the matcher knows is in `src/lexicon.ts`.

1. Edit the entries. `potty try "some text"` shows what the matcher makes of a sentence.
2. Add a case to `test/match.test.ts`: one that must count, and a real word near
   it that must not.
3. Bump `LEXICON_VERSION` so existing indexes are rescanned.
4. Run `bun run gen:safe`. It rebuilds `src/safe.gen.ts`, the list of real words
   that sit one typo away from a listed form.

## Tests

Test behavior a user relies on: what counts, what does not, and that a message is
counted once. A matcher fix needs one case that fails without it.
