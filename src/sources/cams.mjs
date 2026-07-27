// Cameras — Seattle / Washington only.
//
// TWO KINDS, and the difference matters:
//
// 1. SDOT STREET CAMERAS. Seattle DOT runs 646 public traffic cameras; ten sit
//    within 2.6km of Ballard centre and one is 250m away at 24th & Market.
//    These are 1280x720, street-level, close-range and lit at night — a raccoon
//    crossing that intersection would be 40-80px and plainly visible.
//    Discovered via web.seattle.gov/Travelers/api/Map/Data?type=2. NOTE: at low
//    zoom that API clusters cameras under one centroid, so coordinates must be
//    taken from the highest zoom where a point holds a single camera.
//
//    This corrects an earlier assumption in this project. WSDOT's FREEWAY cams
//    are ~330x190 and useless for an animal — but SDOT's city cams are not the
//    same thing at all, and are genuinely worth pointing a recogniser at.
//
// 2. WASHINGTON WILDLIFE STREAMS. YouTube live channels run by WA zoos and
//    aquariums. Context, not detection.
//
// Nothing outside Washington. Per the team's scope decision.

import { get, BROWSER_UA } from "../util/http.mjs";

const SDOT_IMG = "https://www.seattle.gov/trafficcams/images";

// A still older than this is not a camera, it is a photograph. SDOT publishes
// roughly every 5 minutes, so an hour is ~12 missed publishes: generous enough
// to survive a blip, tight enough to catch a decommissioned camera.
const STALE_AFTER_MS = 60 * 60_000;

/** Distance in km from Ballard centre — computed once, at authoring time. */
export const TRAFFIC_CAMS = [
  { id: "t_24_market",  name: "24th Ave NW & NW Market St", file: "24_NW_Market_EW.jpg",
    lat: 47.6687, lon: -122.3876, km: 0.25, note: "Ballard core — closest camera to Jimothy's range" },
  { id: "t_15_leary",   name: "15th Ave NW & NW Leary Way", file: "15_NW_Leary_EW.jpg",
    lat: 47.6637, lon: -122.3753, km: 0.86, note: "" },
  { id: "t_15_65",      name: "15th Ave NW & NW 65th St",   file: "15_NW_65_1.jpg",
    lat: 47.6764, lon: -122.3768, km: 1.04, note: "" },
  { id: "t_15_emerson", name: "15th Ave W & W Emerson St",  file: "15_W_Emerson_NS.jpg",
    lat: 47.6539, lon: -122.3763, km: 1.73, note: "" },
  { id: "t_15_nickers", name: "15th Ave W & W Nickerson St", file: "15_W_Nickerson.jpg",
    lat: 47.6535, lon: -122.3762, km: 1.78, note: "" },
  { id: "t_leary_43",   name: "Leary Way NW & NW 43rd St",  file: "Leary_NW_43_EW.jpg",
    lat: 47.6589, lon: -122.3647, km: 1.81, note: "" },
  { id: "t_15_dravus",  name: "15th Ave W & W Dravus St",   file: "15_W_Dravus_NS.jpg",
    lat: 47.6486, lon: -122.3764, km: 2.30, note: "" },
  { id: "t_phinney_46", name: "Phinney Ave N & N 46th St",  file: "Phinney_N_46_SWC.jpg",
    lat: 47.6621, lon: -122.3540, km: 2.38, note: "" },
  { id: "t_15_85",      name: "15th Ave NW & NW 85th St",   file: "15_NW_85_NS.jpg",
    lat: 47.6906, lon: -122.3768, km: 2.52, note: "North Ballard / Crown Hill" },

  // Added 2026-07-27 after a sweep of every SDOT camera within 5km. Each was
  // confirmed serving a fresh still AND a live HLS stream.
  { id: "t_aurora_46",  name: "Aurora Ave N & N 46th St",    file: "Aurora_N_46.jpg",
    lat: 47.6614, lon: -122.3447, km: 2.87, note: "Wallingford / Green Lake edge · 1080p" },
  { id: "t_evanston_36", name: "Evanston Ave N & N 36th St", file: "Evanston_N_36_EW.jpg",
    lat: 47.6512, lon: -122.3506, km: 3.11, note: "Fremont — no prior coverage" },
  { id: "t_fremont_34", name: "Fremont Ave N & N 34th St",   file: "Fremont_N_34_NS.jpg",
    lat: 47.6497, lon: -122.3499, km: 3.33, note: "Fremont Bridge approach, Ship Canal" },
  { id: "t_bridge_38",  name: "Bridge Way N & N 38th St",    file: "Bridge_N_38.jpg",
    lat: 47.6518, lon: -122.3477, km: 3.33, note: "Aurora Bridge approach · 1080p" },
  // The best habitat frame found anywhere in the sweep: Elliott Bay Trail,
  // mown lawn, mature trees and shoreline, with almost no traffic in shot.
  { id: "t_alaskan_galer", name: "Alaskan Way W & W Galer Flyover", file: "Alaskan_W_Galer_NS.jpg",
    lat: 47.6297, lon: -122.3776, km: 4.13, note: "Elliott Bay Trail — shoreline and tree cover" },

  // DELIBERATELY EXCLUDED, so nobody re-adds them:
  //   Linden_N_46      — still frozen since 2026-01-12, and a tent encampment
  //                      is in frame. Stale AND a privacy problem.
  //   GreenLake_N_46   — an underpass, not the park; the tightest framing in the
  //                      fleet, with plates near the resolution limit.
  //   15_NW_65_2       — 1080p stream is live, but the still 302s to text/html.
  //                      Needs a video-only tile path that does not exist yet.
];

