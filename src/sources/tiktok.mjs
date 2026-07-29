// TikTok.
//
// TikTok cannot be searched keylessly — search and tag pages are empty shells
// whose results load via signed XHR (X-Bogus/msToken), verified 2026-07-29.
// But two keyless things DO work, so this source mirrors the X architecture
// exactly: harvest video URLs from places that CAN be searched, then hydrate
// each one by URL.
//
//   DISCOVER  Bluesky searchPosts with domain=tiktok.com — measured 25/25 posts
//             carrying TikTok links, ~2-3 distinct videos/day, arriving a
//             median ~5h after the TikTok is posted. Plus a regex pass over
//             every item the tracker already ingests (Reddit, Mastodon, news,
//             hydrated tweets), which costs nothing.
//   HYDRATE   www.tiktok.com/oembed?url=… — official, keyless, no rate limit
//             published. Returns caption, author, embed id and a poster frame.
//             It accepts /t/ short links directly (verified), so short codes
//             need no separate resolution step.
//
// The oEmbed thumbnail_url is SIGNED and expires ~48h after issuance, so the
// bytes are downloaded at ingest and cached to disk — the dashboard and the
// vision pass read the cache, never the rotting URL.
//
// The video's own creation time is encoded in its id: id >> 32 is unix seconds
// (verified against known post dates). Free timestamping, no extra request.

import { mkdir, readdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { getJson, BROWSER_UA, sleep } from "../util/http.mjs";
import { hashId } from "../util/text.mjs";
import { redactCoordinates } from "../engine/privacy.mjs";
import { DATA_DIR, TIKTOK } from "../config.mjs";
import { isSeen } from "../store.mjs";

// Canonical video/photo URL. Usernames allow letters, digits, dot, underscore.
const CANONICAL_RE =
  /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([\w.-]+)\/(video|photo)\/(\d{15,20})/g;
// Short links. tiktok.com/t/CODE, vm.tiktok.com/CODE and vt.tiktok.com/CODE
// share one code space (verified: /t/ and vm. resolve to identical canonicals).
// Codes are case-SENSITIVE alphanumerics — never lowercase them.
const SHORT_RE =
  /https?:\/\/(?:(?:www\.|m\.)?tiktok\.com\/t\/|(?:vm|vt)\.tiktok\.com\/)([A-Za-z0-9]{4,16})/g;
const EMBED_RE = /tiktok\.com\/embed\/v2\/(\d{15,20})/g;

const oembedUrl = (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`;

/** id >> 32 = unix seconds. Sanity-bounded so a garbage id can't invent a date. */
export function tsFromTikTokId(id) {
  try {
    const s = Number(BigInt(id) >> 32n) * 1000;
    if (s > Date.parse("2016-01-01") && s < Date.now() + 86400_000) return s;
  } catch {}
  return null;
}

// --- Harvest --------------------------------------------------------------
// URLs found in other sources' text queue here and are hydrated on the next
// tiktok cycle. Bounded: a runaway feed cannot grow this without limit.
// Memory-only, so `--once` runs and restarts drop the queue — acceptable:
// Bluesky rediscovers anything with traction on the next cycle.
const pending = new Set();
// Hydration outcomes this process: video ids we have handled (either ingested
// or confirmed dead) and short codes we have chased (code -> videoId | null).
// Both bounded — insertion order IS age order, so trimming the front drops the
// oldest, and store.isSeen still guards anything trimmed against re-ingest.
const knownIds = new Set();
const shortSeen = new Map();
const KNOWN_CAP = 5000;
function boundKnown() {
  while (knownIds.size > KNOWN_CAP) knownIds.delete(knownIds.values().next().value);
  while (shortSeen.size > KNOWN_CAP) shortSeen.delete(shortSeen.keys().next().value);
}

// Transient-failure retry ledger: a URL that keeps failing (persistent 403,
// upstream flap) is dropped after a few attempts instead of occupying a slot
// of the hydration budget forever.
const attempts = new Map();
const MAX_ATTEMPTS = 3;
function requeue(url) {
  const n = (attempts.get(url) || 0) + 1;
  if (n >= MAX_ATTEMPTS) {
    attempts.delete(url);
    return false;
  }
  attempts.set(url, n);
  if (attempts.size > 400) attempts.delete(attempts.keys().next().value);
  if (pending.size >= TIKTOK.maxPending) return false;
  pending.add(url);
  return true;
}

/** Pull TikTok links out of any text we have already ingested. */
export function queueTikTokUrls(text) {
  const s = String(text || "");
  let n = 0;
  for (const m of s.matchAll(CANONICAL_RE)) {
    if (knownIds.has(m[3])) continue;
    if (pending.size >= TIKTOK.maxPending) break;
    pending.add(`https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`);
    n++;
  }
  for (const m of s.matchAll(SHORT_RE)) {
    if (shortSeen.has(m[1])) continue;
    if (pending.size >= TIKTOK.maxPending) break;
    // Normalise every short host to the /t/ form — same code space, and the
    // oEmbed endpoint accepts that form directly (verified live).
    pending.add(`https://www.tiktok.com/t/${m[1]}/`);
    n++;
  }
  for (const m of s.matchAll(EMBED_RE)) {
    if (knownIds.has(m[1])) continue;
    if (pending.size >= TIKTOK.maxPending) break;
    // oEmbed REJECTS /embed/v2/ input with a 400 (verified live — a 400 on a
    // live video), so an embed-harvested id is queued in the canonical form
    // instead. oEmbed ignores the username segment entirely (also verified),
    // so a placeholder handle hydrates fine and the real author comes back in
    // the response.
    pending.add(`https://www.tiktok.com/@tiktok/video/${m[1]}`);
    n++;
  }
  return n;
}

