import { basename, dirname } from "node:path"
import { type Adapter, type Message, bytes, fileSource, files, home, lines, linesWith, parse, parseTime, repoName, subdirs, textOf } from "./util"

const MODEL = /"model":"([^"]+)"/

/** ~/.claude/projects/<project>/<session>.jsonl. Subagent transcripts live in subdirectories and are skipped. */
export const claude: Adapter = {
	name: "claude",
	label: "Claude Code",
	verified: true,
	discover: () => subdirs(home(".claude", "projects")).flatMap((dir) => files(dir, (name) => name.endsWith(".jsonl")).flatMap((path) => fileSource("claude", path, readClaude))),
}

async function readClaude(path: string): Promise<Message[]> {
	const session = basename(path, ".jsonl")
	const data = await bytes(path)
	const out: Message[] = []
	for (const { start, end } of linesWith(data, ['"type":"user"'])) {
		// Tool results are user-role lines too, and by far the largest; skip them undecoded.
		const tool = data.indexOf('"tool_use_id"', start)
		if (tool !== -1 && tool < end) continue
		const entry = parse(data.toString("utf8", start, end))
		if (entry?.type !== "user" || entry.isSidechain || entry.isMeta) continue
		// Sessions started through the SDK are prompts written by another program.
		if (typeof entry.entrypoint === "string" && entry.entrypoint.startsWith("sdk")) return []
		const text = textOf(entry.message?.content)
		if (text) out.push({ session, ts: parseTime(entry.timestamp), model: modelAfter(data, end), repo: repoName(entry.cwd), text })
	}
	return out
}