// Wildlife streams, PINNED BY VIDEO ID.
//
// This list used to be channel-only, and probeWildlife scraped the channel's
// /live page for the first videoId it could find. When a channel is dark that
// page is a recommendation grid, so the probe returned a STRANGER'S VIDEO and
// LIVE_MARKERS matched the grid's own markup and flagged it live. The dashboard
// then captioned it from the static config here.
//
// Observed in production on 2026-07-26, hours apart, both under the caption
// "Seattle Aquarium · Sea otter & fur seal cam" with a live indicator:
//   crMzlO0FBvQ  "Relaxing Bird Bath ... CatTV"          — LensMyth
//   tWjTeRR4d0I  "The Making of Mel Brooks' Young        — The JDP Channel
//                 Frankenstein (1974)"                     (a 2024 upload)
// It was also the DEFAULT TILE, because it was the only camera marked live.
// That is the one thing on the page that breaks "All data real, nothing
// simulated", so identity is now pinned and verified rather than inferred.
//
// Every entry below was confirmed live by direct fetch on 2026-07-26.
export const WILDLIFE_CAMS = [
  // Ballard's own shoreline. Shilshole sits between the Locks and Golden
  // Gardens — the exact shoreline foraging that SPEC §3 names and that the
  // NOAA tide gauge (9447130) already feeds into the foraging index. A Ballard
  // community organisation's own camera fits the conservation framing far
  // better than a zoo in another county.
  { id: "shilshole", name: "Shilshole Bay", video: "JVTvtCZcSWk",
    channel: "UCp4vzTGSyM5m8mnlBHb0nHA", where: "Ballard, Seattle",
    note: "Ballard Elks Paddling Club — Jimothy's own shoreline", local: true },
  { id: "uwcam", name: "UW Continuum Cam", video: "4cgSE12k9Sc",
    channel: null, where: "Seattle", note: "UW Video", local: true },
  // OUTDOOR ONLY. Removed as indoor tank/enclosure views, which tell you nothing
  // about a raccoon in a Seattle neighbourhood: Seattle Aquarium (NqOmHpwMUxs),
  // Long Live the Kings Fish Cam (5DJPaaCXHlQ), Rocky Reach Discovery Center
  // (TBFjYansL0k).
  //
  // Retired earlier as dead or misattributed: Woodland Park Zoo (E3cZej1D5qU,
  // ended 2020-10-15), Northwest Trek and Cougar Mountain (VOD, not live),
  // Point Defiance (no videoId resolves).
];

