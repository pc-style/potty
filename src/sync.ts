import { Data, Effect, Result } from "effect"
import { ADAPTERS, type Source } from "./adapters"
import { clean, scan } from "./match"
import type { NewRow, Store } from "./store"

export class ReadError extends Data.TaggedError("ReadError")<{ readonly path: string; readonly cause: unknown }> {}

/** Openers of messages that a harness or another agent put in the user turn. */
const CANNED = [
	/^# AGENTS\.md instructions/,
	/^You are an internal /,
	/^\[Historical user;/,
	/^Update on pull request #\d+/,
	/^Please analyze this codebase and create/,
	/^Use the code_review tool to review/,
	/^This session is being continued from a previous/,
	/^\[Request interrupted by user/,
	/^Continuing work from thread T-/,
]

/** Longer than this after cleaning is a paste (a log, a transcript), so it counts as a message but its words do not. */
const PASTE_LIMIT = 4000

export interface SyncResult {
	readonly sources: number
	readonly scanned: number
	readonly failures: ReadonlyArray<ReadError>
}

/** Reads one source and reduces it to rows: counts and matched words, no text. */
const read = (source: Source) =>
	Effect.tryPromise({
		try: async (): Promise<NewRow[]> => {
			const seq = new Map<string, number>()
			const rows: NewRow[] = []
			for (const message of await source.read()) {
				const text = clean(message.text).replace(/\s+/g, " ").trim()
				if (!text || CANNED.some((opener) => opener.test(text))) continue
				const n = (seq.get(message.session) ?? 0) + 1
				seq.set(message.session, n)
				rows.push({
					harness: message.harness ?? source.harness,
					session: message.session,
					seq: n,
					ts: message.ts,
					model: message.model,
					repo: message.repo,
					hash: Bun.hash(text).toString(36),
					via: message.via ?? null,
					mirror: message.mirror === true,
					hits: text.length > PASTE_LIMIT ? [] : scan(text),
				})
			}
			return rows
		},
		catch: (cause) => new ReadError({ path: source.path, cause }),
	})

/**
 * Brings the index up to date: scans sources that are new or changed on disk and
 * forgets ones that are gone. A source that cannot be read is reported, not fatal.
 */
export const sync = (store: Store, only?: ReadonlyArray<string>): Effect.Effect<SyncResult> =>
	Effect.gen(function* () {
		const adapters = ADAPTERS.filter((a) => !only || only.includes(a.name))
		const sources = adapters.flatMap((a) => a.discover())
		store.prune(
			adapters.map((a) => a.name),
			new Set(sources.map((s) => s.path)),
		)
		const stale = store.stale(sources)
		const results = yield* Effect.forEach(stale, (source) => Effect.result(read(source)).pipe(Effect.map((result) => ({ source, result }))), { concurrency: 16 })
		const failures: ReadError[] = []
		for (const { source, result } of results) {
			if (Result.isSuccess(result)) store.replace(source, result.success)
			else failures.push(result.failure)
		}
		return { sources: sources.length, scanned: stale.length, failures }
	})
