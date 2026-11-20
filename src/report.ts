import { ADAPTERS, label } from "./adapters"
import { CATEGORIES, type Category } from "./lexicon"
import { type Row, type Store, count } from "./store"

export interface Filter {
	readonly since?: number | undefined
	readonly harnesses?: ReadonlyArray<string> | undefined
}

const MIRROR_WINDOW = 10 * 60_000

/**
 * The indexed messages, with T3 Code's copies folded into the harness's own record
 * of the same message (same text, within ten minutes) so nothing counts twice.
 */
export function load(store: Store, filter: Filter = {}): Row[] {
	// An Amp thread fetched with --amp-remote replaces its copy in the old local folder.
	const rows = store.rows()
	const exported = new Set(rows.filter((row) => row.path.startsWith("amp:")).map((row) => row.session))
	const all = exported.size ? rows.filter((row) => row.harness !== "amp" || row.path.startsWith("amp:") || !exported.has(row.session)) : rows
	const natives = new Map<string, Row[]>()
	for (const row of all) {
		if (row.mirror) continue
		const list = natives.get(row.hash)
		if (list) list.push(row)
		else natives.set(row.hash, [row])
	}
	const throughT3 = new Set<string>()
	const dropped = new Set<string>()
	for (const row of all) {
		if (!row.mirror) continue
		const twin = natives.get(row.hash)?.find((n) => !throughT3.has(n.key) && (n.ts === null || row.ts === null || Math.abs(n.ts - row.ts) <= MIRROR_WINDOW))
		if (!twin) continue
		throughT3.add(twin.key)
		dropped.add(row.key)
	}
	return all
		.filter((row) => !dropped.has(row.key))
		.map((row) => (throughT3.has(row.key) ? { ...row, via: "t3code" } : row))
		.filter((row) => (filter.since === undefined || (row.ts !== null && row.ts >= filter.since)) && (!filter.harnesses || filter.harnesses.includes(row.harness)))
}

export type Counts = { msgs: number } & Record<Category, number>
const zero = (): Counts => ({ msgs: 0, swear: 0, manners: 0, love: 0, sorry: 0 })

export function tally(rows: ReadonlyArray<Row>, keyOf: (row: Row) => string | null): Map<string, Counts> {
	const out = new Map<string, Counts>()
	for (const row of rows) {
		const key = keyOf(row)
		if (key === null) continue
		let counts = out.get(key)
		if (!counts) out.set(key, (counts = zero()))
		counts.msgs++
		for (const hit of row.hits) counts[hit.cat]++
	}
	return out
}

/** How often each word was used: by root, and separately the spellings the matcher had to work out. */
export function words(rows: ReadonlyArray<Row>): { roots: Record<Category, Array<[string, number]>>; fuzzy: Array<[string, number, Category]> } {
	const roots = Object.fromEntries(CATEGORIES.map((cat) => [cat, new Map<string, number>()])) as Record<Category, Map<string, number>>
	const fuzzy = new Map<string, [number, Category]>()
	for (const row of rows) {
		for (const hit of row.hits) {
			roots[hit.cat].set(hit.root, (roots[hit.cat].get(hit.root) ?? 0) + 1)
			if (hit.kind === "variant") fuzzy.set(hit.raw, [(fuzzy.get(hit.raw)?.[0] ?? 0) + 1, hit.cat])
		}
	}
	const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])
	return {
		roots: Object.fromEntries(CATEGORIES.map((cat) => [cat, sorted(roots[cat])])) as Record<Category, Array<[string, number]>>,
		fuzzy: [...fuzzy].map(([raw, [n, cat]]): [string, number, Category] => [raw, n, cat]).sort((a, b) => b[1] - a[1]),
	}
}

// Rendering

const color = process.stdout.isTTY === true && !process.env["NO_COLOR"]
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
export const dim = paint(2)
export const TINT: Record<Category, (s: string) => string> = { swear: paint(31), manners: paint(32), love: paint(35), sorry: paint(33) }
export const HEADING: Record<Category, string> = { swear: "swears", manners: "manners", love: "love", sorry: "sorry" }
const num = (n: number): string => n.toLocaleString("en-US")
const per100 = (n: number, msgs: number): string => (msgs ? ((n / msgs) * 100).toFixed(1) : "0.0")

function countsTable(heading: string, entries: ReadonlyArray<[string, Counts]>, total?: Counts): string[] {
	const width = Math.max(heading.length, ...entries.map(([name]) => name.length), 5)
	const line = (name: string, c: Counts): string =>
		name.padEnd(width) + dim(num(c.msgs).padStart(8)) + CATEGORIES.map((cat) => TINT[cat](num(c[cat]).padStart(HEADING[cat].length + 2))).join("")
	return [
		dim(heading.padEnd(width) + "msgs".padStart(8) + CATEGORIES.map((cat) => HEADING[cat].padStart(HEADING[cat].length + 2)).join("")),
		...entries.map(([name, c]) => line(name, c)),
		...(total ? [line("total", total)] : []),
	]
}