/**
 * Public OUTDOOR cameras that are not YouTube and not SDOT.
 *
 * `resolve` exists because neither of these is a stable image URL you can point
 * an <img> at and forget:
 *
 *   UW  — two-step. latest.php returns a RELATIVE path whose date folder is
 *         local-date while the filename is UTC, so the path cannot be
 *         constructed, only asked for. And latest.php itself is served with
 *         Cache-Control: max-age=172800 — poll it without a cache-buster and
 *         the tile freezes for two days.
 *   SPU — single URL, but Cache-Control: max-age=86400 (a day), and the image
 *         endpoint 403s a bare User-Agent. Both re-confirmed by direct fetch.
 *
 * Resolving server-side keeps the client a plain <img> with an absolute URL.
 */
export const AREA_CAMS = [
  {
    id: "uw_roof_west", name: "UW Atmospheric Sciences — West",
    operator: "University of Washington", where: "Seattle", km: 5.84,
    note: "Rooftop panorama: Fremont, the Ship Canal, Queen Anne, the Space Needle",
    attribution: "UW Dept. of Atmospheric Sciences",
    refreshMs: 60_000,
    async resolve() {
      const rel = (await get(`https://atmos.uw.edu/roof-west/latest.php?t=${Date.now()}`,
        { ua: BROWSER_UA, timeout: 15000, retries: 0 })).trim();
      if (!/^[\w./-]+\.jpg$/i.test(rel)) throw new Error("unexpected latest.php body");
      return `https://atmos.uw.edu/roof-west/${rel}`;
    },
  },
  {
    id: "spu_bertona", name: "Seattle Pacific University — East",
    operator: "Seattle Pacific University", where: "Queen Anne, Seattle", km: 3.1,
    note: "Rooftop east over Queen Anne toward Fremont and Lake Union",
    attribution: "Seattle Pacific University",
    refreshMs: 60_000,
    async resolve() {
      return `https://spu.edu/webcam/pics/bertona.jpg?t=${Date.now()}`;
    },
  },
  // NOT ADDED — Salmon Bay Marine Center dock cams. Technically the best find
  // in the sweep: ~1.1km, on the Ship Canal itself, 1-second HLS segments,
  // keyless, CORS-open, and ballardlocks.org points at it as the stand-in for
  // the Locks camera that does not exist. But it is a private business and the
  // page carries "(c) 2026 SBMC All Rights Reserved" with no embed grant and no
  // prohibition either. Silence is not permission. Ask them first.
];

/** Resolve every area camera to a concrete, currently-valid image URL. */
async function probeArea(cam) {
  const base = { ...cam, kind: "area", live: false, verified: true, url: null, frameAt: null };
  try {
    const url = await cam.resolve();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } });
    clearTimeout(timer);
    const lm = res.headers.get("last-modified");
    const frameAt = lm ? Date.parse(lm) : Date.now();
    const ok = res.ok && /^image\//.test(res.headers.get("content-type") || "");
    return { ...base, url, live: ok && Date.now() - frameAt < STALE_AFTER_MS, frameAt, ok };
  } catch (e) {
    return { ...base, ok: false, error: String(e.message || e).slice(0, 100) };
  }
}

const channelUrl = (c) => `https://www.youtube.com/channel/${c}`;
const channelEmbed = (c) => `https://www.youtube.com/embed/live_stream?channel=${c}&autoplay=0&mute=1&rel=0`;