/** The model named by the first reply after `offset`: user lines do not say which model they went to. */
function modelAfter(data: Buffer, offset: number): string | null {
	const key = '"model":"'
	for (let at = data.indexOf(key, offset), tries = 0; at !== -1 && tries < 4; at = data.indexOf(key, at + 1), tries++) {
		const model = data.toString("utf8", at + key.length, data.indexOf('"', at + key.length))
		if (/^[\w.:-]+$/.test(model)) return model
	}
	return null
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions, plain or zstd-compressed. */
export const codex: Adapter = {
	name: "codex",
	label: "Codex",
	verified: true,
	discover: () =>
		[home(".codex", "sessions"), home(".codex", "archived_sessions")].flatMap((dir) =>
			files(dir, (name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"), 3).flatMap((path) => fileSource("codex", path, readCodex)),
		),
}

async function readCodex(path: string): Promise<Message[]> {
	const out: Message[] = []
	let session = basename(path)
	let model: string | null = null
	let repo: string | null = null
	const data = await bytes(path)
	for (const { start, end } of linesWith(data, ['"type":"session_meta"', '"type":"turn_context"', '"role":"user"'])) {
		const entry = parse(data.toString("utf8", start, end))
		const payload = entry?.payload
		if (entry?.type === "session_meta") {
			// `exec` runs and subagent threads carry prompts written by another agent.
			if (!payload || payload.source === "exec" || typeof payload.source === "object") return []
			session = payload.id ?? session
			repo = repoName(payload.cwd)
		} else if (entry?.type === "turn_context") {
			if (typeof payload?.model === "string") model = payload.model
			repo = repoName(payload?.cwd) ?? repo
		} else if (entry?.type === "response_item" && payload?.type === "message" && payload.role === "user") {
			// The desktop app wraps what was typed in context sections and puts the request last.
			const text = textOf(payload.content, ["input_text"])
				.split(/^## My request[^\n:]*:/m)
				.at(-1)
			if (text) out.push({ session, ts: parseTime(entry.timestamp), model, repo, text })
		}
	}
	return out
}

/** ~/.pi/agent/sessions/<project>/<session>.jsonl */
export const pi: Adapter = {
	name: "pi",
	label: "pi",
	verified: true,
	discover: () => files(home(".pi", "agent", "sessions"), (name) => name.endsWith(".jsonl"), 1).flatMap((path) => fileSource("pi", path, readPi)),
}

async function readPi(path: string): Promise<Message[]> {
	const out: Message[] = []
	const session = basename(path, ".jsonl")
	let model: string | null = null
	let repo: string | null = null
	for (const line of await lines(path)) {
		if (line.startsWith('{"type":"session"')) repo = repoName(parse(line)?.cwd)
		else if (line.startsWith('{"type":"model_change"')) model = parse(line)?.modelId ?? model
		else if (line.includes('"role":"user"')) {
			const entry = parse(line)
			if (entry?.type !== "message" || entry.message?.role !== "user") continue
			const text = textOf(entry.message.content)
			if (text) out.push({ session, ts: parseTime(entry.timestamp), model, repo, text })
		}
	}
	return out
}

/**
 * ~/.eukhe/sessions/<session>/main.jsonl, a log of commits. A typed message is an
 * entry of kind `pi.user`. Entries carry no time, so each takes the start time of
 * the first task after it, or the time encoded in the session's UUIDv7.
 */
export const eukhe: Adapter = {
	name: "eukhe",
	label: "eukhe",
	verified: true,
	discover: () => subdirs(home(".eukhe", "sessions")).flatMap((dir) => fileSource("eukhe", `${dir}/main.jsonl`, readEukhe)),
}

async function readEukhe(path: string): Promise<Message[]> {
	const session = basename(dirname(path))
	const started = Number.parseInt(session.replace(/-/g, "").slice(0, 12), 16)
	const fallback = started > 1e12 && started < 1e13 ? started : null
	const out: Message[] = []
	let waiting = 0
	for (const line of await lines(path)) {
		const at = /"startedAt":(\d{13})/.exec(line)?.[1]
		if (at && waiting) {
			for (let i = out.length - waiting; i < out.length; i++) out[i] = { ...out[i]!, ts: Number(at) }
			waiting = 0
		}
		if (!line.includes('"kind":"pi.user"')) continue
		for (const write of parse(line)?.writes ?? []) {
			const value = write?.value
			if (write?.type !== "entry" || value?.kind !== "pi.user" || value.byTaskId !== undefined) continue
			for (const message of value.model ?? []) {
				const text = message?.role === "user" ? textOf(message.content) : ""
				if (!text) continue
				out.push({ session, ts: fallback, model: null, repo: null, text })
				waiting++
			}
		}
	}
	return out
}

/**
 * ~/.grok/sessions/<encoded-cwd>/<session>/chat_history.jsonl, per Grok's own user guide.
 * Unverified: every session on the machine this was written on was empty.
 */
export const grok: Adapter = {
	name: "grok",
	label: "Grok",
	verified: false,
	discover: () =>
		subdirs(home(".grok", "sessions")).flatMap((group) =>
			subdirs(group).flatMap((dir) => fileSource("grok", `${dir}/chat_history.jsonl`, (path) => readRoleLines(path, basename(dir), repoName(decodeURIComponent(basename(group)))))),
		),
}

/** ~/.factory/sessions/<project>/<session>.jsonl. Unverified: written from the published format, no local data. */
export const droid: Adapter = {
	name: "droid",
	label: "Factory Droid",
	verified: false,
	discover: () =>
		files(home(".factory", "sessions"), (name) => name.endsWith(".jsonl"), 2).flatMap((path) => fileSource("droid", path, (p) => readRoleLines(p, basename(p, ".jsonl"), null))),
}

/** Generic reader for logs whose lines are `{ role, content }` or `{ message: { role, content } }`. */
async function readRoleLines(path: string, session: string, repo: string | null): Promise<Message[]> {
	const out: Message[] = []
	let model: string | null = null
	for (const line of await lines(path)) {
		if (!line.includes('"user"')) {
			model = (line.length < 4000 ? MODEL.exec(line)?.[1] : undefined) ?? model
			continue
		}
		const entry = parse(line)
		const message = entry?.message ?? entry
		if (message?.role !== "user") continue
		const text = textOf(message.content)
		if (text) out.push({ session, ts: parseTime(entry.timestamp ?? entry.created_at ?? message.timestamp), model, repo: repoName(entry.cwd) ?? repo, text })
	}
	return out
}
