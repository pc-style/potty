import type { Database } from "bun:sqlite"
import { basename } from "node:path"
import { type Adapter, type Message, appSupport, dataHome, dbSource, files, hasTable, home, parse, parseTime, repoName, subdirs } from "./util"

/** ~/.local/share/opencode/opencode.db: `message` rows hold the role, `part` rows the text. */
export const opencode: Adapter = {
	name: "opencode",
	label: "opencode",
	verified: true,
	discover: () =>
		[dataHome("opencode", "opencode.db"), appSupport("opencode", "opencode.db")].flatMap((path) =>
			dbSource("opencode", path, (db) => {
				const rows = db
					.query(
						`select m.session_id as session, m.time_created as ts, m.data as message, p.data as part, s.directory as directory
						 from message m join part p on p.message_id = m.id left join session s on s.id = m.session_id
						 where json_extract(m.data, '$.role') = 'user' and json_extract(p.data, '$.type') = 'text'
						 order by m.time_created, p.time_created`,
					)
					.all() as Array<{ session: string; ts: number; message: string; part: string; directory: string | null }>
				return rows.flatMap((row): Message[] => {
					const part = parse(row.part)
					if (!part?.text || part.synthetic) return []
					return [{ session: row.session, ts: parseTime(row.ts), model: parse(row.message)?.model?.modelID ?? null, repo: repoName(row.directory), text: part.text }]
				})
			}),
		),
}

const T3_PROVIDERS: Record<string, string> = {
	claudeAgent: "claude",
	claude: "claude",
	codex: "codex",
	antigravity: "antigravity",
	amp: "amp",
	cursor: "cursor",
	opencode: "opencode",
	grok: "grok",
	pi: "pi",
}

/**
 * ~/.t3/userdata/statev2.sqlite. T3 Code is a front end for other harnesses, so each
 * message is filed under the harness that ran it and marked as a mirror: when that
 * harness stored the same message itself, the report keeps one copy.
 */
export const t3code: Adapter = {
	name: "t3code",
	label: "T3 Code",
	verified: true,
	discover: () => {
		const sources = [home(".t3", "userdata", "statev2.sqlite"), home(".t3", "dev", "statev2.sqlite")].flatMap((path) => dbSource("t3code", path, readT3))
		return sources.length ? sources : dbSource("t3code", home(".t3", "userdata", "state.sqlite"), readT3)
	},
}

function readT3(db: Database): Message[] {
	const message = (row: { thread: string; ts: string; text: string; provider: string | null; model: string | null; root: string | null }): Message => ({
		session: row.thread,
		ts: parseTime(row.ts),
		model: row.model,
		repo: repoName(row.root),
		text: row.text,
		harness: T3_PROVIDERS[row.provider ?? ""] ?? row.provider?.replace(/^acpRegistry_/, "") ?? "t3code",
		via: "t3code",
		mirror: true,
	})
	if (hasTable(db, "orchestration_v2_projection_messages")) {
		const rows = db
			.query(
				`select m.thread_id as thread, m.created_at as ts, json_extract(m.payload_json, '$.text') as text,
				        json_extract(m.payload_json, '$.createdBy') as author,
				        coalesce(r.provider, t.default_provider) as provider,
				        coalesce(json_extract(r.payload_json, '$.modelSelection.model'), json_extract(t.payload_json, '$.modelSelection.model')) as model,
				        p.workspace_root as root
				 from orchestration_v2_projection_messages m
				 left join orchestration_v2_projection_runs r on r.run_id = m.run_id
				 left join orchestration_v2_projection_threads t on t.thread_id = m.thread_id
				 left join projection_projects p on p.project_id = t.project_id
				 where m.role = 'user' order by m.created_at`,
			)
			.all() as Array<Parameters<typeof message>[0] & { author: string | null }>
		return rows.filter((row) => row.text && (row.author ?? "user") === "user").map(message)
	}
	if (!hasTable(db, "projection_thread_messages")) return []
	const rows = db
		.query(
			`select m.thread_id as thread, m.created_at as ts, m.text as text,
			        json_extract(t.model_selection_json, '$.instanceId') as provider, json_extract(t.model_selection_json, '$.model') as model, p.workspace_root as root
			 from projection_thread_messages m
			 left join projection_threads t on t.thread_id = m.thread_id
			 left join projection_projects p on p.project_id = t.project_id
			 where m.role = 'user' order by m.created_at`,
		)
		.all() as Array<Parameters<typeof message>[0]>
	return rows.filter((row) => row.text).map(message)
}

