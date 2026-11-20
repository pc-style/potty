import { Database } from "bun:sqlite"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { load, tally } from "../src/report"
import { openStore } from "../src/store"
import { sync } from "../src/sync"

// A throwaway home directory holding one small session per harness format.
const home = mkdtempSync(join(tmpdir(), "potty-"))
const realHome = process.env["HOME"]
const put = (path: string, lines: unknown[]) => {
	mkdirSync(dirname(join(home, path)), { recursive: true })
	writeFileSync(join(home, path), lines.map((line) => JSON.stringify(line)).join("\n"))
}
const at = "2026-11-20T10:00:00.000Z"

beforeAll(() => {
	process.env["HOME"] = home
	delete process.env["XDG_DATA_HOME"]
	delete process.env["XDG_CONFIG_HOME"]
	put(".claude/projects/-work-app/s1.jsonl", [
		{ type: "user", timestamp: at, cwd: "/work/app", message: { role: "user", content: "wtf, pls fix the fukcing build" } },
		{ type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "shit, sorry" }] } },
		{ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "fuck" }] } },
		{ type: "user", timestamp: at, cwd: "/work/app", message: { role: "user", content: "thx <3" } },
	])
	put(".claude/projects/-work-app/sdk.jsonl", [{ type: "user", entrypoint: "sdk-ts", timestamp: at, message: { role: "user", content: "fuck" } }])
	put(".codex/sessions/2026/11/20/rollout-a.jsonl", [
		{ timestamp: at, type: "session_meta", payload: { id: "c1", cwd: "/work/api", source: "cli" } },
		{ timestamp: at, type: "turn_context", payload: { model: "gpt-6-sol", cwd: "/work/api" } },
		{ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\nnever say shit" }] } },
		{
			timestamp: at,
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Files mentioned by the user:\n\n## shit.png\n\n## My request:\nkurwa, again?" }] },
		},
		{ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "sent from t3, sorry" }] } },
	])
	put(".codex/sessions/2026/11/20/rollout-b.jsonl", [
		{ timestamp: at, type: "session_meta", payload: { id: "c2", cwd: "/work/api", source: "exec" } },
		{ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fuck" }] } },
	])
	mkdirSync(join(home, ".t3/userdata"), { recursive: true })
	const t3 = new Database(join(home, ".t3/userdata/statev2.sqlite"))
	t3.exec(`
		create table projection_projects (project_id text, workspace_root text);
		create table projection_threads (thread_id text, project_id text, model_selection_json text);
		create table projection_thread_messages (thread_id text, role text, text text, created_at text);
		insert into projection_projects values ('p', '/work/api');
		insert into projection_threads values ('t', 'p', '{"instanceId":"codex","model":"gpt-6-sol"}');
		insert into projection_thread_messages values ('t', 'user', 'sent from t3, sorry', '2026-11-20T10:00:05.000Z');
		insert into projection_thread_messages values ('t', 'user', 'only t3 has this one, thanks', '2026-11-20T10:01:00.000Z');
		insert into projection_thread_messages values ('t', 'assistant', 'fuck', '2026-11-20T10:01:05.000Z');
	`)
	t3.close()

	put(".eukhe/sessions/e1/main.jsonl", [
		{ type: "commit", writes: [{ type: "entry", value: { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "wtf, pls" }], timestamp: 1795000000000 }] } }] },
		{ type: "commit", writes: [{ type: "entry", value: { kind: "pi.assistant", model: [{ role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol" }] } }] },
		// Appended by durable work but typed by the user: no origin tag.
		{
			type: "commit",
			writes: [{ type: "entry", value: { kind: "pi.user", byTaskId: 3, model: [{ role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 1795000060000 }] } }],
		},
		{
			type: "commit",
			writes: [{ type: "entry", value: { kind: "pi.user", byTaskId: 4, data: { origin: { kind: "goal" } }, model: [{ role: "user", content: "fuck", timestamp: 1 }] } }],
		},
		{ type: "commit", writes: [{ type: "entry", value: { kind: "pi.user", data: { origin: { kind: "report" } }, model: [{ role: "user", content: "shit", timestamp: 1 }] } }] },
	])
	put(".eukhe/sessions/e1/doc-6.jsonl", [{ type: "record", payload: { content: { kind: "base", value: { model: { modelId: "first-model" }, cwd: "/work/bot" } } } }])

	put(".prime/agent/sessions/p1.jsonl", [
		{ type: "session", version: 3, id: "p1", timestamp: at, cwd: "/work/prime", rlmDepth: 0 },
		{ type: "message", timestamp: at, message: { role: "user", content: "sorry, my mistake", timestamp: 1795000000000 } },
	])
	put(".prime/agent/sessions/p2.jsonl", [
		{ type: "session", version: 3, id: "p2", timestamp: at, cwd: "/work/prime", rlmDepth: 1 },
		{ type: "message", timestamp: at, message: { role: "user", content: "fuck", timestamp: 1795000000000 } },
	])

	mkdirSync(join(home, ".local/share/amp/threads"), { recursive: true })
	writeFileSync(
		join(home, ".local/share/amp/threads/T-a.json"),
		JSON.stringify({
			id: "T-a",
			created: 1795000000000,
			env: { initial: { trees: [{ uri: "file:///home/user/workspace/repo", repository: { url: "https://github.com/me/site" } }] } },
			messages: [
				{ role: "user", meta: { sentAt: 1795000000000 }, content: [{ type: "text", text: "plz fix" }] },
				{ role: "assistant", usage: { model: "claude-opus-5-5", timestamp: at }, content: [] },
				{ role: "user", meta: { fromExecutorThreadID: "T-b" }, content: [{ type: "text", text: "Worker report: fuck" }] },
				{ role: "user", meta: { modelSwitch: { to: "x" } }, content: [{ type: "text", text: "plz fix" }] },
				{ role: "user", meta: { sentAt: 1795000600000 }, content: [{ type: "text", text: "wtf" }] },
				{ role: "user", meta: { sentAt: 1795000630000, steer: true }, content: [{ type: "text", text: "wtf" }] },
				{ role: "user", content: [{ type: "tool_result", toolUseID: "t", run: { result: "shit" } }] },
			],
		}),
	)
})

afterAll(() => {
	process.env["HOME"] = realHome
	rmSync(home, { recursive: true, force: true })
})

test("counts what the user typed, once, under the harness that ran it", async () => {
	const store = openStore(join(home, "index.sqlite"))
	const first = await Effect.runPromise(sync(store))
	expect(first.failures).toEqual([])
	const rows = load(store)
	expect(Object.fromEntries(tally(rows, (row) => row.harness))).toEqual({
		claude: { msgs: 2, swear: 2, manners: 2, love: 1, sorry: 0 },
		codex: { msgs: 3, swear: 1, manners: 1, love: 0, sorry: 1 },
		eukhe: { msgs: 2, swear: 1, manners: 2, love: 0, sorry: 0 },
		prime: { msgs: 1, swear: 0, manners: 0, love: 0, sorry: 1 },
		amp: { msgs: 2, swear: 1, manners: 1, love: 0, sorry: 0 },
	})
	expect(rows.filter((row) => row.harness === "eukhe").map((row) => [row.ts, row.model, row.repo])).toEqual([
		[1795000000000, "gpt-6.1-sol", "bot"],
		[1795000060000, "first-model", "bot"],
	])
	expect(rows.find((row) => row.harness === "amp")).toMatchObject({ model: "claude-opus-5-5", repo: "site", ts: 1795000000000 })
	expect(rows.find((row) => row.harness === "claude")).toMatchObject({ model: "claude-opus-5-5", repo: "app", seq: 1 })
	expect(rows.filter((row) => row.via === "t3code").length).toBe(2)

	// Nothing changed on disk, so nothing is read again.
	expect((await Effect.runPromise(sync(store))).scanned).toBe(0)
	store.close()
})
