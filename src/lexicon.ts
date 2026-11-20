/**
 * The word lists. Everything the matcher knows comes from this file.
 *
 * Each entry is `root: "canonical forms | slang and known misspellings"`.
 * Polish forms are written with diacritics; the matcher also accepts them
 * without, except for the few in RAW_ONLY that collide with other words.
 * Bump LEXICON_VERSION after any edit so cached files are rescanned.
 */
export const LEXICON_VERSION = 1

export const CATEGORIES = ["swear", "manners", "love", "sorry"] as const
export type Category = (typeof CATEGORIES)[number]

export interface Entry {
	readonly cat: Category
	readonly root: string
	readonly forms: string
	/** Allow typo matching (edit distance) against the forms. Off for short or crowded words. */
	readonly fuzzy?: boolean
	/** Count only when the message opens with it: "perfect, now ..." is praise, "not perfect" is not. */
	readonly lead?: boolean
	/** Skip in messages that look Polish, where the word means something else. */
	readonly notPolish?: boolean
}

const e = (cat: Category, root: string, forms: string, opts: Omit<Entry, "cat" | "root" | "forms"> = {}): Entry => ({
	cat,
	root,
	forms,
	...opts,
})

export const ENTRIES: ReadonlyArray<Entry> = [
	// English swears
	e("swear", "fuck", "fuck fucking fucked fucker fucks fuckin | fuk fuking fuked fcuk fck fcking fkn fking fkin fuq fuc phuck effing eff", { fuzzy: true }),
	e("swear", "shit", "shit shitty shits shite shitting | sht shiz shizz", { fuzzy: true }),
	e("swear", "bullshit", "bullshit | bullsht bulshit", { fuzzy: true }),
	e("swear", "bitch", "bitch bitches bitching bitchy | biatch", { fuzzy: true }),
	e("swear", "ass", "ass asses arse assed | azz"),
	e("swear", "asshole", "asshole assholes arsehole dumbass jackass smartass asshat asswipe badass kickass | ahole", { fuzzy: true }),
	e("swear", "damn", "damn damned damnit dammit goddamn goddamnit goddammit goddamned | damm"),
	e("swear", "bastard", "bastard bastards", { fuzzy: true }),
	e("swear", "piss", "piss pissed pissing pissoff"),
	e("swear", "dick", "dick dickhead dicks"),
	e("swear", "crap", "crap crappy crapping"),
	e("swear", "hell", "hell"),
	e("swear", "suck", "sucks sucked sucking"),
	e("swear", "cunt", "cunt cunts"),
	e("swear", "twat", "twat wanker bollocks bugger"),
	e("swear", "freaking", "freaking frickin fricking frigging friggin"),
	e("swear", "wtf", "wtf wth omfg ffs fml jfc stfu gtfo | wtff wtaf"),
	e("swear", "lmao", "lmao lmfao | lmaoo"),

	// Polish swears. The stems below catch most inflections; these are the rest.
	e("swear", "kurwa", "kurwa | kurła qrwa kurfa kurva kuhwa kuzwa kurwaa", { fuzzy: true }),
	e("swear", "dupa", "dupa dupy dupie dupę dupą dupo dupek dupku dupki dupsko zadupie dupny"),
	e("swear", "gówno", "gówno gówna gównie gównem gówniany gówniane gówniana gówien"),
	e("swear", "srać", "zasrany zasrane zasrana sraka sraczka zesrał zesrać posrane posrany"),
	e("swear", "kutas", "kutas kutasa kutasie fiut fiuta"),
	e("swear", "kurde", "kurde kurdę kurna kurczę kurka"),
	e("swear", "cholera", "cholera cholery cholerę cholerny cholerna cholerne cholernie"),
	e("swear", "szlag", "szlag"),
	e("swear", "debil", "debil debilu debile debilny debilne debilna"),

	// Manners: asking nicely and saying thanks.
	e("manners", "please", "please | pls plz plis pliss plox plss plzz pwease pleaz", { fuzzy: true }),
	e("manners", "thanks", "thanks thank thankyou | thx thnx tnx thanx thnks thanku tysm tyvm thankies", { fuzzy: true }),
	e("manners", "thanks", "ty", { notPolish: true }),
	e("manners", "thanks", "cheers kindly"),
	e("manners", "appreciate", "appreciate appreciated grateful", { fuzzy: true }),
	e("manners", "proszę", "proszę poproszę poprosić prosiłbym prosiłabym poprosiłbym poprosiłabym proszem", { fuzzy: true }),
	e("manners", "dzięki", "dzięki dziękuję dziękuje dziękujemy dziękuj dziękować dziękówka | dzięks dzienks dziena dziękuwa", { fuzzy: true }),

	// Love: affection and praise.
	e("love", "love", "love loved loves lovely loving | luv luvv lovee lovin lovey", { fuzzy: true }),
	e("love", "ily", "ily ilysm ilu"),
	e("love", "awesome", "awesome amazing brilliant beautiful wonderful fantastic excellent incredible", { fuzzy: true, lead: true }),
	e("love", "perfect", "perfect perfection perfecto", { fuzzy: true, lead: true }),
	e("love", "goat", "goated legend genius"),
	e("love", "kocham", "kocham uwielbiam | kc kckc"),
	e("love", "świetnie", "świetnie świetne świetna świetny pięknie piękne cudownie cudo cudne genialne genialnie idealnie idealne bosko brawo sztos", { lead: true }),

	// Sorry.
	e("sorry", "sorry", "sorry | sry srry sorri soz sowwy sorryy", { fuzzy: true }),
	e("sorry", "apologies", "apologies apologize apologise apology", { fuzzy: true }),
	e("sorry", "przepraszam", "przepraszam przepraszamy przepraszać wybacz | sorki sorka sory sorcia sorewicz sorx", { fuzzy: true }),
]

