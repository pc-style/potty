import { type Category, ENTRIES, EXTRA_SAFE, PHRASES, POLISH_HINTS, RAW_ONLY, STEMS, STEM_EXCEPTIONS } from "./lexicon"
import { SAFE_WORDS } from "./safe.gen"

/** How a token matched: a listed form, a listed slang or misspelling, or one the matcher worked out. */
export type Kind = "exact" | "slang" | "variant"

export interface Hit {
	readonly cat: Category
	readonly root: string
	/** The token as typed, lowercased. */
	readonly raw: string
	readonly kind: Kind
}

interface Form {
	readonly cat: Category
	readonly root: string
	readonly kind: Kind
	readonly fuzzy: boolean
	readonly notPolish: boolean
	readonly lead: boolean
}

const DIACRITICS: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" }
/** Lowercase text with Polish and other Latin diacritics removed. */
export const flatten = (s: string): string =>
	s
		.replace(/[ąćęłńóśźż]/g, (c) => DIACRITICS[c]!)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" }
const collapse = (s: string): string => s.replace(/(.)\1+/g, "$1")

// Lookup tables, built once from the lexicon.
const exact = new Map<string, Form>()
const skeletons = new Map<string, Form>()
const fuzzyForms: Array<{ word: string; form: Form }> = []
const deletes = new Map<string, number[]>()

const maxDistance = (len: number): number => (len >= 8 ? 2 : len >= 4 ? 1 : 0)

function deletions(word: string, depth: number, out: Set<string>): Set<string> {
	out.add(word)
	if (depth === 0 || word.length <= 2) return out
	for (let i = 0; i < word.length; i++) deletions(word.slice(0, i) + word.slice(i + 1), depth - 1, out)
	return out
}

for (const entry of ENTRIES) {
	const [canonical = "", slang = ""] = entry.forms.split("|")
	for (const [list, kind] of [
		[canonical, "exact"],
		[slang, "slang"],
	] as const) {
		for (const word of list.split(/\s+/).filter(Boolean)) {
			const form: Form = { cat: entry.cat, root: entry.root, kind, fuzzy: entry.fuzzy === true, notPolish: entry.notPolish === true, lead: entry.lead === true }
			const keys = RAW_ONLY.has(word) ? [word] : [word, flatten(word)]
			for (const key of keys) {
				if (!exact.has(key)) exact.set(key, form)
				const skeleton = collapse(key)
				if (!skeletons.has(skeleton)) skeletons.set(skeleton, form)
			}
			const flat = flatten(word)
			if (form.fuzzy && kind === "exact" && flat.length >= 4 && !RAW_ONLY.has(word)) {
				const index = fuzzyForms.push({ word: flat, form }) - 1
				for (const d of deletions(flat, maxDistance(flat.length), new Set())) {
					const bucket = deletes.get(d)
					if (bucket) bucket.push(index)
					else deletes.set(d, [index])
				}
			}
		}
	}
}

const stems = STEMS.map((s) => ({ ...s, raw: RAW_ONLY.has(s.stem), stem: RAW_ONLY.has(s.stem) ? s.stem : flatten(s.stem) }))
const extraSafe = new Set(EXTRA_SAFE.split(/\s+/))
const phraseIndex = new Map(PHRASES.map((p) => [`${p.a} ${p.b}`, p]))

/** Optimal string alignment distance (edits plus adjacent swaps), abandoned once it exceeds `limit`. */
export function distance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1
	let prev2: number[] = []
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		const row = [i]
		let best = i
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
			row.push(v)
			if (v < best) best = v
		}
		if (best > limit) return limit + 1
		prev2 = prev
		prev = row
	}
	return prev[b.length]!
}

/** The closest fuzzy-enabled form within its allowed distance, ignoring the safe list. */
export function nearestForm(flat: string): Form | null {
	if (flat.length < 4 || flat.length > 16) return null
	let best: Form | null = null
	let bestDistance = 3
	const seen = new Set<number>()
	for (const d of deletions(flat, maxDistance(flat.length + 1), new Set())) {
		for (const index of deletes.get(d) ?? []) {
			if (seen.has(index)) continue
			seen.add(index)
			const { word, form } = fuzzyForms[index]!
			const allowed = maxDistance(word.length)
			const dist = distance(flat, word, allowed)
			if (dist > allowed) continue
			// Short words and double edits are only trusted when the start survives: "fcuk" and "fuxk" yes, "quck" no.
			const sameStart = flat[0] === word[0] || (flat[0] === word[1] && flat[1] === word[0])
			if ((dist === 2 || word.length <= 5) && !sameStart) continue
			if (dist < bestDistance) {
				best = form
				bestDistance = dist
			}
		}
	}
	return best
}

type Found = Form | null
const memo = new Map<string, Found>()

