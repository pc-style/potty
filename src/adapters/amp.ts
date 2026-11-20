import { basename } from "node:path"
import { type Adapter, type Message, dataHome, fileSource, files, parseTime, repoName } from "./util"

/** ~/.local/share/amp/threads/T-*.json, one JSON document per thread. */
export const amp: Adapter = {
	name: "amp",
	label: "Amp",
	verified: true,
	discover: () => files(dataHome("amp", "threads"), (name) => name.startsWith("T-") && name.endsWith(".json")).flatMap((path) => fileSource("amp", path, read)),
}

async function read(path: string): Promise<Message[]> {
	const thread = await Bun.file(path).json()
	const session: string = thread.id ?? basename(path, ".json")
	const repo = repoName(thread.env?.initial?.trees?.[0]?.uri)
	const out: Message[] = []
	// User messages carry no time or model; the reply that follows has both.
	let ts = parseTime(thread.created)
	let model: string | null = null
	const messages: any[] = Array.isArray(thread.messages) ? thread.messages : []
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === "assistant" && message.usage) {
			ts = parseTime(message.usage.timestamp) ?? ts
			model = message.usage.model ?? model
		}
		if (message?.role !== "user" || !Array.isArray(message.content)) continue
		const text = message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
		// Handoff threads open with a summary the previous thread wrote.
		if (!text || text.startsWith("Continuing work from thread T-")) continue
		out.push({ session, ts, model, repo, text })
	}
	return out.reverse()
}