// --- Bluesky discovery ----------------------------------------------------
// api.bsky.app is keyless (public.api.bsky.app is CDN-blocked — do not
// "correct" the host). Token bucket is ~10 calls recovering ~15s, so the two
// queries are serialised with a gap. The posts themselves are NOT ingested —
// Bluesky content already reaches the feed via the brid.gy bridge; this call
// exists purely to find TikTok links, which the bridge strips less reliably.
const BSKY_SEARCH = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const BSKY_QUERIES = [
  { q: "jimothy", domain: "tiktok.com" }, // link-facet filter: highest yield
  { q: "jimothy tiktok" },                // catches bare-text mentions
];

async function fetchBlueskyLinks() {
  const urls = new Set();
  for (let i = 0; i < BSKY_QUERIES.length; i++) {
    if (i) await sleep(2000);
    const p = new URLSearchParams({ ...BSKY_QUERIES[i], sort: "latest", limit: "25" });
    const j = await getJson(`${BSKY_SEARCH}?${p}`, { ua: BROWSER_UA });
    for (const post of j.posts || []) {
      const rec = post.record || {};
      const blobs = [
        rec.text || "",
        rec.embed?.external?.uri || "",
        ...(rec.facets || []).flatMap((f) => (f.features || []).map((x) => x.uri || "")),
      ];
      for (const b of blobs) {
        for (const m of String(b).matchAll(CANONICAL_RE)) urls.add(m[0]);
        for (const m of String(b).matchAll(SHORT_RE)) urls.add(`https://www.tiktok.com/t/${m[1]}/`);
      }
    }
  }
  return [...urls];
}

// --- oEmbed hydration -----------------------------------------------------

/** The numeric video id, from whichever field this oEmbed response carries it in. */
function idFromOembed(j, sourceUrl) {
  const fromField = String(j.embed_product_id || "");
  if (/^\d{15,20}$/.test(fromField)) return fromField;
  const html = String(j.html || "");
  const m = html.match(/data-video-id="(\d{15,20})"/) || html.match(/\/video\/(\d{15,20})/) ||
            String(sourceUrl).match(/\/(?:video|photo)\/(\d{15,20})/) ||
            String(sourceUrl).match(/\/embed\/v2\/(\d{15,20})/);
  return m ? m[1] : null;
}

/**
 * Hydrate one TikTok URL (canonical, /t/ short, or embed) into an item.
 * Throws on network failure; returns null for a dead/private/unparseable video.
 */
