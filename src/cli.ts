#!/usr/bin/env bun
import { Effect, Schedule } from "effect"
import pkg from "../package.json"
import { ADAPTERS, label } from "./adapters"
import { CATEGORIES } from "./lexicon"
import { clean, scan } from "./match"
import { BUCKETS, type Bucket, HEADING, TINT, buckets, dim, harnessList, harnesses, ledger, load, sessionFacts, statusline, tally, timeline, totals, words } from "./report"
import { type Store, openStore } from "./store"
import { type SyncResult, sync } from "./sync"

const COMMANDS = ["scan", "log", "watch", "statusline", "harnesses", "try"] as const
type Command = (typeof COMMANDS)[number]
const NAMES = ADAPTERS.map((a) => a.name).join(", ")

const SINCE = "  --since <when>     only messages from then on: 7d, 12h, 2w, 3m, or a date like 2026-11-01"
const HARNESS = `  --harness <names>  only these, comma-separated: ${NAMES}`
const JSON_FLAG = "  --json             print JSON instead of a table"
const NO_SCAN = "  --no-scan          answer from the index as it is, without reading session files"
const AMP_REMOTE = "  --amp-remote       also fetch Amp threads with `amp threads export` (needs a login; the first run takes about a second per thread). Or set POTTY_AMP_REMOTE=1"

const HELP: Record<Command | "top", string> = {
	top: `potty counts the swears, manners, love and apologies in what you type to coding agents.

Usage: potty [command] [options]

Commands:
  scan         counts per harness and the words behind them (the default)
  log          counts over time, or by model, repo or harness
  watch        print each new hit as it is typed
  statusline   today's counts on one line
  harnesses    where potty looks and what it found there
  try          show what the matcher finds in a piece of text

Run potty <command> --help for a command's options and examples.

Options:
  --help, -h      show help
  --version, -v   print the version

Exit codes: 0 success, 1 failure, 2 wrong usage. Tables go to stdout, warnings and errors to stderr.

Examples:
  potty
  potty --since 7d --json
  potty log --by model`,
	scan: `potty scan: counts per harness, then the words behind them.

Usage: potty [scan] [options]

Options:
${SINCE}
${HARNESS}
  --all              list every word, not the top eight
${JSON_FLAG}
${NO_SCAN}
${AMP_REMOTE}

Examples:
  potty
  potty scan --amp-remote
  potty scan --since 7d
  potty scan --harness amp,codex --all
  potty scan --json | jq .total.swear`,
	log: `potty log: counts over time, or by model, repo or harness, plus what the sessions show.

Usage: potty log [options]

Options:
  --by <bucket>      ${BUCKETS.join(", ")} (default: week)
  --limit <n>        rows to show (default: 12; hour and weekday always show all)
${SINCE}
${HARNESS}
${JSON_FLAG}
${NO_SCAN}
${AMP_REMOTE}

Examples:
  potty log
  potty log --by day --since 14d
  potty log --by model --limit 5
  potty log --by repo --json`,
	watch: `potty watch: print each new hit as it is typed. Runs until interrupted.

Usage: potty watch [options]

Options:
${HARNESS}
  --json             one JSON object per line, one per message that has a hit

Examples:
  potty watch
  potty watch --harness claude
  potty watch --json`,
	statusline: `potty statusline: today's counts on one line, for a shell prompt or an agent's statusline.

Usage: potty statusline [options]

Options:
${HARNESS}
${JSON_FLAG}
${NO_SCAN}

Examples:
  potty statusline
  potty statusline --no-scan
  potty statusline --json`,
	harnesses: `potty harnesses: every harness potty knows, the session files found for it, and the messages counted.

Usage: potty harnesses [options]

Options:
${JSON_FLAG}
${NO_SCAN}

Examples:
  potty harnesses
  potty harnesses --json`,
	try: `potty try: show what the matcher finds in a piece of text. Reads no session files.

Usage: potty try <text>
       potty try -        (read the text from stdin)

Options:
${JSON_FLAG}

Examples:
  potty try "wtf is this fukcing sh1t, plz fix thx"
  echo "dzieki, kurwa" | potty try -
  potty try --json "thnaks <3"`,
}

