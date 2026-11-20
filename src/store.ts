import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Source } from "./adapters"
import { dataHome } from "./adapters/util"
import { type Category, LEXICON_VERSION } from "./lexicon"
import type { Hit, Kind } from "./match"

/** A scanned message. The index stores which words matched, never the message text. */
export interface Row {
	readonly key: string
	readonly path: string
	readonly harness: string
	readonly session: string
	/** Position in the session, counting from 1. */
	readonly seq: number
	readonly ts: number | null
	readonly model: string | null
	readonly repo: string | null
	readonly hash: string
	readonly via: string | null
	readonly mirror: boolean
	readonly hits: ReadonlyArray<Hit>
}

export type NewRow = Omit<Row, "key" | "path">
export const count = (row: Row, cat: Category): number => row.hits.reduce((n, hit) => n + (hit.cat === cat ? 1 : 0), 0)

// Bump when the tables or what adapters extract changes; every file is then rescanned.
const SCHEMA = 1
const version = SCHEMA * 1000 + LEXICON_VERSION

export function openStore(path = process.env["POTTY_INDEX"] ?? dataHome("potty", "index.sqlite")) {
	mkdirSync(join(path, ".."), { recursive: true })
	const db = new Database(path)
	db.exec(`
		pragma journal_mode = wal;
		pragma synchronous = normal;
		create table if not exists files (path text primary key, harness text not null, size integer not null, mtime integer not null, version integer not null);
		create table if not exists msgs (
			id integer primary key, path text not null, harness text not null, session text not null, seq integer not null,
			ts integer, model text, repo text, hash text not null, via text, mirror integer not null
		);
		create table if not exists hits (msg integer not null, cat text not null, root text not null, raw text not null, kind text not null);
		create index if not exists msgs_path on msgs (path);
		create index if not exists hits_msg on hits (msg);
	`)
	const forget = db.transaction((path: string) => {
		db.query("delete from hits where msg in (select id from msgs where path = ?)").run(path)
		db.query("delete from msgs where path = ?").run(path)
		db.query("delete from files where path = ?").run(path)
	})
	const insertMsg = db.query("insert into msgs (path, harness, session, seq, ts, model, repo, hash, via, mirror) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	const insertHit = db.query("insert into hits (msg, cat, root, raw, kind) values (?, ?, ?, ?, ?)")
	const insertFile = db.query("insert into files (path, harness, size, mtime, version) values (?, ?, ?, ?, ?)")

	return {
		/** Sources whose cached result no longer matches the file on disk. */
		stale(sources: ReadonlyArray<Source>): Source[] {
			const known = new Map(
				(db.query("select path, size, mtime, version from files").all() as Array<{ path: string; size: number; mtime: number; version: number }>).map((f) => [f.path, f]),
			)
			return sources.filter((s) => {
				const f = known.get(s.path)
				return !f || f.size !== s.size || f.mtime !== s.mtime || f.version !== version
			})
		},
		/** Drops files that are gone from disk, for the given harnesses. */
		prune(harnesses: ReadonlyArray<string>, present: ReadonlySet<string>): void {
			const rows = db.query("select path, harness from files").all() as Array<{ path: string; harness: string }>
			for (const row of rows) if (harnesses.includes(row.harness) && !present.has(row.path)) forget(row.path)
		},
		replace: db.transaction((source: Source, rows: ReadonlyArray<NewRow>) => {
			forget(source.path)
			insertFile.run(source.path, source.harness, source.size, source.mtime, version)
			for (const row of rows) {
				const { lastInsertRowid } = insertMsg.run(source.path, row.harness, row.session, row.seq, row.ts, row.model, row.repo, row.hash, row.via, row.mirror ? 1 : 0)
				for (const hit of row.hits) insertHit.run(lastInsertRowid, hit.cat, hit.root, hit.raw, hit.kind)
			}
		}),
		rows(): Row[] {
			const hits = new Map<number, Hit[]>()
			for (const h of db.query("select msg, cat, root, raw, kind from hits").all() as Array<{ msg: number; cat: Category; root: string; raw: string; kind: Kind }>) {
				const list = hits.get(h.msg)
				const hit = { cat: h.cat, root: h.root, raw: h.raw, kind: h.kind }
				if (list) list.push(hit)
				else hits.set(h.msg, [hit])
			}
			const rows = db.query("select * from msgs").all() as Array<Omit<Row, "hits" | "mirror" | "key"> & { id: number; mirror: number }>
			return rows.map(({ id, mirror, ...row }) => ({ ...row, key: `${row.path}\u0000${row.session}\u0000${row.seq}`, mirror: mirror === 1, hits: hits.get(id) ?? [] }))
		},
		close: () => db.close(),
	}
}

export type Store = ReturnType<typeof openStore>
