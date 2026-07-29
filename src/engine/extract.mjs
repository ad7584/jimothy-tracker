// Turn an ingested item into a scored sighting candidate.
//
// The scoring is deliberately legible: every contribution is recorded in
// `why[]` with its weight, so the dashboard can show exactly why something
// scored what it did. Nothing here is a black box.

import { resolvePlaces } from "./gazetteer.mjs";
import { redactCoordinates } from "./privacy.mjs";
import { clamp, norm } from "../util/text.mjs";
import { BANDS } from "../config.mjs";

// Places outside Ballard that appear in Jimothy sighting claims.
//
// These are not guesses. On 2026-07-18 r/Seattle post 1uzk5cr (+5,358) asked
// people to flood the zone with false locations to protect the animal, and they
// did. Measured decoys, each with its real score: Fremont Troll +175, Archie
// McPhee +90, "deep west Seattle" +73, Carkeek beavers +28, Museum of Glass in
// Tacoma +24, Paine Field +14, Green Lake +13, Lake Stevens +5. Across 1,629
// comments the most frequent place token is `tacoma` (27) — ahead of `ballard`
// (25). Laurelhurst (23) comes almost entirely from one satirical post.
//
// A sighting claim naming one of these is far more likely to be participating
// in that campaign than reporting an animal. We do not suppress the post — it
// stays in the feed — we just decline to treat it as location evidence.
const DECOY_PLACES = [
  "tacoma", "laurelhurst", "fremont", "west seattle", "everett", "northgate",
  "capitol hill", "bellevue", "green lake", "greenlake", "lake stevens",
  "paine field", "wallingford", "museum of glass", "archie mcphee",
  "fremont troll", "carkeek", "magnolia", "kirkland", "redmond", "renton",
];

// Explicit markers that a post is not meant literally. The highest-scoring
// post carrying the dedicated subreddit's own `RECENT SIGHTING` flair
// (r/JimothyTheRaccoon 1v243is, +218, "spotted multiple times today in
// LAURELHURST") is satire, and its own comments say so: "OP is very obviously
// being ironic/sarcastic" (+31), "Whoosh" (+18). It attracted corroboration
// that looks independent. Without this it would rank as our best sighting.
const IRONY_MARKERS = [
  "/s", "satire", "sarcastic", "sarcasm", "ironic", "whoosh", "jokingly",
  "shitpost", "shit post", "not real", "obviously fake", "psyop",
];

// First-hand observation language.
//
// The second block was added after recovering the actual sighting corpus: the
// highest-scoring genuine report anywhere (r/Seattle 1uxnd2c, +377) reads "I've
// seen this dude in our Ballard backyard … he usually hangs out in our apple
// tree", and matched NOTHING in the original list, which was written for "saw
// him" and "my backyard". It scored 0.18 while a Museum-of-Glass-in-Tacoma
// decoy scored 0.38. Residents write "our", not "my", and they say "seen this
// dude" far more than "saw him".
const SIGHTING_VERBS = [
  "spotted", "sighting", "saw him", "saw jimothy", "just saw", "seen him",
  "caught him", "showed up", "in my yard", "my backyard", "my trash",
  "outside my", "ran across", "crossed the", "waddling", "encounter",
  "walked past", "came by", "on my porch", "under my", "in the alley",
  // Recovered from the real corpus, 2026-07-26.
  "seen this", "saw this", "our backyard", "our yard", "in our", "our trash",
  "hangs out", "frequents", "he's back", "hes back", "back again",
  "saw him last", "spotted him", "have pictures of him", "call him",
  "lives in", "lives near", "comes around", "regular in",
];

// Speculative-asset chatter. DROPPED OUTRIGHT, not merely scored down.
//
// This material is a large fraction of everything that carries the name, it
// contains no information about an animal, and down-ranking still left it in
// the feed where a reader would meet it. Nothing on this dashboard should point
// anyone at a speculative asset, so these items do not enter the pipeline at
// all — they are not scored, not clustered, and never rendered.
const EXCLUDE_TERMS = [
  "$jimothy", "token", "memecoin", "meme coin", "shitcoin", "altcoin",
  "market cap", "mcap", "fdv", "pump.fun", "pumpfun", "dexscreener",
  "geckoterminal", "coingecko", "solana", "blockchain", "crypto", "airdrop",
  "rugpull", "rug pull", "liquidity pool", "contract address", "ticker",
  "holders", "to the moon", "ath", "presale", "jup.ag", "raydium", "wallet",
  "buy now", "0x", "hodl", "degen", "bullish", "bearish", "candle",
];