/** Zed's agent threads: threads.db, one zstd-compressed JSON document per thread. Messages carry no time of their own. */
export const zed: Adapter = {
	name: "zed",
	label: "Zed",
	verified: true,
	discover: () =>
		dbSource("zed", process.platform === "darwin" ? appSupport("Zed", "threads", "threads.db") : dataHome("zed", "threads", "threads.db"), (db) => {
			const rows = db.query("select id, created_at, updated_at, folder_paths, data_type, data from threads where parent_id is null").all() as Array<{
				id: string
				created_at: string | null
				updated_at: string
				folder_paths: string | null
				data_type: string
				data: Uint8Array
			}>
			return rows.flatMap((row): Message[] => {
				const bytes = row.data_type === "zstd" ? Bun.zstdDecompressSync(row.data) : row.data
				const thread = parse(new TextDecoder().decode(bytes))
				const ts = parseTime(row.created_at ?? row.updated_at)
				const repo = repoName(row.folder_paths?.split("\n")[0])
				return (thread?.messages ?? []).flatMap((entry: any): Message[] => {
					const text = (entry?.User?.content ?? [])
						.map((part: any) => part?.Text)
						.filter((t: unknown) => typeof t === "string")
						.join("\n")
					return text ? [{ session: row.id, ts, model: thread.model?.model ?? null, repo, text }] : []
				})
			})
		}),
}

/**
 * Antigravity (the `agy` CLI and the IDE) keeps one SQLite file per conversation whose
 * steps are protobuf. Step type 14 is user input: field 19.2 is the text and field
 * 5.1.1 the time in seconds. Field numbers were read off real conversations, not a schema.
 */
export const antigravity: Adapter = {
	name: "antigravity",
	label: "Antigravity",
	verified: true,
	discover: () => {
		const own = [home(".gemini", "antigravity-cli", "conversations"), home(".gemini", "antigravity", "conversations")]
		const underT3 = subdirs(home(".t3", "userdata", "providers", "antigravity")).map((dir) => `${dir}/antigravity-acp/conversations`)
		return [...own.map((dir) => ({ dir, via: undefined })), ...underT3.map((dir) => ({ dir, via: "t3code" }))].flatMap(({ dir, via }) =>
			files(dir, (name) => name.endsWith(".db")).flatMap((path) => dbSource("antigravity", path, (db) => readAntigravity(db, basename(path, ".db"), via))),
		)
	},
}

type Field = { field: number; value: bigint | Uint8Array }
function protobuf(bytes: Uint8Array): Field[] {
	const out: Field[] = []
	let i = 0
	const varint = (): bigint => {
		let result = 0n
		for (let shift = 0n; i < bytes.length; shift += 7n) {
			const byte = bytes[i++]!
			result |= BigInt(byte & 0x7f) << shift
			if (!(byte & 0x80)) break
		}
		return result
	}
	while (i < bytes.length) {
		const key = Number(varint())
		const wire = key & 7
		if (wire === 0) out.push({ field: key >> 3, value: varint() })
		else if (wire === 1) i += 8
		else if (wire === 5) i += 4
		else if (wire === 2) {
			const length = Number(varint())
			out.push({ field: key >> 3, value: bytes.subarray(i, i + length) })
			i += length
		} else break
	}
	return out
}
const child = (fields: Field[], field: number): Field[] => {
	const value = fields.find((f) => f.field === field)?.value
	return value instanceof Uint8Array ? protobuf(value) : []
}

function readAntigravity(db: Database, session: string, via: string | undefined): Message[] {
	if (!hasTable(db, "steps")) return []
	let repo: string | null = null
	if (hasTable(db, "trajectory_metadata_blob")) {
		const blob = (db.query("select data from trajectory_metadata_blob limit 1").get() as { data: Uint8Array } | null)?.data
		repo = repoName(blob ? /file:\/\/(\/[^\u0000-\u001f"]+)/.exec(new TextDecoder().decode(blob))?.[1] : null)
	}
	const rows = db.query("select step_payload as payload from steps where step_type = 14 order by idx").all() as Array<{ payload: Uint8Array | null }>
	return rows.flatMap((row): Message[] => {
		if (!row.payload) return []
		const step = protobuf(row.payload)
		const text = child(step, 19).find((f) => f.field === 2)?.value
		if (!(text instanceof Uint8Array)) return []
		const seconds = child(child(step, 5), 1).find((f) => f.field === 1)?.value
		return [{ session, ts: typeof seconds === "bigint" ? Number(seconds) * 1000 : null, model: null, repo, text: new TextDecoder().decode(text), ...(via ? { via } : {}) }]
	})
}

/**
 * Cursor keeps chat bubbles in the `cursorDiskKV` table of globalStorage/state.vscdb:
 * key `bubbleId:<composer>:<bubble>`, JSON value with `type` 1 for the user.
 * Unverified: Cursor is not installed on the machine this was written on.
 */
export const cursor: Adapter = {
	name: "cursor",
	label: "Cursor",
	verified: false,
	discover: () =>
		dbSource("cursor", appSupport("Cursor", "User", "globalStorage", "state.vscdb"), (db) => {
			if (!hasTable(db, "cursorDiskKV")) return []
			const rows = db.query("select key, value from cursorDiskKV where key like 'bubbleId:%'").all() as Array<{ key: string; value: string | Uint8Array | null }>
			return rows.flatMap((row): Message[] => {
				const bubble = parse(typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value ?? new Uint8Array()))
				if (bubble?.type !== 1 || typeof bubble.text !== "string" || !bubble.text) return []
				return [
					{
						session: row.key.split(":")[1] ?? "cursor",
						ts: parseTime(bubble.createdAt ?? bubble.timingInfo?.clientStartTime),
						model: bubble.modelInfo?.modelName ?? null,
						repo: null,
						text: bubble.text,
					},
				]
			})
		}),
}