function classify(raw: string): Found {
	const flat = flatten(raw)
	const direct = exact.get(raw) ?? exact.get(flat)
	if (direct) return direct
	const asVariant = (form: Form | undefined | null): Found => (form ? { ...form, kind: "variant" } : null)

	// sh1t, $hit, f@ck: only an exact form after substitution counts.
	if (/[0-9@$!]/.test(flat)) {
		const unleet = flat.replace(/[013457@$!]/g, (c) => LEET[c]!)
		const symbols = flat.replace(/[a-z*]/g, "").length
		// More symbols than letters is a number or a price, not a disguised word: "45s", "$100".
		if (/^[a-z*]+$/.test(unleet) && unleet !== flat && symbols <= flat.length - symbols) {
			const viaLeet = exact.get(unleet) ?? (/(.)\1\1/.test(unleet) ? skeletons.get(collapse(unleet)) : undefined)
			if (viaLeet) return asVariant(viaLeet)
		}
		if (!flat.includes("*")) return null
	}

	// f*ck, sh*t, f***ing: at least two real letters, the first one included.
	if (flat.includes("*")) {
		const letters = flat.replace(/\*/g, "").length
		if (letters < 2 || flat[0] === "*" || !/^[a-z*]+$/.test(flat)) return null
		const pattern = new RegExp(`^${flat.replace(/\*/g, ".")}$`)
		return asVariant(fuzzyForms.find(({ word, form }) => form.cat === "swear" && pattern.test(word))?.form)
	}
	if (!/^[a-z]+$/.test(flat)) return null

	// fuuuuck, pleaseee, sooorry: three or more of a letter is deliberate stretching.
	if (/(.)\1\1/.test(flat)) {
		const stretched = skeletons.get(collapse(flat))
		if (stretched) return asVariant(stretched)
	}

	if (!STEM_EXCEPTIONS.has(flat)) {
		const squeezed = collapse(flat)
		for (const s of stems) {
			if (s.raw ? raw.includes(s.stem) : flat.includes(s.stem) || squeezed.includes(s.stem)) {
				return { cat: s.cat, root: s.root, kind: "exact", fuzzy: false, notPolish: false, lead: false }
			}
		}
	}

	if (SAFE_WORDS.has(flat) || extraSafe.has(flat)) return null
	return asVariant(nearestForm(flat))
}

function lookup(token: string): Found {
	if (token.length > 24) return null
	const cached = memo.get(token)
	if (cached !== undefined) return cached
	const found = classify(token)
	if (memo.size > 200_000) memo.clear()
	memo.set(token, found)
	return found
}

const TOKEN = /[\p{L}\p{N}@$*!'’]+/gu
const SPELLED = /(?<![\p{L}\p{N}])(?:\p{L}[ .\-_]){3,}\p{L}(?![\p{L}\p{N}])/gu
const HEARTS = /(?<![\w<])<3+(?!\d)|[\u2764\u2665\u{1F493}-\u{1F49F}\u{1F5A4}\u{1F90D}\u{1F90E}\u{1F9E1}\u{1FAF6}\u{1F60D}\u{1F970}\u{1F618}]/gu

/** Text a person did not type: code, URLs, paths, injected tag blocks. */
export function clean(text: string): string {
	return text
		.replace(/```[\s\S]*?(?:```|$)/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/<([A-Za-z_][\w-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g, " ")
		.replace(/<[A-Za-z_][\w-]*(?:\s[^<>]*)?\/>/g, " ")
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
		.replace(/(?:^|\s)@?[~.]?(?:[\w.@-]*\/)+[\w.@-]*/g, " ")
}

const trimToken = (token: string): string => {
	let t = token.replace(/^['’!*]+/, "").replace(/['’!]+$/, "")
	if (token.startsWith("*")) t = t.replace(/\*+$/, "")
	const apostrophe = t.search(/['’]/)
	return apostrophe > 0 ? t.slice(0, apostrophe) : t
}

/** Every swear, bit of manners, love and apology in a message, in order. Run `clean` on the text first. */
export function scan(text: string): Hit[] {
	const hits: Hit[] = []
	for (const heart of text.match(HEARTS) ?? []) hits.push({ cat: "love", root: "<3", raw: heart, kind: "exact" })

	const lower = text.toLowerCase().replace(SPELLED, (run) => run.replace(/[ .\-_]/g, ""))
	const tokens: string[] = []
	for (const m of lower.matchAll(TOKEN)) {
		const token = trimToken(m[0])
		if (token) tokens.push(token)
	}

	let polish: boolean | null = null
	const isPolish = (): boolean => {
		if (polish === null) polish = /[ąćęłńóśźż]/.test(lower) || tokens.filter((t) => POLISH_HINTS.has(t)).length >= 2
		return polish
	}

	let previous = ""
	for (const [position, token] of tokens.entries()) {
		const flat = flatten(token)
		const phrase = phraseIndex.get(`${previous} ${flat}`)
		previous = flat
		if (phrase) {
			hits.push({ cat: phrase.cat, root: phrase.root, raw: `${phrase.a} ${phrase.b}`, kind: "exact" })
			continue
		}
		const found = lookup(token)
		if (!found || (found.notPolish && isPolish()) || (found.lead && position > 2)) continue
		hits.push({ cat: found.cat, root: found.root, raw: token, kind: found.kind })
	}
	return hits
}