// Merch / meta. Real, on-topic, and not evidence of a location — pushed down
// rather than removed, because a mural or a proclamation is genuinely part of
// this story even though it can never be a sighting.
const META_TERMS = [
  "chart", "tattoo", "mural", "shirt", "merch", "plush", "sticker",
  "bobblehead", "art contest", "fan art", "screensaver", "stat block",
  "honorary degree", "proclamation", "webcomic", "stand up", "comedy",
];

// Temporal immediacy — a sighting reported now is worth more than a retrospective.
const RECENCY_TERMS = ["just now", "just saw", "right now", "this morning", "tonight", "last night", "minutes ago"];

const FIRST_PERSON = /\b(i|we|my|our)\b/;

/**
 * @param {object} item ingested item
 * @param {string} [extraText] e.g. fetched reddit comments
 */
export function extract(item, extraText = "") {
  // Redact before anything else reads the text. Raw coordinates are actively
  // being posted — r/SeattleWA 1v6l8wr carries "47.69121° N, 122.34483° W I SAW
  // HIM HERE" in its body — and item titles render verbatim into /api/state, so
  // an unredacted title is a live path from a stranger's post to our page.
  const redaction = redactCoordinates(`${item.title || ""} ${item.text || ""} ${extraText}`);
  const raw = redaction.text;
  const t = norm(raw);
  const why = [];

  // TikTok items were DISCOVERED via Jimothy searches, but the caption itself
  // often carries no name at all ("look at this little guy") — so they pass
  // the gate on provenance and are scored honestly below: a caption that says
  // "jimothy" earns the mention weight, one that does not earns a smaller
  // found-via-search weight instead.
  if (!/jimothy/.test(t) && item.origin !== "wildlife" && item.origin !== "tiktok") return null;

  // Speculative-asset chatter never enters the pipeline. Checked with word
  // boundaries so "tickertape" or a street called Wallet Lane cannot trip it,
  // and skipped for wildlife records, which are structured observations that
  // cannot contain this material.
  if (item.origin !== "wildlife") {
    const hit = EXCLUDE_TERMS.find((term) =>
      new RegExp(`(^|[^a-z0-9])${term.replace(/[.$*+?()[\]{}|\\^]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t));
    if (hit) return null;
  }

  // Wildlife observations are structurally different: they are already
  // located and dated, and their claim to being Jimothy rests entirely on the
  // recognition pass, not on text.
  if (item.origin === "wildlife") {
    const base = item.meta?.baseline ? 0.05 : 0.30;
    why.push({ k: item.meta?.baseline ? "baseline-observation" : "geolocated-observation", w: base });
    if (item.meta?.qualityGrade === "research") why.push({ k: "research-grade", w: 0.05 });
    const score = clamp(base + (item.meta?.qualityGrade === "research" ? 0.05 : 0), 0, 1);
    return {
      score,
      band: bandFor(score),
      why,
      places: item.meta?.lat
        ? [{ zone: item.meta.zone || "Ballard (general)", lat: item.meta.lat, lon: item.meta.lon,
             precision: item.meta.obscured ? "area" : "landmark", matched: "gps" }]
        : [],
      needsRecognition: (item.images || []).length > 0,
      isSightingClaim: false,
    };
  }

  let score;
  const foundViaSearch = !/jimothy/.test(t);
  if (!foundViaSearch) {
    score = 0.12;
    why.push({ k: "mentions-jimothy", w: 0.12 });
  } else {
    // Only reachable for tiktok items (see the gate above): the video was
    // found through a Jimothy search, but its own caption never says the name.
    score = 0.08;
    why.push({ k: "found-via-jimothy-search", w: 0.08 });
  }

  const verbs = SIGHTING_VERBS.filter((v) => t.includes(v));
  if (verbs.length) {
    const w = 0.30 + 0.04 * (verbs.length - 1);
    score += w;
    why.push({ k: `sighting-language:${verbs[0]}`, w });
  }

  if (FIRST_PERSON.test(t) && verbs.length) {
    score += 0.08;
    why.push({ k: "first-person-account", w: 0.08 });
  }

  const recency = RECENCY_TERMS.filter((r) => t.includes(r));
  if (recency.length) {
    score += 0.06;
    why.push({ k: `immediacy:${recency[0]}`, w: 0.06 });
  }

  const meta = META_TERMS.filter((m) => t.includes(m));
  if (meta.length) {
    const w = -Math.min(0.30, 0.14 * meta.length);
    score += w;
    why.push({ k: `merch-or-market:${meta.slice(0, 3).join(",")}`, w });
  }

  // Someone publishing raw coordinates is either doxxing the animal's den or
  // salting the corpus. Either way it is not evidence we are willing to bank,
  // so it scores nothing — but it IS recorded, because "we redacted a
  // coordinate" is a true and interesting thing to be able to show.
  if (redaction.redacted) {
    why.push({ k: `coordinates-redacted:${redaction.redacted}`, w: 0 });
  }

  const irony = IRONY_MARKERS.filter((m) => t.includes(m));
  if (irony.length) {
    const w = -0.35;
    score += w;
    why.push({ k: `irony-marker:${irony[0]}`, w });
  }

  const decoys = DECOY_PLACES.filter((p) => t.includes(p));

  let places = resolvePlaces(raw);

  // An off-territory claim loses its location entirely rather than merely being
  // marked down. The score says "is this a sighting claim"; `places` says
  // "where". A Fremont Troll decoy is genuinely sighting-shaped — it will and
  // should stay in the feed — but it must never reach heat, territory or a
  // corroboration cluster, and emptying `places` is what actually guarantees
  // that. Scoring it down alone would leave it one lucky threshold away from
  // being treated as evidence.
  let offTerritory = false;
  if (decoys.length && verbs.length && !places.length) {
    offTerritory = true;
    places = [];
    const w = -0.35;
    score += w;
    why.push({ k: `off-territory-claim:${decoys.slice(0, 2).join(",")}`, w });
  }

  // A TikTok whose caption never mentions Jimothy — or even a raccoon — is too
  // weakly tied to the animal for its place names to count as evidence: a
  // Storm-mascot edit that name-drops a Ballard bar must never reach heat,
  // territory or a corroboration cluster. It stays in the feed; it loses
  // location credit. Same principle, same mechanism as the decoy rule above.
  if (foundViaSearch && places.length && !/racc?oon|trash\s?panda/.test(t)) {
    places = [];
    why.push({ k: "no-name-no-location-credit", w: 0 });
  }

  if (places.length) {
    const best = places[0];
    // `street` used to be `grid` and used to be the biggest single weight in
    // the whole function (+0.28). After the 2026-07-18 flooding campaign a
    // named cross-street is the LEAST trustworthy geography in the corpus, not
    // the most, so it now scores below a landmark. The location is zone-level
    // either way — privacy.snapToZone sees to that upstream.
    const w = best.precision === "landmark" ? 0.18
            : best.precision === "street" ? 0.10
            : 0.06;
    score += w;
    why.push({ k: `location:${best.precision}:${best.matched}`, w });
  }

  // Hyperlocal reporting is far likelier to be about the actual animal than
  // national syndication is.
  if (item.origin === "hyperlocal") {
    score += 0.08;
    why.push({ k: "hyperlocal-source", w: 0.08 });
  }
  if (item.origin === "news") {
    score -= 0.06;
    why.push({ k: "national-news-source", w: -0.06 });
  }

  score = clamp(score, 0, 1);
  return {
    score,
    band: bandFor(score),
    why,
    places,
    foundViaSearch,
    offTerritory,
    ironic: irony.length > 0,
    coordinatesRedacted: redaction.redacted,
    needsRecognition: (item.images || []).length > 0 && score >= 0.20,
    isSightingClaim: verbs.length > 0,
  };
}

export function bandFor(score) {
  for (const b of BANDS) if (score >= b.min) return b.band;
  return "MENTION";
}
