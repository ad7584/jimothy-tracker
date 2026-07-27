// RSS/Atom-backed sources: news, Reddit, and the Ballard hyperlocal blog.
//
// Reddit notes. THE HOSTS HAVE SWAPPED SINCE THIS WAS WRITTEN — re-measured
// 2026-07-26 from one machine, seconds apart, same User-Agent:
//
//   old.reddit.com/search.rss  -> HTTP 302, Location: /login/?reason=lor2
//   www.reddit.com/search.rss  -> HTTP 200, 52,386 bytes, valid Atom, 25 entries
//
// So the original note ("old works, www returns empty") is now exactly
// inverted, and the source has been hard-down in production — live state.json
// read `reddit: ok=false` — while pointing at the dead host.
//
// The real budget is ONE REQUEST PER ~60s WINDOW, measured from the response
// headers on a successful call:
//     x-ratelimit-used: 1 · x-ratelimit-remaining: 0.0 · x-ratelimit-reset: 38
// A second call inside that window returns **HTTP 200 with a zero-length body**,
// not a 429. That is the dangerous failure: parseFeed turns it into [] and the
// source is marked healthy with n=0. Status codes are not sufficient here —
// every response is checked for feed shape before it is trusted.
//
// There is also no ETag and no Last-Modified, so conditional GET is unavailable
// and every poll costs a whole request from that budget.

import { get, BROWSER_UA, sleep } from "../util/http.mjs";
import { parseFeed } from "../util/feed.mjs";
import { hashId, stripTags } from "../util/text.mjs";
import { REDDIT_GAP_MS, REDDIT_COOLDOWN_MS, REDDIT_QUERIES_PER_CYCLE, REDDIT_COMMENTS } from "../config.mjs";