async function hydrateOne(url) {
  let j;
  try {
    j = await getJson(oembedUrl(url), { ua: BROWSER_UA });
  } catch (e) {
    // oEmbed answers 400/404 for removed and private videos — a definitive
    // "gone", not a transient failure. Anything else propagates.
    if (e.status === 400 || e.status === 404) return null;
    throw e;
  }
  const videoId = idFromOembed(j, url);
  if (!videoId) return null;

  const author = String(j.author_unique_id || "").trim() ||
    (String(j.author_url || "").match(/@([\w.-]+)/) || [])[1] || null;
  const kind = /\/photo\//.test(url) ? "photo" : "video";
  const canonical = author
    ? `https://www.tiktok.com/@${author}/${kind}/${videoId}`
    : `https://www.tiktok.com/embed/v2/${videoId}`;

  // Captions are stranger-authored text that renders on the dashboard, and
  // people ARE posting raw coordinates. Redact at ingest, same policy as
  // everywhere else in the pipeline.
  const caption = redactCoordinates(String(j.title || "")).text.trim();

  return {
    id: hashId("tiktok", videoId),
    origin: "tiktok",
    source: author ? `TikTok · @${author}` : "TikTok",
    title: caption.slice(0, 140) || `TikTok ${kind} by @${author || "unknown"}`,
    text: caption,
    url: canonical,
    ts: tsFromTikTokId(videoId) || null,
    // The signed CDN URL, kept for provenance. Consumers should read the
    // cached copy via meta.thumb — this URL dies ~48h after issuance.
    images: j.thumbnail_url ? [j.thumbnail_url] : [],
    meta: {
      tiktokId: videoId,
      author,
      tiktokKind: kind,
      thumb: `/api/tikthumb/${videoId}`,
      thumbnailUrl: j.thumbnail_url || null,
    },
    fetchedAt: Date.now(),
  };
}

// --- Thumbnail cache ------------------------------------------------------
// Bytes on disk under data/tikthumbs/<videoId>, format sniffed on read. The
// signed URL rots in ~48h; the cache is what the dashboard and the recogniser
// actually read, and it survives restarts.
const THUMB_DIR = () => join(DATA_DIR, "tikthumbs");
const thumbIndex = new Map(); // videoId -> { at }
const thumbMem = new Map();   // videoId -> { buf, type } — small hot cache

export async function initTikTokCache() {
  await mkdir(THUMB_DIR(), { recursive: true });
  try {
    for (const f of await readdir(THUMB_DIR())) {
      if (!/^\d{15,20}$/.test(f)) continue;
      const st = await stat(join(THUMB_DIR(), f)).catch(() => null);
      if (st) thumbIndex.set(f, { at: st.mtimeMs });
    }
  } catch {}
  return thumbIndex.size;
}

function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 12 && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

async function cacheThumb(videoId, thumbnailUrl) {
  if (!thumbnailUrl || thumbIndex.has(videoId)) return thumbIndex.has(videoId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(thumbnailUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": BROWSER_UA },
    });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    // Only formats the vision API accepts. Caching an AVIF and serving it as
    // jpeg would waste a PAID model call on an undecodable image.
    if (!/^image\/(jpe?g|png|webp)/.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 4_500_000) return false;
    await writeFile(join(THUMB_DIR(), videoId), buf);
    thumbIndex.set(videoId, { at: Date.now() });
    thumbMem.set(videoId, { buf, type: sniffImageType(buf) });
    if (thumbMem.size > 40) thumbMem.delete(thumbMem.keys().next().value);
    await pruneThumbs();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pruneThumbs() {
  if (thumbIndex.size <= TIKTOK.maxThumbs) return;
  const oldest = [...thumbIndex.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id] of oldest.slice(0, thumbIndex.size - TIKTOK.maxThumbs)) {
    thumbIndex.delete(id);
    thumbMem.delete(id);
    await unlink(join(THUMB_DIR(), id)).catch(() => {});
  }
}

/** Cached thumbnail bytes for one video, or null. */
export async function getThumb(videoId) {
  if (!/^\d{15,20}$/.test(String(videoId))) return null;
  const hot = thumbMem.get(videoId);
  if (hot) return hot;
  if (!thumbIndex.has(videoId)) return null;
  try {
    const buf = await readFile(join(THUMB_DIR(), videoId));
    const entry = { buf, type: sniffImageType(buf) };
    thumbMem.set(videoId, entry);
    // The hot cache is for the handful the dashboard is actively serving.
    if (thumbMem.size > 40) thumbMem.delete(thumbMem.keys().next().value);
    return entry;
  } catch {
    thumbIndex.delete(videoId);
    return null;
  }
}