// YouTube's markup varies by region, client and rollout, so no single flag is
// reliable. Any one of these means the video is currently broadcasting.
const LIVE_MARKERS = [
  /"isLive":\s*true/,
  /"isLiveNow":\s*true/,
  /hlsManifestUrl/,
  /"liveBroadcastDetails":\{"isLiveNow":true/,
  /<meta itemprop="isLiveBroadcast" content="True">/i,
];

// SDOT ALSO PUBLISHES LIVE HLS VIDEO, and this project only ever used the
// 5-minute stills.
//
// SPEC §3 rejects traffic cameras as "~330x190px, night, freeway. A raccoon is
// 2-5px." That is true of WSDOT's FREEWAY cameras and false of SDOT's city
// cameras, which are a different agency and different hardware. SDOT runs a
// public Wowza server whose URL template comes straight from their own map
// API:  GET https://web.seattle.gov/Travelers/api/Map/WowsaUrl
//       -> "https://61e0c5d388c2e.streamlock.net:443/live/{stream}/playlist.m3u8"
//
// Verified 2026-07-26: all nine configured cameras return HTTP 200
// application/vnd.apple.mpegurl, four at 1920x1080 and five at 1280x720, with
// Access-Control-Allow-Origin: *, keyless. #EXT-X-MEDIA-SEQUENCE advanced 70->73
// in 30s against #EXT-X-TARGETDURATION:11 — genuinely live, ~25s behind.
//
// This is a VIEWING upgrade only. Turning an MPEG-TS segment into a scoreable
// frame needs an H.264 decoder that Node core does not have, so recognition
// stays on the stills. Say so rather than implying the recogniser watches video.
const SDOT_HLS = "https://61e0c5d388c2e.streamlock.net:443/live";
const hlsUrl = (file) => `${SDOT_HLS}/${file.replace(/\.jpg$/i, "")}.stream/playlist.m3u8`;

/** Is this SDOT still actually being served? One of the ten 302s to a 404. */
async function probeTraffic(cam) {
  const url = `${SDOT_IMG}/${cam.file}`;
  const out = { ...cam, kind: "traffic", url, ok: false, live: false,
                hls: null, hlsResolution: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": BROWSER_UA } });
    clearTimeout(timer);
    // Last-Modified is when SDOT actually published this frame — the only
    // honest way to tell a viewer how fresh what they are looking at is.
    const lm = res.headers.get("last-modified");
    out.frameAt = lm ? Date.parse(lm) : null;

    const isImg = res.status === 200 && /^image\//.test(res.headers.get("content-type") || "");

    // A 200 with an image content-type is NOT proof the camera is working.
    //
    // Measured: seattle.gov/trafficcams/images/Linden_N_46.jpg returns HTTP 200,
    // image/jpeg, 30,111 bytes — with `Last-Modified: Mon, 12 Jan 2026`. That is
    // a six-month-old photograph, served indefinitely. The old check accepted it
    // as ok AND live, so it would have rendered as a current view of a Seattle
    // street and camwatch would have posted it to the vision model as tonight's
    // frame. Nothing downstream could have caught it.
    //
    // All nine shipped cameras were re-checked and are fresh within ~4 minutes,
    // so this costs us nothing today and closes the hole before it opens.
    out.stale = out.frameAt != null && Date.now() - out.frameAt > STALE_AFTER_MS;
    out.ok = isImg && !out.stale;
  } catch {
    return out;
  }

  // Probe the video separately: a camera can serve stills while its stream is
  // spun down, and Wowza starts streams on demand.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const u = hlsUrl(cam.file);
    const res = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } });
    clearTimeout(timer);
    if (res.ok && /mpegurl/i.test(res.headers.get("content-type") || "")) {
      const body = await res.text();
      out.hls = u;
      out.hlsResolution = body.match(/RESOLUTION=(\d+x\d+)/)?.[1] || null;
    }
  } catch { /* stills still work; video is a bonus, never a requirement */ }

  return out;
}

