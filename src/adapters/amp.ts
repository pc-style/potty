import { basename } from "node:path"
import { type Adapter, type Message, type Source, dataHome, fileSource, files, parseTime, repoName } from "./util"

/**
 * ~/.local/share/amp/threads/T-*.json, one JSON document per thread. Amp stopped
 * writing here in 2026; newer threads come from `amp threads export` (see `remote`).
 */
export const amp: Adapter = {
	name: "amp",
	label: "Amp",
	verified: true,
	discover: () =>
		files(dataHome("amp", "threads"), (name) => name.startsWith("T-") && name.endsWith(".json")).flatMap((path) =>
			fileSource("amp", path, async (p) => threadMessages(await Bun.file(p).json(), basename(p, ".json"))),
		),
}

const RESEND_WINDOW = 2 * 60_000
/** Text without the `<post id="M-…"/>` tag the web app appends. */
const bare = (text: string): string => text.replace(/<post\s[^>]*\/>/g, "").trim()

/** User messages that another agent, an automation, a plugin or a subagent sent, not the person. */
const NOT_TYPED = ["fromExecutorThreadID", "fromAutomation", "automationType", "generatedByPlugin", "fromPuck", "fromSubagentToolUseID", "fromSubagentToolUseIDs"]

/** The messages a person typed in one Amp thread, in either the local or the exported format. */
export function threadMessages(thread: any, fallbackId: string): Message[] {
	const session: string = thread?.id ?? fallbackId
	const tree = thread?.env?.initial?.trees?.[0]
	// Cloud threads all run in /home/user/workspace/repo, so the repository URL names the project better.
	const repo = repoName(tree?.repository?.url ?? tree?.uri)
	const threadModel: string | null = thread?.meta?.threadModel?.model?.split("/").at(-1) ?? null
	const messages: any[] = Array.isArray(thread?.messages) ? thread.messages : []
	const out: Array<{ message: Message; resent: boolean }> = []
	// Walk backwards so each user message can take time and model from the reply after it.
	let replyTs = parseTime(thread?.created)
	let replyModel: string | null = threadModel
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === "assistant" && message.usage) {
			replyTs = parseTime(message.usage.timestamp) ?? replyTs
			replyModel = message.usage.model ?? replyModel
		}
		if (message?.role !== "user" || !Array.isArray(message.content)) continue
		const meta = message.meta ?? {}
		if (NOT_TYPED.some((key) => meta[key] !== undefined && meta[key] !== false)) continue
		const text = message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
		if (!text) continue
		const ts = parseTime(meta.sentAt) ?? parseTime(message.createdAt) ?? replyTs
		out.push({ message: { session, ts, model: replyModel, repo, text }, resent: meta.modelSwitch !== undefined })
	}
	out.reverse()
	// Switching model resends the previous message, and people resend a message that seemed stuck; count each once.
	const resend = (m: (typeof out)[number], previous: (typeof out)[number] | undefined): boolean =>
		previous !== undefined &&
		bare(previous.message.text) === bare(m.message.text) &&
		(m.resent || (m.message.ts !== null && previous.message.ts !== null && m.message.ts - previous.message.ts < RESEND_WINDOW))
	return out.filter((m, i) => !resend(m, out[i - 1])).map((m) => m.message)
}

const run = async (args: string[]): Promise<string> => {
	const proc = Bun.spawn(["amp", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	if (code !== 0) throw new Error(`amp ${args.join(" ")}: ${err.trim().split("\n")[0] || `exit ${code}`}`)
	return out
}

const PAGE = 500

/**
 * Every Amp thread of the signed-in account, from `amp threads list`. Each is one
 * source whose size and mtime are its message count and last update, so a rerun
 * exports only threads that changed. Needs the `amp` CLI, a login and the network.
 */
export async function remote(): Promise<Source[]> {
	if (!Bun.which("amp")) throw new Error("the amp CLI is not installed, so --amp-remote cannot list threads")
	const sources: Source[] = []
	for (let offset = 0; ; offset += PAGE) {
		const page = JSON.parse(await run(["threads", "list", "--json", "--include-archived", "--limit", String(PAGE), "--offset", String(offset)])) as Array<{
			id: string
			updated: string
			messageCount: number
		}>
		for (const thread of page) {
			sources.push({
				harness: "amp-remote",
				path: `amp:${thread.id}`,
				size: thread.messageCount,
				mtime: parseTime(thread.updated) ?? 0,
				read: async () => threadMessages(JSON.parse(await run(["threads", "export", thread.id])), thread.id).map((m) => ({ ...m, harness: "amp" })),
			})
		}
		if (page.length < PAGE) return sources
	}
}
