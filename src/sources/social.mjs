// Fediverse + X.
//
// Mastodon's public tag timeline needs no key and carries media attachments.
// It also transparently picks up bridged Bluesky posts via bsky.brid.gy, which
// is our only route to Bluesky at all — its own public API returns 403 here.
//
// X cannot be searched without a paid API. But cdn.syndication.twimg.com's
// tweet-result endpoint hydrates any tweet BY ID with full text, engagement and
// media, given a platform Referer. So we harvest x.com links from other sources
// and hydrate them.

import { get, getJson, BROWSER_UA } from "../util/http.mjs";
import { hashId, stripTags } from "../util/text.mjs";

export const mastodonSource = {
  id: "mastodon",
  origin: "fediverse",
  label: "Mastodon #jimothy",
  async fetch() {
    const arr = await getJson(
      "https://mastodon.social/api/v1/timelines/tag/jimothy?limit=40",
      { ua: BROWSER_UA }
    );
    return arr.map((p) => {
      const text = stripTags(p.content);
      let instance = "";
      try {
        instance = new URL(p.url || p.uri).host;
      } catch {}
      return {
        id: hashId("mastodon", p.uri || p.url || p.id),
        origin: "fediverse",
        source: instance ? `Mastodon · ${instance}` : "Mastodon",
        title: text.slice(0, 140),
        text,
        url: p.url || p.uri,
        ts: Date.parse(p.created_at) || null,
        images: (p.media_attachments || [])
          .filter((m) => m.type === "image")
          .map((m) => m.preview_url || m.url)
          .filter(Boolean),
        meta: {
          instance,
          // bsky.brid.gy means this originated on Bluesky and was bridged.
          bridgedFrom: instance.includes("brid.gy") ? "bluesky" : null,
          boosts: p.reblogs_count ?? 0,
          favourites: p.favourites_count ?? 0,
        },
        fetchedAt: Date.now(),
      };
    });
  },
};

const X_ID_RE = /(?:twitter|x)\.com\/[^/\s]+\/status\/(\d{10,25})/gi;

/** Pull tweet ids out of any text we have already ingested. */
export function harvestTweetIds(text) {
  const ids = new Set();
  for (const m of String(text || "").matchAll(X_ID_RE)) ids.add(m[1]);
  return [...ids];
}

/**
 * Hydrate one tweet by id. Requires the platform Referer — without it the
 * endpoint returns an empty body.
 */
export async function hydrateTweet(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&lang=en&token=a`;
  const raw = await get(url, {
    ua: BROWSER_UA,
    accept: "application/json",
    headers: { Referer: "https://platform.twitter.com/" },
  });
  if (!raw || !raw.trim()) throw new Error("empty tweet-result body");
  const t = JSON.parse(raw);
  if (!t || !t.text) throw new Error("tweet-result missing text");

  const images = [];
  for (const m of t.mediaDetails || []) {
    if (m.type === "photo" && m.media_url_https) images.push(m.media_url_https);
  }
  const screen = t.user?.screen_name || "unknown";
  return {
    id: hashId("x", id),
    origin: "social",
    source: `X · @${screen}`,
    title: t.text.slice(0, 140),
    text: t.text,
    url: `https://x.com/${screen}/status/${id}`,
    ts: Date.parse(t.created_at) || null,
    images,
    meta: {
      tweetId: id,
      author: screen,
      authorName: t.user?.name || null,
      favourites: t.favorite_count ?? 0,
      verified: Boolean(t.user?.is_blue_verified),
    },
    fetchedAt: Date.now(),
  };
}