export const hasThumb = (videoId) => thumbIndex.has(String(videoId));

/**
 * Late thumbnail recovery. A transient CDN failure at ingest must not orphan
 * the video for good — the signed URL stays fetchable for ~48h, so the
 * recogniser gets to re-attempt the download until the URL is genuinely dead.
 * Bounded by the caller's per-cycle scoring cap.
 */
export async function ensureThumb(videoId, thumbnailUrl, fetchedAt) {
  if (hasThumb(videoId)) return true;
  if (!thumbnailUrl) return false;
  // Past ~44h the signature is dead or dying; stop burning requests on it.
  if (!fetchedAt || Date.now() - fetchedAt > 44 * 3600_000) return false;
  return cacheThumb(String(videoId), thumbnailUrl);
}

// --- The source -----------------------------------------------------------

export const tiktokSource = {
  id: "tiktok",
  origin: "tiktok",
  label: "TikTok",
  async fetch() {
    // Everything queued by other sources since the last cycle, plus whatever
    // Bluesky can see right now. Discovery failure only fails the cycle when
    // it was the only work — queued URLs still deserve their hydration.
    const urls = new Set(pending);
    pending.clear();
    let discoveryError = null;
    try {
      for (const u of await fetchBlueskyLinks()) urls.add(u);
    } catch (e) {
      discoveryError = e;
    }

    const items = [];
    let budget = TIKTOK.maxHydratePerCycle;
    for (const url of urls) {
      // Skip work we can prove is already done BEFORE spending budget or a
      // requeue slot on it. Canonical/embed URLs carry the id; short codes we
      // have chased before are in shortSeen.
      const idMatch = url.match(/\/(?:video|photo)\/(\d{15,20})/) || url.match(/\/embed\/v2\/(\d{15,20})/);
      const knownId = idMatch?.[1];
      const shortCode = (url.match(/\/t\/([A-Za-z0-9]{4,16})/) || [])[1];
      if (knownId && (knownIds.has(knownId) || isSeen(hashId("tiktok", knownId)))) {
        knownIds.add(knownId);
        continue;
      }
      if (shortCode && shortSeen.has(shortCode)) continue;

      if (budget <= 0) {
        // Carry the overflow to the next cycle — but never past the cap, and
        // never for URLs Bluesky will simply rediscover anyway.
        if (pending.size < TIKTOK.maxPending) pending.add(url);
        continue;
      }

      budget--;
      let item;
      try {
        item = await hydrateOne(url);
      } catch (e) {
        // Transient failure — requeue for the next cycle (bounded attempts,
        // bounded queue) rather than losing a URL that may never be
        // rediscovered, and keep going: one flaky call must not cost the rest
        // of this batch their hydration.
        requeue(url);
        discoveryError = discoveryError || e;
        continue;
      }
      attempts.delete(url);
      if (shortCode) shortSeen.set(shortCode, item?.meta.tiktokId || null);
      if (!item) {
        if (knownId) knownIds.add(knownId); // dead or private — never retry
        continue;
      }
      const vid = item.meta.tiktokId;
      if (knownIds.has(vid) || isSeen(item.id)) {
        // A short code can be a second name for a video we already hold.
        knownIds.add(vid);
        continue;
      }
      knownIds.add(vid);
      // Fetch the poster frame NOW — its signed URL is already counting down.
      item.meta.thumbCached = await cacheThumb(vid, item.meta.thumbnailUrl);
      items.push(item);
      await sleep(500); // polite spacing on the oEmbed endpoint
    }

    boundKnown();
    // A cycle that hit errors and produced nothing is a failed cycle — red row.
    // Errors alongside successful hydrations only warn; the work still counts.
    if (discoveryError && !items.length) throw discoveryError;
    if (discoveryError) console.warn(`[tiktok] partial failure: ${discoveryError.message}`);
    return items;
  },
};
