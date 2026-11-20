import { Database, constants } from "bun:sqlite"
import { type Dirent, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

/** One message a person typed to an agent. */
export interface Message {
	readonly session: string
	/** Unix milliseconds, or null when the harness records no time. */
	readonly ts: number | null
	readonly model: string | null
	readonly repo: string | null
	readonly text: string
	/** Set when the store holds messages for several harnesses, as T3 Code's does. */
	readonly harness?: string
	readonly via?: string
	/** True for a copy of a message that the harness itself also stores. */
	readonly mirror?: boolean
}

/** One file or database to scan. `size` and `mtime` decide whether the cached result is still good. */
export interface Source {
	readonly harness: string
	readonly path: string
	readonly size: number
	readonly mtime: number
	readonly read: () => Promise<Message[]>
}

export interface Adapter {
	readonly name: string
	readonly label: string
	/** False when the parser was written from documentation and has not met real data. */
	readonly verified: boolean
	readonly discover: () => Source[]
}

export const home = (...parts: string[]): string => join(process.env["HOME"] ?? homedir(), ...parts)
export const dataHome = (...parts: string[]): string => join(process.env["XDG_DATA_HOME"] ?? home(".local", "share"), ...parts)
export const appSupport = (...parts: string[]): string =>
	process.platform === "darwin" ? home("Library", "Application Support", ...parts) : join(process.env["XDG_CONFIG_HOME"] ?? home(".config"), ...parts)

export const repoName = (cwd: unknown): string | null => (typeof cwd === "string" && cwd ? basename(cwd.replace(/^file:\/\//, "")) || null : null)
export const parseTime = (value: unknown): number | null => {
	if (typeof value === "number") return value < 1e11 ? value * 1000 : value
	if (typeof value !== "string") return null
	const ms = Date.parse(value)
	return Number.isNaN(ms) ? null : ms
}

const list = (dir: string): Dirent[] => {
	try {
		return readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
}
export const subdirs = (dir: string): string[] =>
	list(dir)
		.filter((d) => d.isDirectory())
		.map((d) => join(dir, d.name))

/** Files under `dir` whose name passes `keep`, at most `depth` directories down. */
export function files(dir: string, keep: (name: string) => boolean, depth = 0): string[] {
	const out: string[] = []
	for (const entry of list(dir)) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (depth > 0) out.push(...files(path, keep, depth - 1))
		} else if (keep(entry.name)) out.push(path)
	}
	return out
}

export function fileSource(harness: string, path: string, read: (path: string) => Promise<Message[]>): Source[] {
	try {
		const stat = statSync(path)
		return [{ harness, path, size: stat.size, mtime: Math.floor(stat.mtimeMs), read: () => read(path) }]
	} catch {
		return []
	}
}

/** A SQLite database as one source; its write-ahead log counts toward size and mtime. */
export function dbSource(harness: string, path: string, read: (db: Database) => Message[]): Source[] {
	let size = 0
	let mtime = 0
	for (const file of [path, `${path}-wal`]) {
		try {
			const stat = statSync(file)
			size += stat.size
			mtime = Math.max(mtime, Math.floor(stat.mtimeMs))
		} catch {
			if (file === path) return []
		}
	}
	return [
		{
			harness,
			path,
			size,
			mtime,
			read: async () => {
				const db = openDb(path)
				try {
					return read(db)
				} finally {
					db.close()
				}
			},
		},
	]
}

/** Opens read-only. A database whose owner holds it in WAL mode may refuse, so fall back to an immutable open. */
export function openDb(path: string): Database {
	try {
		const db = new Database(path, { readonly: true })
		db.query("select 1 from sqlite_master limit 1").get()
		return db
	} catch {
		return new Database(`file:${encodeURI(path)}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
	}
}

export const hasTable = (db: Database, table: string): boolean => db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !== null

/** A file's bytes, decompressing `.zst`. */
export async function bytes(path: string): Promise<Buffer> {
	const raw = await Bun.file(path).bytes()
	const data = path.endsWith(".zst") ? await Bun.zstdDecompress(raw) : raw
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export interface Span {
	readonly start: number
	readonly end: number
}

/**
 * The lines that contain any of `needles`, in file order, found by searching the raw
 * bytes. Session logs are mostly tool output, so this skips decoding almost all of them.
 */
export function linesWith(data: Buffer, needles: ReadonlyArray<string>): Span[] {
	const starts = new Map<number, number>()
	for (const needle of needles) {
		for (let at = data.indexOf(needle); at !== -1;) {
			const start = data.lastIndexOf(10, at) + 1
			const newline = data.indexOf(10, at)
			const end = newline === -1 ? data.length : newline
			starts.set(start, end)
			at = end >= data.length ? -1 : data.indexOf(needle, end)
		}
	}
	return [...starts].map(([start, end]) => ({ start, end })).sort((a, b) => a.start - b.start)
}

/** Lines of a JSONL file, decompressing `.zst`. */
export async function lines(path: string): Promise<string[]> {
	const file = Bun.file(path)
	const text = path.endsWith(".zst") ? new TextDecoder().decode(await Bun.zstdDecompress(await file.bytes())) : await file.text()
	return text.split("\n")
}

export const parse = (line: string): any => {
	try {
		return JSON.parse(line)
	} catch {
		return null
	}
}

/** Text of a message body that is a string or a list of `{ type: "text", text }` style parts. */
export function textOf(content: unknown, types: ReadonlyArray<string> = ["text", "input_text"]): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((part) => part && typeof part.text === "string" && (part.type === undefined || types.includes(part.type)))
		.map((part) => part.text)
		.join("\n")
}