const FLAGS: Record<Command, ReadonlyArray<string>> = {
	scan: ["since", "harness", "all", "json", "no-scan", "amp-remote"],
	log: ["by", "limit", "since", "harness", "json", "no-scan", "amp-remote"],
	watch: ["harness", "json"],
	statusline: ["harness", "json", "no-scan"],
	harnesses: ["json", "no-scan", "amp-remote"],
	try: ["json"],
}
const TAKES_VALUE = new Set(["since", "harness", "by", "limit"])

/** A mistake in how potty was called. Printed with an invocation that works. */
class UsageError extends Error {
	constructor(
		message: string,
		readonly example: string,
	) {
		super(message)
	}
}

interface Options {
	readonly command: Command
	readonly show: "help" | "version" | null
	readonly json: boolean
	readonly scan: boolean
	readonly ampRemote: boolean
	readonly all: boolean
	readonly since: number | undefined
	readonly harnesses: ReadonlyArray<string> | undefined
	readonly by: Bucket
	readonly limit: number
	readonly text: ReadonlyArray<string>
}

function parseSince(value: string): number {
	const relative = /^(\d+)([hdwm])$/.exec(value)
	if (relative) return Date.now() - Number(relative[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[relative[2] as "h" | "d" | "w" | "m"]
	const absolute = Date.parse(value)
	if (Number.isNaN(absolute)) throw new UsageError(`--since ${value}: not a date or a span.`, "potty --since 7d    or    potty --since 2026-11-01")
	return absolute
}

function parseArgs(argv: ReadonlyArray<string>): Options {
	const flags = new Map<string, string>()
	const positional: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		if (arg === "-h") flags.set("help", "true")
		else if (arg === "-v") flags.set("version", "true")
		else if (!arg.startsWith("--")) positional.push(arg)
		else {
			const [name = "", inline] = arg.slice(2).split("=")
			if (!TAKES_VALUE.has(name)) flags.set(name, "true")
			else {
				const value = inline ?? argv[++i]
				if (value === undefined || value === "") throw new UsageError(`--${name} needs a value.`, `potty ${positional[0] ?? "scan"} --help`)
				flags.set(name, value)
			}
		}
	}
	const first = positional[0] === "help" ? positional[1] : positional[0]
	if (first !== undefined && !COMMANDS.includes(first as Command)) throw new UsageError(`Unknown command "${first}". Commands: ${COMMANDS.join(", ")}.`, "potty --help")
	const command = (first ?? "scan") as Command
	const show = flags.has("version") ? "version" : flags.has("help") || positional[0] === "help" ? "help" : null
	for (const name of flags.keys()) {
		if (name !== "help" && name !== "version" && !FLAGS[command].includes(name)) {
			throw new UsageError(`potty ${command} has no --${name} option. It takes: ${FLAGS[command].map((f) => `--${f}`).join(", ")}.`, `potty ${command} --help`)
		}
	}
	const only = flags.get("harness")?.split(",").filter(Boolean)
	const unknown = only?.find((name) => !ADAPTERS.some((a) => a.name === name))
	if (unknown) throw new UsageError(`Unknown harness "${unknown}". Known: ${NAMES}.`, `potty ${command} --harness amp,codex`)
	const by = flags.get("by") ?? "week"
	if (!BUCKETS.includes(by as Bucket)) throw new UsageError(`--by ${by}: use one of ${BUCKETS.join(", ")}.`, "potty log --by model")
	const limit = Number(flags.get("limit") ?? 12)
	if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit ${flags.get("limit")}: use a whole number above zero.`, "potty log --limit 20")
	const since = flags.get("since")
	return {
		command,
		show,
		json: flags.has("json"),
		scan: !flags.has("no-scan"),
		ampRemote: flags.has("amp-remote") || process.env["POTTY_AMP_REMOTE"] === "1",
		all: flags.has("all"),
		since: since === undefined ? undefined : parseSince(since),
		harnesses: only,
		by: by as Bucket,
		limit,
		text: positional.slice(first === undefined ? 0 : positional.indexOf(first) + 1),
	}
}

const print = (value: unknown): void => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
const startOfToday = (): number => new Date().setHours(0, 0, 0, 0)
const warn = (result: SyncResult): void => {
	for (const failure of result.failures) console.error(`potty: could not read ${failure.path}: ${String(failure.cause).split("\n")[0]}`)
}

const watch = (store: Store, options: Options) =>
	Effect.gen(function* () {
		yield* sync(store, { only: options.harnesses })
		const seen = new Set(load(store).map((row) => row.key))
		if (!options.json) console.error(dim("watching. ctrl-c to stop."))
		yield* Effect.repeat(
			Effect.gen(function* () {
				warn(yield* sync(store, { only: options.harnesses }))
				const rows = load(store, { harnesses: options.harnesses })
				const today = rows.filter((row) => row.ts !== null && row.ts >= startOfToday())
				for (const row of rows) {
					if (seen.has(row.key)) continue
					seen.add(row.key)
					if (!row.hits.length) continue
					const ts = row.ts ?? Date.now()
					if (options.json) console.log(JSON.stringify({ ts: new Date(ts).toISOString(), harness: row.harness, session: row.session, hits: row.hits, today: totals(today) }))
					else
						console.log(
							`${dim(new Date(ts).toLocaleTimeString("en-GB"))}  ${label(row.harness).padEnd(12)} ${row.hits.map((hit) => TINT[hit.cat](hit.raw)).join(" ")}  ${dim("today")} ${statusline(today)}`,
						)
				}
			}),
			Schedule.spaced("2 seconds"),
		)
	})

const run = (options: Options) =>
	Effect.gen(function* () {
		const { command, json } = options
		if (command === "try") {
			const text = options.text.length === 1 && options.text[0] === "-" ? yield* Effect.promise(() => Bun.stdin.text()) : options.text.join(" ")
			const hits = scan(clean(text))
			if (json) return print(hits)
			return print(
				hits.length
					? hits.map((hit) => `${TINT[hit.cat](HEADING[hit.cat].padEnd(8))} ${hit.raw}${hit.raw === hit.root ? "" : dim(` (${hit.root}, ${hit.kind})`)}`).join("\n")
					: "nothing",
			)
		}
		const store = openStore()
		if (command === "watch") return yield* watch(store, options)
		if (options.scan) {
			const tty = process.stderr.isTTY === true
			const progress =
				options.ampRemote && tty ? (done: number, total: number) => process.stderr.write(`\rreading ${done}/${total} sessions${done === total ? "\n" : ""}`) : undefined
			warn(yield* sync(store, { ampRemote: options.ampRemote, ...(progress ? { progress } : {}) }))
		}

		if (command === "harnesses") {
			const list = harnessList(load(store), new Map(ADAPTERS.map((a) => [a.name, a.discover().length])))
			return print(json ? list : harnesses(list))
		}
		const rows = load(store, { since: command === "statusline" ? startOfToday() : options.since, harnesses: options.harnesses })
		if (command === "statusline") return print(json ? totals(rows) : statusline(rows))
		if (command === "log") {
			if (!json) return print(timeline(rows, options.by, options.limit))
			return print({ by: options.by, rows: buckets(rows, options.by, options.limit).map(([key, counts]) => ({ key, ...counts })), sessions: sessionFacts(rows) })
		}
		if (!json) return print(ledger(rows, options.all))
		const { roots, fuzzy } = words(rows)
		print({
			total: totals(rows),
			harnesses: Object.fromEntries(tally(rows, (row) => row.harness)),
			words: Object.fromEntries(CATEGORIES.map((cat) => [cat, Object.fromEntries(roots[cat])])),
			fuzzy: Object.fromEntries(fuzzy.map(([raw, n]) => [raw, n])),
		})
	})

try {
	const options = parseArgs(process.argv.slice(2))
	if (options.show === "version") print(pkg.version)
	else if (options.show === "help") print(HELP[process.argv.slice(2).some((arg) => COMMANDS.includes(arg as Command)) ? options.command : "top"])
	else if (options.command === "try" && !options.text.length) throw new UsageError("potty try needs some text.", 'potty try "wtf, plz fix"    or    echo "wtf" | potty try -')
	else await Effect.runPromise(run(options))
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`potty: ${error.message}\n  ${error.example}`)
		process.exit(2)
	}
	console.error(`potty: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
