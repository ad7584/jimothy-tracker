// Central tunables. Everything that a reasonable person might want to change
// lives here rather than being scattered through the source adapters.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.JM_DATA_DIR || resolve(ROOT, "data");
export const WEB_DIR = resolve(ROOT, "web");

export const PORT = Number(process.env.PORT || 8140);

// Ballard, Seattle. Everything territory-related is anchored here.
export const BALLARD = { lat: 47.6685, lon: -122.3843 };

// Poll intervals, ms. Fast things move; slow things do not. Values are floors —
// the scheduler adds jitter so we never stampede an upstream.
// No keyless real-time stream exists for any of our social sources — Mastodon's
// streaming API rejects both anonymous and app-level tokens, and Reddit has no
// stream at all. So "live" here means aggressive polling, and the UI says so
// rather than claiming a socket it does not have.
export const INTERVALS = {
  // Drives runSignals(): cams, wikipedia, conditions, civic.
  signals: 60_000,
  mastodon: 45_000,     // fastest source we are allowed to poll
  reddit: 150_000,      // 429s if pushed harder, even serialised
  news: 240_000,
  myballard: 600_000,
  cams: 600_000,        // 14 channels x 2 requests — don't hammer it
  conditions: 1_800_000,
  seattle311: 3_600_000,
  wikipedia: 3_600_000,
  inaturalist: 3_600_000,
  tiktok: 300_000,      // Bluesky discovery + oEmbed hydration, both keyless
};

// TikTok ingest. Discovery is Bluesky searchPosts (domain=tiktok.com) plus a
// regex harvest over everything already ingested; hydration is the official
// keyless oEmbed endpoint. All bounds exist so a viral surge degrades to
// "catches up over a few cycles" rather than "hammers TikTok from one IP".
export const TIKTOK = {
  maxHydratePerCycle: Number(process.env.JM_TIKTOK_PER_CYCLE || 8),
  maxPending: 200,        // queued URLs from other sources, cap before drop
  maxThumbs: 200,         // cached poster frames on disk (~10-60KB each)
  maxScorePerCycle: 4,    // vision passes per cycle — shares the daily cap
};

// Reddit rate-limits hard and the limit is account-less and IP-wide, so it
// accumulates across restarts.
//
// Measured 2026-07-26 against www.reddit.com from the response headers:
//     x-ratelimit-used: 1 · x-ratelimit-remaining: 0.0 · x-ratelimit-reset: 38
// i.e. ONE request per fixed ~60s window. A second call inside the window
// returns HTTP 200 with a zero-length body rather than a 429, which is why
// feeds.mjs checks response SHAPE and not status. The old 6s gap was ten times
// faster than the budget allows and is what kept earning the throttle.
export const REDDIT_GAP_MS = 65_000;
export const REDDIT_COOLDOWN_MS = 10 * 60_000;
export const REDDIT_QUERIES_PER_CYCLE = 1;
// Comment deepening via RSS competes with the search calls for the SAME
// one-request-per-minute budget, and starving the search is how the primary
// sighting source ends up red on the dashboard. Off unless explicitly enabled.
export const REDDIT_COMMENTS = process.env.JM_REDDIT_COMMENTS === "1";

// Per-platform floor in the feed. Without this, news (270 items and counting)
// consumes the entire slice by recency and every other platform silently
// vanishes from the feed and its filter chip reads zero.
export const FEED_PER_PLATFORM = 40;
export const FEED_MAX = 320;

// Confidence bands for an extracted sighting candidate.
export const BANDS = [
  { min: 0.75, band: "CONFIRMED" },
  { min: 0.55, band: "PROBABLE" },
  { min: 0.30, band: "UNVERIFIED" },
  { min: 0.0, band: "MENTION" },
];

// A cluster needs this many DISTINCT origin types to be promoted.
// World Monitor requires 5 independent origins for a breaking banner; our
// available origin diversity is smaller, so the ladder is scaled to it.
export const CORROBORATION = { probable: 2, confirmed: 3 };

// Half-life for time-decay of chatter heat, in hours.
export const HEAT_HALFLIFE_H = 36;

// Wikipedia articles that exist for Jimothy, per language edition.
// Discovered via the langlinks API; per-language pageviews are our world-spread signal.
export const WIKI_ARTICLES = [
  { lang: "en", article: "Jimothy_(raccoon)", region: "Anglosphere" },
  { lang: "pl", article: "Jimothy", region: "Poland" },
  { lang: "ru", article: "Джимоти_(енот)", region: "Russia" },
  { lang: "tok", article: "kijetesantakalu_Simasi", region: "Toki Pona" },
];

// Recognition. Disabled automatically when no key is present — items queue as
// UNSCORED rather than blocking ingest.
export const VISION = {
  enabled: Boolean(process.env.ANTHROPIC_API_KEY),
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  triageModel: process.env.JM_TRIAGE_MODEL || "claude-haiku-4-5-20251001",
  idModel: process.env.JM_ID_MODEL || "claude-sonnet-5",
  maxImagesPerCycle: Number(process.env.JM_MAX_IMAGES || 12),
  // Hard ceiling on vision spend. Real supply is ~5-9 new images/day, so this
  // is 30x headroom for a viral surge while still bounding a runaway loop.
  maxImagesPerDay: Number(process.env.JM_MAX_IMAGES_PER_DAY || 250),
  maxBytes: 4_500_000,
};

// Never emit a location finer than a zone. See SPEC.md §6 — this is a hard rule,
// not a default.
export const PRIVACY = {
  zoneResolutionOnly: true,
  minZoneRadiusM: 300,
};
