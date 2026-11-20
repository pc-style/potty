# potty

Counts the swears, manners, love and apologies in what you type to coding agents.
Typos count too: `fukcing`, `sh1t`, `f*ck`, `fuuuck`, `f.u.c.k`, `thnaks`, `plz`, `kurwaaa`.
English and Polish.

```text
harness        msgs  swears  manners  love  sorry
Codex           412      31       18     2      1
Claude Code     268      12       40     5      0
total           680      43       58     7      1
per 100                 6.3      8.5   1.0    0.1

swears   fuck 24  shit 11  wtf 6  kurwa 2
manners  please 44  thanks 14
fuzzy    fukcing 3  pelase 1  sh!t 1
```

(Example numbers.)

## Run it

potty needs [Bun](https://bun.sh) 1.2 or newer.

```sh
bunx potty               # counts per harness, and the words behind them
bunx potty log           # by week, plus what your sessions show
bunx potty watch         # each new hit as you type it
bunx potty statusline    # today's counts on one line
bunx potty harnesses     # where potty looks and what it found
bunx potty try "wtf, plz fix thx"
```

Every command has `--help` with its options and examples. The common ones:

| Option                | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `--since 7d`          | Only messages from then on. Also `12h`, `2w`, `3m`, or a date like `2026-11-01`.    |
| `--harness amp,codex` | Only these harnesses.                                                               |
| `--by model`          | For `log`: `day`, `week`, `month`, `hour`, `weekday`, `harness`, `model` or `repo`. |
| `--json`              | JSON instead of a table.                                                            |
| `--no-scan`           | Answer from the index without reading session files.                                |

## What it counts

| Column  | Examples                                                                  |
| ------- | ------------------------------------------------------------------------- |
| swears  | fuck, shit, wtf, kurwa, and their inflections and typos                   |
| manners | please, pls, thanks, thx, ty, proszę, dzięki                              |
| love    | love, `<3`, good job, and praise that opens a message ("perfect, now...") |
| sorry   | sorry, sry, my bad, przepraszam, sorki                                    |

Only what you typed counts. potty drops tool results, code blocks, inline code, URLs,
paths, tag blocks that harnesses inject, subagent and SDK-driven sessions, and the
words of any message longer than 4,000 characters, which is a paste.

## What it reads

| Harness                     | Where                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Amp                         | `~/.local/share/amp/threads`                                                  |
| Claude Code                 | `~/.claude/projects`                                                          |
| Codex                       | `~/.codex/sessions` and `~/.codex/archived_sessions`, including `.zst`        |
| T3 Code                     | `~/.t3/userdata/statev2.sqlite`                                               |
| Zed                         | `threads/threads.db` in Zed's data directory                                  |
| pi                          | `~/.pi/agent/sessions`                                                        |
| opencode                    | `~/.local/share/opencode/opencode.db`                                         |
| Antigravity (`agy`)         | `~/.gemini/antigravity-cli/conversations`                                     |
| eukhe                       | `~/.eukhe/sessions`                                                           |
| Grok, Factory Droid, Cursor | Written from their documented formats, not yet checked against real sessions. |

T3 Code is a front end for other harnesses, so its messages are filed under the
harness that ran them, and a message stored by both is counted once.

Missing a harness? [Open an issue](https://github.com/pc-style/potty/issues/new?template=new-harness.yml)
or add it yourself: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Speed and privacy

The first run reads every session. After that potty rereads only files whose size
or modification time changed, so a rerun takes about a tenth of a second.

Everything stays on your machine. The index holds counts and the matched words,
never your messages.

## Environment

| Variable      | Meaning                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `POTTY_INDEX` | Path of the index. Default: `~/.local/share/potty/index.sqlite`, or under `XDG_DATA_HOME` when set. |
| `NO_COLOR`    | Set to turn colors off. They are also off when output is not a terminal.                            |

## For scripts and agents

- `--json` works on every command. `potty watch --json` prints one JSON object per line.
- Results go to stdout; warnings and errors go to stderr.
- Exit codes: `0` success, `1` failure, `2` wrong usage. A usage error prints a command that works.
- Nothing prompts. `potty try -` reads text from stdin.

```sh
potty scan --since 7d --json | jq .total
# {"msgs": 680, "swear": 43, "manners": 58, "love": 7, "sorry": 1}

potty log --by model --json | jq '.rows[0]'
# {"key": "gpt-6-sol", "msgs": 300, "swear": 12, "manners": 20, "love": 1, "sorry": 0}

echo "thnaks, kurwa" | potty try --json -
# [{"cat": "manners", "root": "thanks", "raw": "thnaks", "kind": "variant"}, ...]
```

`kind` says how a word matched: `exact` (a listed form), `slang` (a listed
abbreviation or misspelling) or `variant` (worked out by the matcher).

## Statusline

Claude Code, in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "bunx potty statusline" } }
```

## Credits

potty follows [devrage](https://github.com/gricha/devrage) and
[devragio](https://github.com/am-will/devragio), which had the idea first.

MIT licensed.