/** A token containing one of these counts, whatever surrounds it: "absofuckinglutely", "wkurwiony". */
export const STEMS: ReadonlyArray<{ stem: string; cat: Category; root: string }> = [
	{ stem: "fuck", cat: "swear", root: "fuck" },
	{ stem: "bullshit", cat: "swear", root: "bullshit" },
	{ stem: "shit", cat: "swear", root: "shit" },
	{ stem: "bitch", cat: "swear", root: "bitch" },
	{ stem: "asshole", cat: "swear", root: "asshole" },
	{ stem: "kurw", cat: "swear", root: "kurwa" },
	{ stem: "kurew", cat: "swear", root: "kurwa" },
	{ stem: "pierdol", cat: "swear", root: "pierdolić" },
	{ stem: "pierdal", cat: "swear", root: "pierdolić" },
	{ stem: "jeb", cat: "swear", root: "jebać" },
	{ stem: "chuj", cat: "swear", root: "chuj" },
	{ stem: "pizd", cat: "swear", root: "pizda" },
	{ stem: "wkurz", cat: "swear", root: "wkurzać" },
	{ stem: "gówn", cat: "swear", root: "gówno" },
]

/** Tokens that contain a stem but are not what the stem means. */
export const STEM_EXCEPTIONS = new Set(["shitake", "shiitake", "mishit", "mishits", "bitchin", "zakochuje", "zakochujesz", "zakochuja", "zakochujemy"])

/** Two-word phrases, matched on normalised tokens. */
export const PHRASES: ReadonlyArray<{ a: string; b: string; cat: Category; root: string }> = [
	...["job", "work", "bot", "boy", "girl", "stuff"].flatMap((b) => ["good", "great", "nice", "amazing", "awesome"].map((a) => ({ a, b, cat: "love" as const, root: "good job" }))),
	{ a: "well", b: "done", cat: "love", root: "good job" },
	{ a: "nailed", b: "it", cat: "love", root: "good job" },
	{ a: "you", b: "rock", cat: "love", root: "good job" },
	{ a: "dobra", b: "robota", cat: "love", root: "dobra robota" },
	{ a: "swietna", b: "robota", cat: "love", root: "dobra robota" },
	{ a: "my", b: "bad", cat: "sorry", root: "my bad" },
	{ a: "forgive", b: "me", cat: "sorry", root: "sorry" },
]

/** Polish forms that mean something else once the diacritics are gone. */
export const RAW_ONLY = new Set(["dupę", "gówn", "dupą"])

/**
 * Real words and developer terms one typo away from a listed form. The generated
 * list in safe.gen.ts covers dictionary words; these are the ones dictionaries miss.
 */
export const EXTRA_SAFE =
	"fsck thunk shiv shim shft shif chit whit smit sheit schist bitsh batch butch birch bitcn ditch pitch fitch " +
	"lvalue glove clove lov lova lover lovers pls please plea pleas pleased pleases than thane thank thanos " +
	"sorrow lorry sorta sortby pref prefect perfecting sorro sorra fuchs fuchsia tuck yuck puck shirt shift shot " +
	"shut ship shin slit spit suit skit edit exit kurka kurta kura kursa kurwa burwa prose proszek dzieci dziki"

/** Common Polish words, for telling a Polish message from an English one. */
export const POLISH_HINTS = new Set(
	"nie się jest że jak czy co na do to ale tak bo już jeszcze tylko może mam masz ma są był była było tego tej ten ta też gdzie kiedy dlaczego czemu teraz tutaj zrób daj mi mnie ci cię jego jej ich nas was oraz albo żeby jeśli bardzo dobrze źle po za od dla przez przy bez".split(
		" ",
	),
)
