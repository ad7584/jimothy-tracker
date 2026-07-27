// The runner: schedule sources, run the pipeline, publish state.
//
//   node src/runner.mjs          continuous
//   node src/runner.mjs --once   single cycle, print a report, exit
//
// Sources are scheduled independently with jitter so we never stampede an
// upstream, and a failing source degrades to a red row in SOURCE HEALTH rather
// than taking the process down.

import * as store from "./store.mjs";
import { Server } from "./server.mjs";
import { INTERVALS, PORT, FEED_PER_PLATFORM, FEED_MAX } from "./config.mjs";
import { feedSources, readRedditComments } from "./sources/feeds.mjs";
import { mastodonSource, harvestTweetIds, hydrateTweet } from "./sources/social.mjs";
import { inaturalistSource } from "./sources/wildlife.mjs";
import { fetchWikipedia, fetchConditions, fetchCivic } from "./sources/signals.mjs";
import { extract } from "./engine/extract.mjs";
import { cluster, lastVerifiedSighting } from "./engine/corroborate.mjs";
import { ballardHeat, territory } from "./engine/heat.mjs";
import { foragingIndex, attentionIndex } from "./engine/indices.mjs";
import { platformFor, platformCounts, PLATFORM_LIST } from "./engine/platform.mjs";
import { buildStories } from "./engine/stories.mjs";
import { proximityIndex } from "./engine/proximity.mjs";
import { fetchCams } from "./sources/cams.mjs";
import { selectFrames, loadFrameSpend, getFrameSpend, framesToday, framesRemainingToday, WATCH } from "./sources/camwatch.mjs";
import { pollTape, tapeIndex, tapeStats } from "./sources/camtape.mjs";
import * as recog from "./engine/recognise.mjs";
import * as ops from "./engine/ops.mjs";

const ONCE = process.argv.includes("--once");

const ITEM_SOURCES = [...feedSources, mastodonSource, inaturalistSource];

const state = {
  startedAt: Date.now(),
  updatedAt: null,
  cycles: 0,
  sources: {},
  totals: { items: 0, jimothyMentions: 0, located: 0 },
  lastSighting: null,
  clusters: [],
  heat: [],
  zones: [],
  feed: [],
  platforms: [],
  stories: [],
  cams: null,
  recognition: [],
  vision: recog.status(),
  conditions: null,
  wiki: null,
  foraging: null,
  attention: null,
  disclaimer:
    "Chatter heat shows where people are POSTING about a place, not where Jimothy is. " +
    "Indices are models built from measured inputs. Locations are zone-resolution only.",
};

function markSource(id, ok, ms, extra = {}) {
  const prev = state.sources[id] || {};
  state.sources[id] = {
    id,
    ok,
    lastMs: ms,
    lastRun: Date.now(),
    lastOk: ok ? Date.now() : prev.lastOk || null,
    error: ok ? null : extra.error || "failed",
    n: extra.n ?? prev.n ?? 0,
    consecutiveFailures: ok ? 0 : (prev.consecutiveFailures || 0) + 1,
  };
}

async function runItemSource(src) {
  const t0 = Date.now();
  try {
    const items = await src.fetch();
    const fresh = await store.appendItems(items);
    markSource(src.id, true, Date.now() - t0, { n: items.length });
    ops.opPoll(src.id, items.length, Date.now() - t0);
    if (fresh.length) console.log(`[ingest] ${src.id}: +${fresh.length} new (${items.length} seen)`);
    return fresh;
  } catch (e) {
    markSource(src.id, false, Date.now() - t0, { error: e.message });
    ops.opWarn(`FAIL ${src.id} · ${e.message}`);
    console.warn(`[ingest] ${src.id} FAILED: ${e.message}`);
    return [];
  }
}

/** Hydrate any x.com links found in freshly ingested text. */
async function hydrateX(fresh) {
  const ids = new Set();
  for (const it of fresh) for (const id of harvestTweetIds(`${it.text} ${it.url}`)) ids.add(id);
  const out = [];
  for (const id of [...ids].slice(0, 8)) {
    try {
      const item = await hydrateTweet(id);
      if (!store.isSeen(item.id)) out.push(item);
    } catch (e) {
      if (process.env.JM_VERBOSE) console.warn(`[x] ${id}: ${e.message}`);
    }
  }
  if (out.length) {
    await store.appendItems(out);
    markSource("x", true, 0, { n: out.length });
    console.log(`[ingest] x: +${out.length} hydrated`);
  }
  return out;
}

