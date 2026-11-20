import { expect, test } from "bun:test"
import { clean, scan } from "../src/match"

const roots = (text: string) => scan(clean(text)).map((h) => `${h.cat}:${h.root}`)

test.each([
	["this is fukcing broken", ["swear:fuck"]],
	["fuuuuuck", ["swear:fuck"]],
	["f*ck this, sh*t", ["swear:fuck", "swear:shit"]],
	["sh1t $hit", ["swear:shit", "swear:shit"]],
	["f u c k", ["swear:fuck"]],
	["f.u.c.k", ["swear:fuck"]],
	["absofuckinglutely", ["swear:fuck"]],
	["what the fuxk, bulshit", ["swear:fuck", "swear:bullshit"]],
	["*shit*", ["swear:shit"]],
	["ja pierdolę, kurwa mać", ["swear:pierdolić", "swear:kurwa"]],
	["wkurwia mnie to, zajebiscie", ["swear:kurwa", "swear:jebać"]],
	["kurwaaaa", ["swear:kurwa"]],
	["pls fix, thx", ["manners:please", "manners:thanks"]],
	["plaese and thnaks", ["manners:please", "manners:thanks"]],
	["pleaseee thank you", ["manners:please", "manners:thanks"]],
	["prosze zrob to, dzieki", ["manners:proszę", "manners:dzięki"]],
	["dziękuję bardzo", ["manners:dzięki"]],
	["ty, works now", ["manners:thanks"]],
	["sooorry, my bad", ["sorry:sorry", "sorry:my bad"]],
	["przeprasam", ["sorry:przepraszam"]],
	["love it <3 good job", ["love:<3", "love:love", "love:good job"]],
	["awsome!", ["love:awesome"]],
	["perfcet, now ship it", ["love:perfect"]],
])("counts %p", (text, expected) => {
	expect(roots(text).sort()).toEqual([...expected].sort())
})

test.each([
	"duck the shirt and shift the sheet",
	"he'll pass the class, as assigned",
	"run fsck on the disk, then git push",
	"a ty co robisz? to nie jest tak",
	"the thunk than thinks",
	"move the glove, live and worry",
	"see `fuck.ts` and ```\nshit()\n``` in src/shit/fuck.ts or https://example.com/fuck",
	"<system-reminder>fuck this</system-reminder>",
	"the dupe key and the gown",
	"shiitake, bitcoin, pitch, batch",
	"**fix** the *bug*",
	"a b c d e",
	"it is better but far from perfect",
	"message to native core <3715093079> received",
	"such a small amount, suck it up",
])("ignores %p", (text) => {
	expect(roots(text)).toEqual([])
})

test("reports how a token matched", () => {
	const kinds = Object.fromEntries(scan("fuck fuk fukcing").map((h) => [h.raw, h.kind]))
	expect(kinds).toEqual({ fuck: "exact", fuk: "slang", fukcing: "variant" })
})