const IMG_RE = /https?:\/\/[^\s"'<>)]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>)]*)?/gi;

function extractImages(...blobs) {
  const out = new Set();
  for (const b of blobs) {
    if (!b) continue;
    for (const m of String(b).matchAll(IMG_RE)) out.add(m[0]);
  }
  return [...out].slice(0, 6);
}

/**
 * Recover the publishing outlet. Google News links are news.google.com
 * redirects, so the URL tells us nothing — but the headline carries a
 * " - Outlet" suffix and RSS carries a <source> tag. Without this, world-map
 * attribution fails for the single largest source of items we have.
 */
function outletFor(entry, label) {
  if (entry.sourceName) return entry.sourceName;
  const m = (entry.title || "").match(/\s[-–—]\s([^-–—]{2,40})\s*$/);
  if (m) return m[1].trim();
  try {
    return new URL(entry.link).hostname.replace(/^www\./, "");
  } catch {
    return label;
  }
}

// Reddit thumbnails, avatars, awards and site chrome are not content.
const JUNK_IMG = /(thumbs\.redditmedia|redditstatic|styles\/|award|icon|avatar|external-preview.*?width=(?:[1-9]\d?|1\d\d)\b|spinner|badge)/i;

/**
 * Canonical form of a link, for identity.
 *
 * Reddit serves the same post under several hosts and with tracking query
 * strings, and a trailing slash is not a different post.
 */
function canonicalUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    x.hash = "";
    x.search = "";
    x.host = x.host.replace(/^(old|www|new|amp)\./, "");
    x.pathname = x.pathname.replace(/\/+$/, "");
    return `${x.host}${x.pathname}`.toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

function toItem(entry, { origin, label }) {
  const text = `${entry.title} ${entry.summary}`.trim();
  const outlet = outletFor(entry, label);
  return {
    // Identity is the LINK, not the query that happened to surface it.
    //
    // This was `hashId(label, link)`, so the same post arriving via the global
    // search ("Reddit (all)") and via a subreddit feed ("r/JimothyTheRaccoon")
    // produced two different ids, survived the seen-set, and appeared twice in
    // the feed, twice in LOCATED LEADS and twice inside a cluster — which is
    // what made the panels look like they were repeating themselves.
    id: hashId(canonicalUrl(entry.link) || entry.title),
    origin,
    source: origin === "news" && outlet !== label ? `${label} · ${outlet}` : label,
    title: entry.title,
    text,
    url: entry.link,
    ts: entry.published,
    // ONLY this entry's own markup. Scanning the whole feed document gave every
    // item every image in the feed — 450 images across 369 items, nearly all
    // mis-attributed, and every one of them a vision-API charge.
    images: extractImages(entry.summary).filter((u) => !JUNK_IMG.test(u)),
    meta: { outlet },
    fetchedAt: Date.now(),
  };
}

async function fetchFeed(url, { origin, label, ua = BROWSER_UA }) {
  const raw = await get(url, { ua });
  return parseFeed(raw).map((e) => toItem(e, { origin, label }));
}

// --- Reddit serialisation ------------------------------------------------
//
// The gap gates the NEXT call; it must not delay this one's result. The
// previous version awaited sleep(REDDIT_GAP_MS) before resolving, so every
// caller paid the full gap even when nothing was queued behind it — with the
// gap raised to the real 65s budget that would have made a single reddit tick
// block for 66 seconds inside runItemSource for no reason at all.
let redditGate = Promise.resolve();
function redditQueued(fn) {
  const mine = redditGate.then(fn);
  // The next caller waits for this call AND the gap; this caller does not.
  redditGate = mine.then(() => sleep(REDDIT_GAP_MS), () => sleep(REDDIT_GAP_MS));
  return mine;
}

const REDDIT_HOST = "https://www.reddit.com";

/**
 * Reject a response that is 200-but-not-a-feed.
 *
 * Reddit answers an over-budget request with an empty 200, and serves a large
 * anti-bot interstitial on a cold-start 403. Both parse to zero items and both
 * would otherwise be recorded as a healthy poll that simply found nothing.
 */
function assertFeed(raw, where) {
  const s = String(raw || "");
  if (!s.trim()) throw new Error(`${where}: empty body (rate-limited)`);
  if (!/<(feed|rss)\b/i.test(s)) {
    throw new Error(`${where}: not a feed (${s.length}B — likely interstitial)`);
  }
  return s;
}

// The rotation. One request per cycle, so ordering is the whole design.
//
// The global search earns half the slots because it is the only cross-subreddit
// view and it is dominated by the right places: a live pull returned 17 of 25
// entries from r/JimothyTheRaccoon, plus r/JimothyRaccoon — two dedicated subs
// that this project has never polled. r/JimothyTheRaccoon alone is 9,032
// subscribers and 668 posts in its first 10 days, with no sign of decay.
//
// r/Ballard is DROPPED. It carries no Jimothy posts at all — about 20 posts in
// seven months, the newest from a dental-hygiene student — and it was consuming
// a quarter of a budget that only has room for one call a minute.
const REDDIT_QUERIES = [
  { kind: "search", sub: "all", q: "jimothy", label: "Reddit (all)" },
  { kind: "new", sub: "JimothyTheRaccoon", label: "r/JimothyTheRaccoon" },
  { kind: "search", sub: "all", q: "jimothy", label: "Reddit (all)" },
  { kind: "search", sub: "Seattle", q: "jimothy", label: "r/Seattle" },
  { kind: "search", sub: "all", q: "jimothy", label: "Reddit (all)" },
  { kind: "new", sub: "JimothyRaccoon", label: "r/JimothyRaccoon" },
  { kind: "search", sub: "all", q: "jimothy", label: "Reddit (all)" },
  { kind: "search", sub: "SeattleWA", q: "jimothy", label: "r/SeattleWA" },
];

const redditUrl = (query) => {
  if (query.kind === "new") return `${REDDIT_HOST}/r/${query.sub}/new.rss?limit=50`;
  return query.sub === "all"
    ? `${REDDIT_HOST}/search.rss?q=${encodeURIComponent(query.q)}&sort=new&limit=100`
    : `${REDDIT_HOST}/r/${query.sub}/search.rss?q=${encodeURIComponent(query.q)}` +
      `&restrict_sr=1&sort=new&limit=100`;
};

// Round-robin cursor: we spend our small request budget on one query per cycle
// rather than burning all four and getting throttled for everything.
let rrCursor = 0;
let cooldownUntil = 0;

export function redditCooldownRemaining() {
  return Math.max(0, cooldownUntil - Date.now());
}

export const feedSources = [
  {
    id: "googlenews",
    origin: "news",
    label: "Google News",
    async fetch() {
      return fetchFeed(
        "https://news.google.com/rss/search?q=Jimothy+raccoon&hl=en-US&gl=US&ceid=US:en",
        { origin: "news", label: "Google News" }
      );
    },
  },
  {
    id: "bingnews",
    origin: "news",
    label: "Bing News",
    async fetch() {
      return fetchFeed("https://www.bing.com/news/search?q=jimothy+raccoon&format=RSS", {
        origin: "news",
        label: "Bing News",
      });
    },
  },
  {
    id: "myballard",
    origin: "hyperlocal",
    label: "MyBallard.com",
    async fetch() {
      // Highest signal-to-noise source we found. Filtered to Jimothy items here
      // because the blog covers all Ballard news.
      const all = await fetchFeed("https://www.myballard.com/feed/", {
        origin: "hyperlocal",
        label: "MyBallard.com",
      });
      return all.filter((i) => /jimothy|raccoon/i.test(i.text));
    },
  },
  {
    id: "reddit",
    origin: "forum",
    label: "Reddit",
    async fetch() {
      if (redditCooldownRemaining() > 0) {
        throw new Error(`cooling down ${Math.ceil(redditCooldownRemaining() / 1000)}s after 429`);
      }
      const out = [];
      for (let n = 0; n < REDDIT_QUERIES_PER_CYCLE; n++) {
        const query = REDDIT_QUERIES[rrCursor % REDDIT_QUERIES.length];
        rrCursor++;
        const url = redditUrl(query);
        try {
          out.push(...(await redditQueued(async () => {
            const raw = assertFeed(await get(url, { ua: BROWSER_UA }), query.label);
            return parseFeed(raw).map((e) => toItem(e, { origin: "forum", label: query.label }));
          })));
        } catch (e) {
          // A 429 means back off everything reddit, not just this subreddit —
          // the limit is IP-wide and persists across restarts. An empty 200 is
          // the same signal wearing a different hat, so it backs off too.
          if (/429|empty body/.test(e.message)) {
            cooldownUntil = Date.now() + REDDIT_COOLDOWN_MS;
            throw new Error(`rate-limited — backing off ${REDDIT_COOLDOWN_MS / 60000}min`);
          }
          if (process.env.JM_VERBOSE) console.warn(`[reddit] ${query.label}: ${e.message}`);
        }
      }
      // Reddit's global search is cross-subreddit, so it drags in a long craft
      // and game-dev tail — a live pull carried Sculpey, polymerclay,
      // StainedGlass and gamedevscreens. They mention the name and nothing else.
      // Dropping them here keeps the corroboration engine from ever counting a
      // Jimothy-themed game jam as an origin.
      return out.filter((i) => /jimothy/i.test(`${i.title} ${i.text}`));
    },
  },
];

// Comment cache, keyed by permalink.
//
// recompute() picks its three deepen candidates out of a `candidates` array
// that is rebuilt from scratch on every pass, so the `!c.deepened` guard it
// relies on was thrown away each cycle and the SAME three threads were
// re-fetched forever — roughly 537 requests an hour against a budget of 24,
// which is almost certainly what earned the 429s the backoff exists to absorb.
// Each of those calls also sleeps REDDIT_GAP_MS inline inside recompute(), so
// this was additionally the largest single contributor to publish latency.
//
// A module-level cache survives the rebuild and fixes both.
const commentCache = new Map();
const COMMENT_TTL_MS = 6 * 3600_000;

/**
 * Fetch a Reddit post's comments, where the detail in sighting posts actually
 * lives. Titles alone resolved only generic "Ballard" during recon.
 *
 * Note the budget reality: at one request per 60s window shared with the search
 * calls, RSS cannot sustain comment coverage at any depth. This stays as the
 * opportunistic path; Arctic Shift (keyless, full comment JSON, no per-minute
 * ceiling) is the right way to read comments at scale.
 */
/**
 * Non-blocking comment read.
 *
 * Returns whatever is cached RIGHT NOW and, on a miss, warms the cache in the
 * background for the next pass. Nothing on the publish path waits.
 *
 * This matters more than it looks. recompute() deepens up to three posts and
 * used to `await` each one through the serialised Reddit gate; at the real
 * 65s budget that is a measured **133.5 seconds** of blocking before
 * `state.updatedAt` is set and `server.publish()` runs — every cycle where a
 * new candidate appears. Deepening a forum post is a nice-to-have; holding the
 * entire dashboard for two minutes to do it is not.
 */
export function readRedditComments(permalink) {
  if (!permalink) return "";
  const hit = commentCache.get(permalink);
  if (hit && Date.now() - hit.at < COMMENT_TTL_MS) return hit.text;

  // Comment prefetch is OFF by default, and this is why.
  //
  // Reddit's anonymous budget is ONE request per ~60s window, shared across
  // everything we do. recompute() wants three comment threads per pass; each
  // one is a whole window. In practice the prefetch drained the budget the
  // SEARCH calls needed, so the primary source — the one that actually carries
  // sightings — sat at ok=false with consecutiveFailures climbing and the
  // dashboard showed Reddit red while quietly deepening posts nobody asked for.
  //
  // Deepening is a nice-to-have; the search is the product. Arctic Shift
  // (keyless, full comment JSON, no per-minute ceiling) is the right way to
  // read comments at depth and does not compete for this budget at all.
  if (!REDDIT_COMMENTS) return "";
  if (inflight.size >= 1) return "";
  inflight.add(permalink);
  fetchRedditComments(permalink).finally(() => inflight.delete(permalink));
  return "";
}
const inflight = new Set();

export async function fetchRedditComments(permalink) {
  if (!permalink) return "";

  const hit = commentCache.get(permalink);
  if (hit && Date.now() - hit.at < COMMENT_TTL_MS) return hit.text;

  // Respect the same cooldown as the search calls. Without this, comment
  // fetches kept hitting Reddit every couple of seconds during a 429 backoff,
  // which is exactly the behaviour the backoff exists to stop.
  if (redditCooldownRemaining() > 0) return hit?.text ?? "";

  const u = new URL(permalink);
  const url = `${REDDIT_HOST}${u.pathname.replace(/\/$/, "")}.rss?limit=30`;
  try {
    const raw = assertFeed(await redditQueued(() => get(url, { ua: BROWSER_UA })), "comments");
    const text = parseFeed(raw).map((e) => stripTags(e.summary)).join(" \n ").slice(0, 4000);
    commentCache.set(permalink, { at: Date.now(), text });
    if (commentCache.size > 500) commentCache.delete(commentCache.keys().next().value);
    return text;
  } catch (e) {
    if (/empty body/.test(e.message)) cooldownUntil = Date.now() + REDDIT_COOLDOWN_MS;
    // Negative-cache so a permalink that cannot be read is not retried on every
    // single pass for the rest of the process's life.
    commentCache.set(permalink, { at: Date.now(), text: "" });
    return "";
  }
}
