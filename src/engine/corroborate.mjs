// Corroboration: cluster candidates in space and time, then promote a cluster
// according to how many INDEPENDENT origin types back it.
//
// World Monitor fires a breaking banner only when five independent origin types
// agree. Our origin diversity is smaller (news, forum, fediverse, hyperlocal,
// social, wildlife), so the ladder is scaled — but the principle is the same:
// one loud source is not evidence.

import { haversine } from "../util/text.mjs";
import { CORROBORATION } from "../config.mjs";

const SPACE_M = 700;
const TIME_MS = 12 * 3600_000;

/**
 * @param {Array<{item:object, ex:object}>} candidates
 * @returns {Array} clusters, most recent first
 */
export function cluster(candidates) {
  const located = candidates.filter((c) => c.ex.places?.length);
  const clusters = [];

  for (const c of located) {
    const p = c.ex.places[0];
    const ts = c.item.ts || c.item.fetchedAt;
    let target = null;

    for (const cl of clusters) {
      const near = haversine({ lat: cl.lat, lon: cl.lon }, { lat: p.lat, lon: p.lon }) <= SPACE_M;
      const recent = Math.abs(cl.ts - ts) <= TIME_MS;
      if (near && recent) { target = cl; break; }
    }

    if (!target) {
      target = {
        id: `cl_${p.zone.replace(/\W+/g, "-").toLowerCase()}_${Math.round(ts / TIME_MS)}`,
        zone: p.zone, lat: p.lat, lon: p.lon, ts,
        precision: p.precision,
        members: [], origins: new Set(), sources: new Set(),
      };
      clusters.push(target);
    }

    target.members.push(c);
    target.origins.add(c.item.origin);
    target.sources.add(c.item.source);
    // A cluster carries the timestamp of its most recent member, and upgrades
    // to the finest precision any member offered.
    target.ts = Math.max(target.ts, ts);
    if (p.precision === "street" && target.precision === "area") {
      target.precision = "grid";
      target.zone = p.zone;
      target.lat = p.lat;
      target.lon = p.lon;
    }
  }

  return clusters
    .map((cl) => {
      // Independence check for hydrate-by-id members (TikTok, X). The recent
      // sightings travelled TikTok → X → Reddit as ONE person's claim wearing
      // three hats — and our own harvester ingests exactly that chain. If a
      // member's platform id appears inside another member's text or URL, the
      // cited member arrived via that referrer and is bridged, not
      // independent: it contributes its content but not a second origin.
      const bridged = new Set();
      for (const m of cl.members) {
        const key = m.item.meta?.tiktokId || m.item.meta?.tweetId;
        if (!key) continue;
        if (cl.members.some((o) => o !== m &&
          `${o.item.text || ""} ${o.item.url || ""}`.includes(key))) {
          bridged.add(m);
        }
      }
      const origins = new Set();
      for (const m of cl.members) if (!bridged.has(m)) origins.add(m.item.origin);
      // Bridging discounts, never erases — the members are still real posts.
      if (!origins.size) for (const m of cl.members) origins.add(m.item.origin);

      const originCount = origins.size;
      const best = Math.max(...cl.members.map((m) => m.ex.score));
      // Independent corroboration outranks any single item's text score.
      let band = "UNVERIFIED";
      if (originCount >= CORROBORATION.confirmed && best >= 0.45) band = "CONFIRMED";
      else if (originCount >= CORROBORATION.probable && best >= 0.35) band = "PROBABLE";
      else if (best >= 0.55) band = "PROBABLE";

      // A recognition hit is strong independent evidence in its own right.
      const recog = cl.members
        .flatMap((m) => m.recognition || [])
        .filter((r) => r?.status === "CONSISTENT_WITH_JIMOTHY");
      if (recog.length && band === "UNVERIFIED") band = "PROBABLE";
      if (recog.length && originCount >= CORROBORATION.probable) band = "CONFIRMED";

      return {
        id: cl.id,
        zone: cl.zone,
        lat: cl.lat,
        lon: cl.lon,
        ts: cl.ts,
        precision: cl.precision,
        band,
        topScore: Number(best.toFixed(3)),
        originCount,
        origins: [...origins],
        sources: [...cl.sources],
        recognitionHits: recog.length,
        members: cl.members.map((m) => ({
          title: m.item.title,
          url: m.item.url,
          source: m.item.source,
          origin: m.item.origin,
          ts: m.item.ts,
          score: Number(m.ex.score.toFixed(3)),
          why: m.ex.why,
        })),
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

/** The hero number: most recent cluster at PROBABLE or better. */
export function lastVerifiedSighting(clusters) {
  const good = clusters.filter((c) => c.band === "CONFIRMED" || c.band === "PROBABLE");
  if (!good.length) return { found: false, note: "No sighting has reached PROBABLE. Position unknown." };
  const c = good[0];
  return {
    found: true,
    zone: c.zone,
    band: c.band,
    ts: c.ts,
    ageMs: Date.now() - c.ts,
    originCount: c.originCount,
    clusterId: c.id,
  };
}
