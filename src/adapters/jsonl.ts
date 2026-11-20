import { basename, dirname, join } from "node:path"
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

const primeSessions = (): string => {
	const env = process.env
	const dir = env["PRIME_AGENT_CODING_AGENT_SESSION_DIR"] ?? env["PRIME_AGENT_SESSION_DIR"]
	if (dir) return dir
	const agentDir = env["PRIME_AGENT_CODING_AGENT_DIR"]
	return agentDir ? join(agentDir, "sessions") : home(".prime", "agent", "sessions")
}

/**
 * prime-agent, a fork of pi: ~/.prime/agent/sessions/<session>.jsonl in pi's format.
 * Unverified: read from its source, no local sessions to check against.
 */
export const prime: Adapter = {
	name: "prime",
	label: "prime-agent",
	verified: false,
	discover: () => files(primeSessions(), (name) => name.endsWith(".jsonl"), 1).flatMap((path) => fileSource("prime", path, readPi)),
}

async function readPi(path: string): Promise<Message[]> {
	const out: Message[] = []
	const session = basename(path, ".jsonl")
	let model: string | null = null
	let repo: string | null = null
	for (const line of await lines(path)) {
		if (line.startsWith('{"type":"session"')) {
			const header = parse(line)
			// Subagent sessions carry prompts written by the parent agent.
			if (header?.parentSession || (typeof header?.rlmDepth === "number" && header.rlmDepth > 0)) return []
			repo = repoName(header?.cwd)
		} else if (line.startsWith('{"type":"model_change"')) model = parse(line)?.modelId ?? model
		else if (line.includes('"role":"user"')) {
			const entry = parse(line)
			if (entry?.type !== "message" || entry.message?.role !== "user") continue
			const text = textOf(entry.message.content)
			if (text) out.push({ session, ts: parseTime(entry.message.timestamp ?? entry.timestamp), model, repo, text })
		}
	}
	return out
}

/**
 * ~/.eukhe/sessions/<session>/main.jsonl, a log of commits. A message is an entry of
 * kind `pi.user`; eukhe tags inputs it wrote itself with `data.origin`, and only
 * untagged, `user` and `loop` inputs come from the user. ~/.eukhe/chat repeats the
 * same messages, so it is not read.
 */
export const eukhe: Adapter = {
	name: "eukhe",
	label: "eukhe",
	verified: true,
	discover: () => subdirs(home(".eukhe", "sessions")).flatMap((dir) => fileSource("eukhe", `${dir}/main.jsonl`, readEukhe)),
}

const TYPED_ORIGINS = new Set(["user", "loop"])

async function readEukhe(path: string): Promise<Message[]> {
	const dir = dirname(path)
	const session = basename(dir)
	const settings = await eukheSettings(dir)
	const out: Message[] = []
	let waiting = 0 // messages not yet answered, so not yet tied to a model
	const data = await bytes(path)
	for (const { start, end } of linesWith(data, ['"kind":"pi.user"', '"kind":"pi.assistant"'])) {
		for (const write of parse(data.toString("utf8", start, end))?.writes ?? []) {
			const value = write?.value
			if (write?.type !== "entry") continue
			if (value?.kind === "pi.assistant") {
				const model = value.model?.find((m: any) => typeof m?.model === "string")?.model
				if (model && waiting) for (let i = out.length - waiting; i < out.length; i++) out[i] = { ...out[i]!, model }
				if (model) waiting = 0
				continue
			}
			if (value?.kind !== "pi.user") continue
			const origin = value.data?.origin?.kind
			if (origin !== undefined && !TYPED_ORIGINS.has(origin)) continue
			for (const message of value.model ?? []) {
				const text = message?.role === "user" ? textOf(message.content) : ""
				if (!text) continue
				out.push({ session, ts: parseTime(message.timestamp), model: settings.model, repo: settings.repo, text })
				waiting++
			}
		}
	}
	return out
}

/** The session's settings document, one of its doc-N.jsonl files: the first record's value holds `cwd` and `model`. */
async function eukheSettings(dir: string): Promise<{ repo: string | null; model: string | null }> {
	for (const path of files(dir, (name) => /^doc-\d+\.jsonl$/.test(name))) {
		const first = (await Bun.file(path).slice(0, 8192).text()).split("\n")[0] ?? ""
		if (!first.includes('"cwd"')) continue
		const value = parse(first)?.payload?.content?.value
		if (typeof value?.cwd === "string") return { repo: repoName(value.cwd), model: value.model?.modelId ?? null }
	}
	return { repo: null, model: null }
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
