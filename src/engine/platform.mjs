// Platform identity for feed items — so the UI can badge each post with where
// it actually came from, and let the reader filter by source type.
//
// Law of Similarity: one platform, one colour, everywhere on the page.

const PLATFORMS = {
  x:         { key: "x",         label: "X",           colour: "#e8eef2" },
  reddit:    { key: "reddit",    label: "Reddit",      colour: "#ff5c31" },
  mastodon:  { key: "mastodon",  label: "Mastodon",    colour: "#7b6ef6" },
  bluesky:   { key: "bluesky",   label: "Bluesky",     colour: "#3b9cf5" },
  tiktok:    { key: "tiktok",    label: "TikTok",      colour: "#69c9d0" },
  youtube:   { key: "youtube",   label: "YouTube",     colour: "#ff4444" },
  instagram: { key: "instagram", label: "Instagram",   colour: "#e4489b" },
  news:      { key: "news",      label: "News",        colour: "#f0b429" },
  local:     { key: "local",     label: "Ballard",     colour: "#4ec97a" },
  inat:      { key: "inat",      label: "iNaturalist", colour: "#3ec9d6" },
};

export const PLATFORM_LIST = Object.values(PLATFORMS);

/**
 * Identify the true platform of an item. Origin alone is not enough: a Mastodon
 * item bridged from Bluesky is really a Bluesky post, and a news item linking to
 * an Instagram embed is still news.
 */
export function platformFor(item) {
  const url = item.url || "";
  const src = item.source || "";

  if (item.origin === "tiktok" || /tiktok\.com/.test(url)) return PLATFORMS.tiktok;
  if (item.origin === "social" || /x\.com|twitter\.com/.test(url)) return PLATFORMS.x;
  if (item.origin === "wildlife") return PLATFORMS.inat;
  if (item.origin === "hyperlocal") return PLATFORMS.local;
  if (item.origin === "forum" || /reddit\.com/.test(url)) return PLATFORMS.reddit;
  if (item.origin === "fediverse") {
    // bsky.brid.gy is the bridge that carries Bluesky posts into the fediverse —
    // our only route to Bluesky at all, since its own API returns 403.
    if (item.meta?.bridgedFrom === "bluesky" || /brid\.gy/.test(src)) return PLATFORMS.bluesky;
    return PLATFORMS.mastodon;
  }
  if (/youtu\.be|youtube\.com/.test(url)) return PLATFORMS.youtube;
  if (/instagram\.com/.test(url)) return PLATFORMS.instagram;
  return PLATFORMS.news;
}

/** Counts per platform, for the feed's filter chips. */
export function platformCounts(items) {
  const out = {};
  for (const i of items) {
    const p = i.platform || "news";
    out[p] = (out[p] || 0) + 1;
  }
  return out;
}