async function runSignals() {
  const jobs = [
    ["cams", async () => (state.cams = await fetchCams())],
    ["wikipedia", async () => (state.wiki = await fetchWikipedia())],
    ["conditions", async () => (state.conditions = await fetchConditions())],
    // Waste count is folded into conditions during recompute, not here —
    // these jobs run in parallel and whichever finished last used to clobber
    // the other, which silently dropped food-availability from the index.
    ["civic", async () => (state.civic = await fetchCivic())],
  ];
  await Promise.all(jobs.map(async ([id, fn]) => {
    const t0 = Date.now();
    try {
      await fn();
      markSource(id, true, Date.now() - t0);
    } catch (e) {
      markSource(id, false, Date.now() - t0, { error: e.message });
    }
  }));
}

/** Rebuild all derived state from everything on disk. */
async function recompute() {
  // Wide window on read. iNaturalist observations are historical by nature —
  // a 21-day window silently discarded 53 of 65 of them. Each consumer below
  // applies its own time policy instead.
  const raw = await store.readItems({ sinceMs: Date.now() - 400 * 86400_000, limit: 20000 });

  // De-duplicate by link, keeping the newest row.
  //
  // items.ndjson is append-only, so rows written before the identity fix above
  // still carry their old label-derived ids and cannot be caught by the seen
  // set. Dedupe on read so history heals itself without a migration, and so a
  // future adapter that surfaces the same URL twice can never double-count it
  // into a corroboration cluster.
  const byLink = new Map();
  for (const it of raw) {
    const k = (it.url || it.id || "").replace(/^https?:\/\/(old\.|www\.|new\.)?/, "").replace(/[/?#].*$/, "") ||
              it.id;
    const key = (it.url || "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase() || it.id;
    const prev = byLink.get(key);
    if (!prev || (it.ts || it.fetchedAt || 0) > (prev.ts || prev.fetchedAt || 0)) byLink.set(key, it);
  }
  const items = [...byLink.values()];
  state.totals.items = items.length;
  state.totals.duplicatesDropped = raw.length - items.length;

  const ex0 = Date.now();
  const candidates = [];
  for (const item of items) {
    const ex = extract(item);
    if (!ex) continue;
    candidates.push({ item, ex });
  }

  // Three populations, deliberately kept apart:
  //   chatter  — people posting. Drives heat. Never a position.
  //   observed — real raccoon observations with GPS. Drives the wildlife layer.
  //   baseline — raccoons outside Ballard. Behavioural context only, never a
  //              sighting and never on the Ballard map.
  const chatter = candidates.filter((c) => c.item.origin !== "wildlife");
  const observed = candidates.filter((c) => c.item.origin === "wildlife" && !c.item.meta?.baseline && c.item.meta?.lat);
  const baseline = candidates.filter((c) => c.item.origin === "wildlife" && c.item.meta?.baseline);

  ops.opExtract(items.length, chatter.filter((c) => c.ex.places?.length).length, Date.now() - ex0);
  // One line per DISTINCT zone, specific before generic — four identical
  // "Ballard (general)" lines a pass is noise, not telemetry.
  const geoSeen = new Set();
  for (const c of chatter.filter((x) => x.ex.places?.length)
    .sort((a, b) => (a.ex.places[0].precision === "area" ? 1 : 0) - (b.ex.places[0].precision === "area" ? 1 : 0))) {
    const p = c.ex.places[0];
    if (geoSeen.has(p.zone)) continue;
    geoSeen.add(p.zone);
    ops.opGeo(p.zone, p.precision, p.matched);
    if (geoSeen.size >= 4) break;
  }
  state.totals.jimothyMentions = chatter.length;
  state.totals.located = chatter.filter((c) => c.ex.places?.length).length;
  state.totals.observations = observed.length;
  state.totals.baseline = baseline.length;

  // Deepen the most promising forum posts by reading their comments, where
  // cross-streets actually appear. Bounded — each costs a serialised call.
  const deepen = candidates
    .filter((c) => c.item.origin === "forum" && c.ex.isSightingClaim && !c.ex.places?.length && !c.deepened)
    .sort((a, b) => (b.item.ts || 0) - (a.item.ts || 0))
    .slice(0, 3);
  // Read what is already cached; a miss warms in the background and lands on
  // the next pass. Never awaited — see readRedditComments for the measurement.
  for (const c of deepen) {
    const comments = readRedditComments(c.item.url);
    if (comments) {
      const re = extract(c.item, comments);
      if (re) { c.ex = re; c.deepened = true; }
    }
  }

  // Record every camera, ALWAYS.
  //
  // The tape feeds the camera wall and the time-lapse scrubber — both pure
  // viewing features. It used to live inside the `recog.enabled` block, so
  // without a vision API key nothing was ever recorded: the wall had no
  // thumbnails, the scrubber never appeared, and /api/camtape served an empty
  // index. Recording is cheap (conditional GET, most polls return 304) and has
  // nothing to do with whether we can afford to score anything.
  let freshFrames = [];
  try {
    const tape = await pollTape(state.cams?.traffic || []);
    freshFrames = tape.fresh || [];
    state.camTape = tapeIndex();
    state.tapeStats = tapeStats();
  } catch (e) {
    console.warn(`[camtape] ${e.message}`);
  }

  // Recognition on the highest-value images first: wildlife observations carry
  // GPS, so a hit there is a located event.
  if (recog.enabled) {
    // Observed-with-GPS first: a hit there is a located, dated event. Baseline
    // observations are excluded entirely — scoring raccoons 8km away burns
    // tokens for nothing.
    const queue = [...observed, ...chatter]
      .filter((c) => c.ex.needsRecognition)
      .slice(0, 6);
    // The cache is persisted, so an image is never paid for twice — not across
    // cycles and not across restarts.
    const done = new Set(state.recognition.map((r) => r.imageUrl));
    let scoredThisCycle = 0;
    for (const c of queue) {
      for (const url of (c.item.images || []).slice(0, 2)) {
        if (done.has(url)) continue;
        if (recog.remainingToday() <= 0) break;
        const r = await recog.recogniseImage(url);
        r.itemUrl = c.item.url;
        r.itemSource = c.item.source;
        r.zone = c.ex.places?.[0]?.zone || null;
        state.recognition.unshift(r);
        done.add(url);
        scoredThisCycle++;
        c.recognition = [...(c.recognition || []), r];
      }
    }
    // Live street-camera frames go through the SAME recognition queue as the
    // photo sources — one filter, one place to read the results. Everything
    // expensive is gated upstream in camwatch: conditional GET, size delta and
    // the nocturnal window, so most cycles cost nothing at all.
    try {
      const watch = selectFrames(freshFrames, state.conditions, state.cams?.traffic || []);
      state.camWatch = {
        night: watch.night,
        checked: watch.checked,
        watching: watch.watching || [],
        skipped: watch.skipped,
        framesToday: framesToday(),
        framesRemaining: framesRemainingToday(),
        maxCameras: WATCH.maxCameras,
      };
      for (const f of watch.frames) {
        const r = await recog.recogniseFrame(f);
        r.itemSource = `SDOT · ${f.camName}`;
        r.zone = null;
        state.recognition.unshift(r);
        scoredThisCycle++;
        if (r.status === "CONSISTENT_WITH_JIMOTHY") {
          ops.opHit(`*** CAMERA HIT ${f.camName} — ${r.reasoning}`, { camName: f.camName });
          console.log(`[!] CAMERA HIT: ${f.camName} — ${r.reasoning}`);
        }
      }
      if (watch.frames.length) console.log(`[camwatch] scored ${watch.frames.length} frame(s)`);
    } catch (e) {
      console.warn(`[camwatch] ${e.message}`);
    }

    state.recognition = state.recognition.slice(0, 500);
    state.visionSpend = { usedToday: recog.usedToday(), remainingToday: recog.remainingToday() };
    if (scoredThisCycle) await store.saveRecognition(state.recognition, recog.getSpend(), getFrameSpend());
  } else {
    state.vision = recog.status();
  }

  // Clusters may include real Ballard observations, never the wider baseline.
  state.clusters = cluster([...chatter, ...observed]);
  state.lastSighting = lastVerifiedSighting(state.clusters);
  ops.opCorr(state.clusters.length, state.clusters.filter((c) => c.band === "CONFIRMED" || c.band === "PROBABLE").length);
  // Heat is posting density only — wildlife GPS points are a separate layer so
  // an observation can never be misread as chatter, or chatter as a position.
  state.heat = ballardHeat(chatter);

  state.wildlife = observed
    .map((c) => ({
      lat: c.item.meta.lat,
      lon: c.item.meta.lon,
      zone: c.item.meta.zone,
      ts: c.item.ts,
      url: c.item.url,
      quality: c.item.meta.qualityGrade,
      image: (c.item.images || [])[0] || null,
      recognition: (c.recognition || [])[0] || null,
    }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 200);

  // Territory needs wildlife and waste together, so it is built here rather
  // than inside the signal fetchers.
  state.zones = territory(state.heat, state.wildlife, state.civic?.waste || []);
  if (state.conditions) state.conditions.wasteCount = state.civic?.waste?.length ?? null;

  const now = Date.now();
  const in24 = chatter.filter((c) => (c.item.ts || c.item.fetchedAt) > now - 86400_000).length;
  const prev24 = chatter.filter((c) => {
    const t = c.item.ts || c.item.fetchedAt;
    return t <= now - 86400_000 && t > now - 172800_000;
  }).length;

  state.attention = attentionIndex(state.wiki, in24, prev24);
  state.foraging = foragingIndex(state.conditions);

  // Fair share, not pure recency. News outnumbers everything ~5:1 and is always
  // fresher, so a straight recency slice consumed the whole feed and left every
  // other platform's filter chip reading zero. Each platform gets a floor.
  const perPlatform = new Map();
  state.feed = [...chatter, ...observed]
    .sort((a, b) => (b.item.ts || b.item.fetchedAt) - (a.item.ts || a.item.fetchedAt))
    .filter((c) => {
      const k = platformFor(c.item).key;
      const n = perPlatform.get(k) || 0;
      if (n >= FEED_PER_PLATFORM) return false;
      perPlatform.set(k, n + 1);
      return true;
    })
    .slice(0, FEED_MAX)
    .map((c) => ({
      title: c.item.title,
      url: c.item.url,
      source: c.item.source,
      origin: c.item.origin,
      platform: platformFor(c.item).key,
      ts: c.item.ts,
      score: Number(c.ex.score.toFixed(3)),
      band: c.ex.band,
      zone: c.ex.places?.[0]?.zone || null,
      why: c.ex.why,
      images: (c.item.images || []).slice(0, 1),
    }));

  state.platforms = PLATFORM_LIST.map((p) => ({ ...p, count: platformCounts(state.feed)[p.key] || 0 }));
  state.stories = buildStories(state.feed, state);
  state.proximity = proximityIndex(state);
  ops.opIndex("proximity", state.proximity.score, state.proximity.verdict?.slice(0, 44) || "");
  ops.opIndex("attention", state.attention.score);
  ops.opIndex("foraging", state.foraging.score);

  state.ops = ops.stats();
  state.updatedAt = Date.now();
  state.cycles++;
}

// --- Scheduling -----------------------------------------------------------
function schedule(fn, intervalMs, label) {
  const jitter = () => intervalMs * (0.85 + Math.random() * 0.3);
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      console.warn(`[sched] ${label}: ${e.message}`);
    }
    setTimeout(tick, jitter());
  };
  setTimeout(tick, Math.random() * 5000);
}

async function fullCycle() {
  const fresh = [];
  for (const src of ITEM_SOURCES) fresh.push(...(await runItemSource(src)));
  await hydrateX(fresh);
  await runSignals();
  await recompute();
  await store.saveState(state);
}

function report() {
  const s = state;
  const line = "─".repeat(74);
  console.log(`\n${line}\n  JIMOTHY TRACKER — cycle ${s.cycles}  ${new Date().toISOString()}\n${line}`);
  console.log("\n  SOURCE HEALTH");
  for (const k of Object.keys(s.sources).sort()) {
    const v = s.sources[k];
    console.log(`    ${v.ok ? "OK  " : "FAIL"}  ${k.padEnd(14)} ${String(v.lastMs).padStart(5)}ms  n=${String(v.n).padStart(4)}  ${v.error || ""}`);
  }
  console.log(`\n  INGEST     ${s.totals.items} items · ${s.totals.jimothyMentions} mention Jimothy · ${s.totals.located} located`);
  console.log(`             ${s.totals.observations} Ballard raccoon observations (GPS) · ${s.totals.baseline} baseline`);
  console.log(`  INDICES    attention ${s.attention?.score ?? "?"}/100 · foraging ${s.foraging?.score ?? "?"}/100`);
  console.log("\n  TERRITORY (model — obs 55% · food 30% · chatter 15%)");
  for (const z of s.zones.slice(0, 8)) {
    const bar = "█".repeat(Math.round(z.score * 24)).padEnd(24, "·");
    console.log(`    ${bar} ${z.score.toFixed(2)}  ${z.zone.padEnd(18)} obs=${z.observations} food=${z.foodReports} chat=${z.chatter}`);
  }
  console.log("\n  SEATTLE CAMERAS");
  console.log(`    ${s.cams?.trafficLive ?? 0}/${s.cams?.traffic?.length ?? 0} SDOT street cams serving` +
    ` · ${s.cams?.wildlifeLive ?? 0}/${s.cams?.wildlife?.length ?? 0} WA wildlife streams live`);
  for (const c of (s.cams?.traffic || []).slice(0, 4)) {
    console.log(`    ${c.ok ? "OK  " : "DOWN"}  ${c.km.toFixed(2)}km  ${c.name}`);
  }
  const ls = s.lastSighting;
  console.log("\n  LAST VERIFIED SIGHTING");
  console.log(ls?.found
    ? `    ${ls.band} · ${ls.zone} · ${(ls.ageMs / 3.6e6).toFixed(1)}h ago · ${ls.originCount} independent origins`
    : `    ${ls?.note || "none"}`);
  console.log(`\n  VISION     ${s.vision.enabled ? `${s.vision.provider} · ${s.vision.idModel}` : "disabled (no API key) — images queued UNSCORED"}`);
  if (s.camWatch) {
    const w = s.camWatch;
    console.log(`  CAM WATCH  ${w.night ? "night — active" : "daylight — sleeping"} · ${w.checked} cams` +
      ` · ${w.framesToday} frames scored today (${w.framesRemaining} left)` +
      ` · skipped ${w.skipped.notModified} unchanged / ${w.skipped.static} static`);
  }
  console.log(`${line}\n`);
}

// --- Boot -----------------------------------------------------------------
await store.init();
const cached = await store.loadRecognition();
state.recognition = cached.results;
recog.loadSpend(cached.spend);
loadFrameSpend(cached.frameSpend);
console.log(`[boot] Jimothy Tracker · vision=${recog.enabled ? recog.provider : "off"}` +
  ` · ${cached.results.length} images already scored (cached, never re-charged)`);

if (ONCE) {
  await fullCycle();
  report();
  process.exit(0);
}

const server = new Server(() => state);
server.listen(PORT);

await fullCycle();
report();
server.publish(state);

for (const src of ITEM_SOURCES) {
  const iv = INTERVALS[src.id] ?? INTERVALS.news;
  schedule(async () => {
    const fresh = await runItemSource(src);
    await hydrateX(fresh);
    await recompute();
    await store.saveState(state);
    server.publish(state);
  }, iv, src.id);
}

schedule(async () => {
  await runSignals();
  await recompute();
  server.publish(state);
}, INTERVALS.signals, "signals");

process.on("SIGINT", async () => {
  console.log("\n[shutdown] saving state…");
  await store.saveState(state);
  process.exit(0);
});