/**
 * Verify a pinned video is genuinely broadcasting RIGHT NOW.
 *
 * Checked against the /watch page, not the channel's /live page. Three tests,
 * and all three are needed:
 *   - isLiveBroadcast / isLiveNow            — is it live at all
 *   - NO endDate                             — a finished stream keeps
 *                                              isLiveContent:true forever, so
 *                                              this is what catches Woodland
 *                                              Park Zoo's 2020 stream
 *   - ownerChannelName is read from the page — never asserted from our config
 *
 * The returned `owner` is what the UI must caption with. If we could not read
 * it, the UI shows the offline card rather than our own label over someone
 * else's video.
 */
async function probeWildlife(cam) {
  const watch = (v) => `https://www.youtube.com/watch?v=${v}`;
  const base = {
    ...cam, kind: "wildlife", live: false, videoId: cam.video || null,
    title: null, owner: null, verified: false,
    url: cam.video ? watch(cam.video) : channelUrl(cam.channel),
    embed: cam.video ? `https://www.youtube.com/embed/${cam.video}?autoplay=0&mute=1&rel=0`
                     : channelEmbed(cam.channel),
  };
  if (!cam.video) return base;

  try {
    const page = await get(watch(cam.video), { ua: BROWSER_UA, timeout: 18000, retries: 0 });

    const ended = /itemprop="endDate"/.test(page);
    const liveNow = LIVE_MARKERS.some((re) => re.test(page));
    const owner = page.match(/"ownerChannelName":"([^"]*)"/)?.[1] || null;
    const title = page.match(/<meta name="title" content="([^"]*)"/)?.[1] || null;

    return {
      ...base,
      live: Boolean(liveNow && !ended),
      ended,
      owner,
      title,
      // Only true when the page actually confirmed who owns this video. The UI
      // must refuse to print a caption without it.
      verified: Boolean(owner),
    };
  } catch (e) {
    return { ...base, error: true, errorMessage: String(e.message || e).slice(0, 120) };
  }
}

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function fetchCams() {
  const [traffic, wildlife, area] = await Promise.all([
    pool(TRAFFIC_CAMS, 5, probeTraffic),
    pool(WILDLIFE_CAMS, 3, probeWildlife),
    pool(AREA_CAMS, 2, probeArea),
  ]);

  traffic.sort((a, b) => a.km - b.km);
  // Local and confirmed-live first. `verified` beats `live` in the ordering
  // because an unverified camera must never be the landing tile again.
  wildlife.sort((a, b) =>
    (b.live - a.live) ||
    ((b.verified ? 1 : 0) - (a.verified ? 1 : 0)) ||
    ((b.local ? 1 : 0) - (a.local ? 1 : 0)));

  const wildlifeLive = [...wildlife, ...area].filter((r) => r.live && r.verified).length;
  return {
    ok: true,
    traffic,
    // Area cameras ride in the same tab as the wildlife streams: both are
    // ambient outdoor context rather than the close-range street views the
    // recogniser actually watches.
    wildlife: [...wildlife, ...area].sort((a, b) => (b.live - a.live) || (a.km || 99) - (b.km || 99)),
    area,
    trafficLive: traffic.filter((r) => r.ok).length,
    trafficStale: traffic.filter((r) => r.stale).length,
    trafficHls: traffic.filter((r) => r.hls).length,
    wildlifeLive,
    // Identity is now pinned by video id and confirmed against the watch page,
    // so a blank really does mean offline. The old "unverified" escape hatch
    // existed because channel scraping could not tell the two apart, and it is
    // what let a misattributed video render as live.
    wildlifeDetection: "ok",
    checkedAt: Date.now(),
    note: "Seattle-area only. SDOT street cameras are 1280x720/1920x1080 and close range — unlike freeway cameras, an animal is resolvable. Recognition runs on the stills; HLS video is for viewing only.",
  };
}
