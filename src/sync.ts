import { Data, Effect, Result } from "effect"
import { ADAPTERS, type Source } from "./adapters"
import { remote } from "./adapters/amp"
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
	/^The user just created this Space,/,
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
export interface SyncOptions {
	readonly only?: ReadonlyArray<string> | undefined
	/** Also fetch Amp threads with `amp threads export`. Slow on the first run; needs the network. */
	readonly ampRemote?: boolean
	readonly progress?: (done: number, total: number) => void
}

export class RemoteError extends Data.TaggedError("RemoteError")<{ readonly message: string }> {}

export const sync = (store: Store, options: SyncOptions = {}): Effect.Effect<SyncResult, RemoteError> =>
	Effect.gen(function* () {
		const { only } = options
		const adapters = ADAPTERS.filter((a) => !only || only.includes(a.name))
		const local = adapters.flatMap((a) => a.discover())
		const fetchRemote = options.ampRemote === true && (!only || only.includes("amp"))
		const remoteSources = fetchRemote
			? yield* Effect.tryPromise({ try: remote, catch: (cause) => new RemoteError({ message: cause instanceof Error ? cause.message : String(cause) }) })
			: []
		const sources = [...local, ...remoteSources]
		store.prune([...adapters.map((a) => a.name), ...(fetchRemote ? ["amp-remote"] : [])], new Set(sources.map((s) => s.path)))
		const stale = store.stale(sources)
		let done = 0
		const failures: ReadError[] = []
		// Each source is saved as soon as it is read, so an interrupted run keeps its progress.
		yield* Effect.forEach(
			stale,
			(source) =>
				Effect.result(read(source)).pipe(
					Effect.map((result) => {
						if (Result.isSuccess(result)) store.replace(source, result.success)
						else failures.push(result.failure)
						options.progress?.(++done, stale.length)
					}),
				),
			// Each Amp export is its own process and network call.
			{ concurrency: fetchRemote ? 8 : 16, discard: true },
		)
		return { sources: sources.length, scanned: stale.length, failures }
	})
