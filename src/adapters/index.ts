import { amp } from "./amp"
import { claude, codex, droid, eukhe, grok, pi, prime } from "./jsonl"
import { antigravity, cursor, opencode, t3code, zed } from "./sqlite"
import type { Adapter } from "./util"

export type { Adapter, Message, Source } from "./util"

export const ADAPTERS: ReadonlyArray<Adapter> = [amp, claude, codex, t3code, zed, pi, prime, opencode, antigravity, eukhe, grok, droid, cursor]

/** Display name for a harness, including ones only seen through T3 Code. */
export const label = (harness: string): string => ADAPTERS.find((a) => a.name === harness)?.label ?? harness