const sum = (list: Iterable<Counts>): Counts => {
	const total = zero()
	for (const c of list) {
		total.msgs += c.msgs
		for (const cat of CATEGORIES) total[cat] += c[cat]
	}
	return total
}

const day = (ts: number): string => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

/** The default report: one row per harness, then the words behind the numbers. */
export function ledger(rows: ReadonlyArray<Row>, everyWord = false): string {
	if (!rows.length) return "No messages found. Run `potty harnesses` to see where potty looked."
	const byHarness = [...tally(rows, (row) => row.harness)].sort((a, b) => b[1].msgs - a[1].msgs)
	const total = sum(byHarness.map(([, c]) => c))
	const out = countsTable(
		"harness",
		byHarness.map(([name, c]) => [label(name), c]),
		total,
	)
	out.push(
		dim("per 100".padEnd(out[0]!.replace(/\x1b\[\d+m/g, "").indexOf("msgs") + 4)) +
			CATEGORIES.map((cat) => dim(per100(total[cat], total.msgs).padStart(HEADING[cat].length + 2))).join(""),
		"",
	)

	const { roots, fuzzy } = words(rows)
	const limit = everyWord ? Infinity : 8
	const list = (items: ReadonlyArray<readonly [string, number]>): string => {
		const shown = items.slice(0, limit).map(([word, n]) => `${word} ${num(n)}`)
		return shown.join("  ") + (items.length > limit ? dim(`  +${items.length - limit} more`) : "")
	}
	for (const cat of CATEGORIES) if (roots[cat].length) out.push(TINT[cat](HEADING[cat].padEnd(9)) + list(roots[cat]))
	if (fuzzy.length) out.push(dim("fuzzy".padEnd(9)) + list(fuzzy.map(([raw, n]) => [raw, n] as const)))

	const times = rows.flatMap((row) => (row.ts === null ? [] : [row.ts]))
	const sessions = new Set(rows.map((row) => `${row.harness}/${row.session}`)).size
	const viaT3 = rows.filter((row) => row.via === "t3code").length
	const span = times.length ? `, ${day(Math.min(...times))} to ${day(Math.max(...times))}` : ""
	out.push("", dim(`${num(total.msgs)} messages in ${num(sessions)} sessions${span}.${viaT3 ? ` ${num(viaT3)} ${viaT3 === 1 ? "was" : "were"} sent through T3 Code.` : ""}`))
	return out.join("\n")
}

export const BUCKETS = ["day", "week", "month", "hour", "weekday", "harness", "model", "repo"] as const
export type Bucket = (typeof BUCKETS)[number]
const CHRONOLOGICAL: ReadonlySet<Bucket> = new Set(["day", "week", "month", "hour", "weekday"])
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const pad2 = (n: number): string => String(n).padStart(2, "0")
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

function bucketKey(row: Row, by: Bucket): string | null {
	if (by === "harness") return label(row.harness)
	if (by === "model") return row.model
	if (by === "repo") return row.repo
	if (row.ts === null) return null
	const d = new Date(row.ts)
	if (by === "hour") return `${pad2(d.getHours())}:00`
	if (by === "weekday") return `${(d.getDay() + 6) % 7}`
	if (by === "month") return ymd(d).slice(0, 7)
	if (by === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
	return ymd(d)
}

/** Counts per bucket. Time buckets come oldest first (the last `limit` of them); the others largest first. */
export function buckets(rows: ReadonlyArray<Row>, by: Bucket, limit: number): Array<[string, Counts]> {
	const entries = [...tally(rows, (row) => bucketKey(row, by))]
	if (!CHRONOLOGICAL.has(by)) return entries.sort((a, b) => b[1].msgs - a[1].msgs).slice(0, limit)
	entries.sort((a, b) => a[0].localeCompare(b[0]))
	if (by === "weekday") return entries.map(([key, c]) => [WEEKDAYS[Number(key)]!, c])
	return by === "hour" ? entries : entries.slice(-limit)
}

export interface SessionFacts {
	readonly worst: { readonly harness: string; readonly ts: number | null; readonly swears: number; readonly msgs: number }
	readonly sessionsWithSwear: number
	/** Position in the session of its first swear, median over sessions that have one. */
	readonly medianFirstSwear: number
	/** Manners per 100 messages before the first swear and from it on. Null with under 20 messages on either side. */
	readonly manners: { readonly before: number; readonly after: number } | null
}

/** What the sessions show, computed from the rows passed in. Null when none of them has a swear. */
export function sessionFacts(rows: ReadonlyArray<Row>): SessionFacts | null {
	const sessions = new Map<string, Row[]>()
	for (const row of rows) {
		const key = `${row.harness}/${row.session}`
		const list = sessions.get(key)
		if (list) list.push(row)
		else sessions.set(key, [row])
	}
	let worst: { rows: Row[]; swears: number } | null = null
	const firstAt: number[] = []
	const before = { msgs: 0, manners: 0 }
	const after = { msgs: 0, manners: 0 }
	for (const list of sessions.values()) {
		list.sort((a, b) => a.seq - b.seq)
		const swears = list.reduce((n, row) => n + count(row, "swear"), 0)
		if (!swears) continue
		if (!worst || swears > worst.swears) worst = { rows: list, swears }
		const first = list.findIndex((row) => count(row, "swear") > 0)
		firstAt.push(first + 1)
		list.forEach((row, i) => {
			const side = i < first ? before : after
			side.msgs++
			side.manners += count(row, "manners")
		})
	}
	if (!worst) return null
	firstAt.sort((a, b) => a - b)
	const rate = (side: typeof before): number => Math.round((side.manners / side.msgs) * 1000) / 10
	return {
		worst: { harness: worst.rows[0]!.harness, ts: worst.rows.find((row) => row.ts !== null)?.ts ?? null, swears: worst.swears, msgs: worst.rows.length },
		sessionsWithSwear: firstAt.length,
		medianFirstSwear: firstAt[Math.floor((firstAt.length - 1) / 2)]!,
		manners: before.msgs >= 20 && after.msgs >= 20 ? { before: rate(before), after: rate(after) } : null,
	}
}

/** Counts over time or by model, repo or harness, followed by what the sessions show. */
export function timeline(rows: ReadonlyArray<Row>, by: Bucket, limit: number): string {
	const entries = buckets(rows, by, limit)
	if (!entries.length) return "Nothing to show for that selection."
	const out: string[] = []
	if (CHRONOLOGICAL.has(by)) {
		const width = 14
		const peak = (cat: Category): number => Math.max(1, ...entries.map(([, c]) => c[cat]))
		const bar = (cat: Category, n: number): string => TINT[cat](("█".repeat(n ? Math.max(1, Math.round((n / peak(cat)) * width)) : 0) + ` ${num(n)}`).padEnd(width + 7))
		const name = Math.max(by.length, ...entries.map(([key]) => key.length))
		out.push(dim(by.padEnd(name) + "msgs".padStart(7) + "  " + "swears".padEnd(width + 7) + "manners"))
		for (const [key, c] of entries) out.push(key.padEnd(name) + dim(num(c.msgs).padStart(7)) + "  " + bar("swear", c.swear) + bar("manners", c.manners).trimEnd())
	} else {
		out.push(...countsTable(by, entries))
	}
	const facts = sessionFacts(rows)
	if (!facts) return out.join("\n")
	const note = (name: string, text: string) => out.push(dim(name.padEnd(16)) + text)
	const { worst } = facts
	out.push("")
	note(
		"worst session",
		`${label(worst.harness)}${worst.ts ? `, ${day(worst.ts)}` : ""}: ${num(worst.swears)} ${worst.swears === 1 ? "swear" : "swears"} in ${num(worst.msgs)} messages`,
	)
	note(
		"first swear",
		`message ${facts.medianFirstSwear} of a session (median over ${num(facts.sessionsWithSwear)} ${facts.sessionsWithSwear === 1 ? "session" : "sessions"} that had one)`,
	)
	if (facts.manners) note("manners", `${facts.manners.before.toFixed(1)} per 100 messages before the first swear, ${facts.manners.after.toFixed(1)} from it on`)
	return out.join("\n")
}

export const totals = (rows: ReadonlyArray<Row>): Counts => sum(tally(rows, () => "all").values())

/** One line for a prompt or statusline: the counts, zeros left out. */
export function statusline(rows: ReadonlyArray<Row>): string {
	const total = totals(rows)
	const parts = CATEGORIES.filter((cat) => total[cat]).map((cat) => TINT[cat](`${num(total[cat])} ${total[cat] === 1 && cat === "swear" ? "swear" : HEADING[cat]}`))
	return parts.length ? parts.join("  ") : dim("clean today")
}

export interface HarnessInfo {
	readonly name: string
	readonly label: string
	/** False when the parser was written from documentation and has not met real data. */
	readonly verified: boolean
	/** Session files or databases found on this machine. */
	readonly files: number
	readonly msgs: number
	readonly note: string
}

/** Where potty looks, and what it found there. */
export function harnessList(rows: ReadonlyArray<Row>, found: ReadonlyMap<string, number>): HarnessInfo[] {
	const counts = tally(rows, (row) => row.harness)
	return ADAPTERS.map((adapter) => {
		const files = found.get(adapter.name) ?? 0
		const t3 = adapter.name === "t3code"
		const note = t3
			? "filed under the harness each message ran on"
			: !files && counts.has(adapter.name)
				? "only through T3 Code"
				: !files
					? "nothing found on this machine"
					: adapter.verified
						? ""
						: "parser not yet checked against real data"
		const msgs = t3 ? rows.filter((row) => row.via === "t3code").length : (counts.get(adapter.name)?.msgs ?? 0)
		return { name: adapter.name, label: adapter.label, verified: adapter.verified, files, msgs, note }
	})
}

export function harnesses(list: ReadonlyArray<HarnessInfo>): string {
	const width = Math.max(...list.map((h) => h.label.length))
	return [
		dim("harness".padEnd(width) + "files".padStart(7) + "msgs".padStart(8)),
		...list.map((h) => h.label.padEnd(width) + dim(num(h.files).padStart(7)) + num(h.msgs).padStart(8) + (h.note ? dim(`  ${h.note}`) : "")),
	].join("\n")
}
