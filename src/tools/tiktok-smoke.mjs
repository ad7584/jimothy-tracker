// TikTok smoke test — run this FROM THE DEPLOYED BOX, not just locally.
//
//   node src/tools/tiktok-smoke.mjs
//
// Every endpoint this source depends on was verified working from a
// RESIDENTIAL IP on 2026-07-29. Railway egress is datacenter IP space and
// TikTok treats datacenter ranges worse (captchas, empty bodies), so the one
// question this tool answers is: does the pipeline's TikTok leg work from
// WHERE IT ACTUALLY RUNS? Run it once after every deploy that touches ingest.
//
// Exit 0 = every required check passed. Short-link check is a WARN, not a
// failure — short codes rot, so a dead sample code proves nothing.

import { getJson, BROWSER_UA } from "../util/http.mjs";

// A stable, famous Jimothy video: ABC News, 2026-07-23, verified live.
const CANONICAL = "https://www.tiktok.com/@abcnews/video/7665832068449832222";
// A short link observed in the wild (Washington Post Jimothy video). May rot.
const SHORT = "https://www.tiktok.com/t/ZP8tnHRSS/";
const BSKY = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=jimothy&domain=tiktok.com&sort=latest&limit=5";

let failures = 0;
const pass = (name, detail) => console.log(`  PASS  ${name.padEnd(26)} ${detail}`);
const warn = (name, detail) => console.log(`  WARN  ${name.padEnd(26)} ${detail}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL  ${name.padEnd(26)} ${detail}`); };

console.log("\nTIKTOK SMOKE TEST — run from the deploy environment\n");

// 1. oEmbed on a canonical URL — the hydration path.
let thumbUrl = null;
try {
  const j = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(CANONICAL)}`,
    { ua: BROWSER_UA });
  if (j.title && (j.embed_product_id || j.html)) {
    thumbUrl = j.thumbnail_url || null;
    pass("oembed canonical", `title="${String(j.title).slice(0, 40)}…" id=${j.embed_product_id || "?"}`);
  } else {
    fail("oembed canonical", `200 but unexpected shape: ${JSON.stringify(j).slice(0, 120)}`);
  }
} catch (e) {
  fail("oembed canonical", e.message);
}

// 2. Thumbnail download — the poster-frame cache path.
if (thumbUrl) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(thumbUrl, { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } });
    clearTimeout(timer);
    const type = res.headers.get("content-type") || "?";
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok && /^image\//.test(type) && buf.length > 1000) {
      pass("thumbnail download", `${type} · ${(buf.length / 1024).toFixed(0)}KB`);
    } else {
      fail("thumbnail download", `HTTP ${res.status} · ${type} · ${buf.length}B`);
    }
  } catch (e) {
    fail("thumbnail download", e.message);
  }
} else {
  fail("thumbnail download", "skipped — no thumbnail_url from oEmbed");
}

// 3. oEmbed on a short link — the /t/ hydration path. WARN only: codes rot.
try {
  const j = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(SHORT)}`,
    { ua: BROWSER_UA });
  if (j.embed_product_id || j.html) pass("oembed short link", `resolved to id=${j.embed_product_id || "?"}`);
  else warn("oembed short link", "200 but no id — sample code may have rotted");
} catch (e) {
  warn("oembed short link", `${e.message} — sample code may have rotted; not a failure by itself`);
}

// 4. Bluesky discovery — the primary search channel.
try {
  const j = await getJson(BSKY, { ua: BROWSER_UA });
  const n = (j.posts || []).length;
  if (n > 0) pass("bluesky searchPosts", `${n} post(s) with TikTok links`);
  else warn("bluesky searchPosts", "200 but 0 posts — chatter may simply have gone quiet");
} catch (e) {
  fail("bluesky searchPosts", e.message);
}

// 5. embed/v2 player page — what the dashboard iframes. Verifies reachability
//    and that TikTok still is not sending X-Frame-Options on it.
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const res = await fetch("https://www.tiktok.com/embed/v2/7665832068449832222",
    { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } });
  clearTimeout(timer);
  const xfo = res.headers.get("x-frame-options");
  const csp = res.headers.get("content-security-policy") || "";
  const framable = !xfo && !/frame-ancestors/i.test(csp);
  if (res.ok && framable) pass("embed/v2 framable", `HTTP ${res.status} · no X-Frame-Options, no frame-ancestors`);
  else if (res.ok) fail("embed/v2 framable", `reachable but frame-blocked (XFO=${xfo || "none"})`);
  else fail("embed/v2 framable", `HTTP ${res.status}`);
  await res.arrayBuffer(); // drain
} catch (e) {
  fail("embed/v2 framable", e.message);
}

console.log(failures
  ? `\n${failures} FAILURE(S) — the TikTok leg is degraded from this network. If this is Railway,` +
    `\nthe documented fallback is client-side oEmbed from visitors' browsers (CORS is *).\n`
  : "\nAll required checks passed from this network.\n");
process.exit(failures ? 1 : 0);
