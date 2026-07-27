// Chatter heat.
//
// CRITICAL DISTINCTION, enforced by the data shape itself: heat is where people
// are POSTING ABOUT a place, not where Jimothy is. Heat blooms and verified
// sightings are separate arrays and render differently. Nothing in here may be
// presented as a position.

import { ZONES } from "./gazetteer.mjs";
import { HEAT_HALFLIFE_H } from "../config.mjs";

const decay = (ageH) => Math.pow(0.5, ageH / HEAT_HALFLIFE_H);

/** Time-decayed posting density per Ballard zone. */
export function ballardHeat(candidates, now = Date.now()) {
  const buckets = new Map();

  for (const c of candidates) {
    for (const p of c.ex.places || []) {
      const ageH = (now - (c.item.ts || c.item.fetchedAt)) / 3600_000;
      if (ageH > 14 * 24) continue;
      const w = decay(Math.max(0, ageH));
      const key = p.zone;
      if (!buckets.has(key)) {
        buckets.set(key, {
          zone: key, lat: p.lat, lon: p.lon, precision: p.precision,
          weight: 0, mentions: 0, origins: new Set(), items: [],
        });
      }
      const b = buckets.get(key);
      b.weight += w;
      b.mentions += 1;
      b.origins.add(c.item.origin);
      if (b.items.length < 12) {
        b.items.push({ title: c.item.title, url: c.item.url, source: c.item.source, ts: c.item.ts });
      }
    }
  }

  const rows = [...buckets.values()];
  const maxW = Math.max(1e-6, ...rows.map((r) => r.weight));
  return rows
    .map((r) => ({
      zone: r.zone, lat: r.lat, lon: r.lon, precision: r.precision,
      intensity: Number((r.weight / maxW).toFixed(3)),
      mentions: r.mentions,
      origins: [...r.origins],
      items: r.items.sort((a, b) => (b.ts || 0) - (a.ts || 0)),
      kind: "chatter",
      note: "Posting density about this place. NOT a position for Jimothy.",
    }))
    .sort((a, b) => b.intensity - a.intensity);
}

/**
 * Territory table — the Ballard equivalent of World Monitor's chokepoint panel.
 *
 * Combines three genuinely independent measured inputs per zone:
 *   observations — real raccoon GPS fixes from iNaturalist (any individual)
 *   food         — 311 waste/dumping reports, a real proxy for foraging value
 *   chatter      — posting density mentioning the zone
 *
 * The composite is a MODEL and is labelled as one everywhere it appears. It
 * estimates where a Ballard raccoon is likely to be — not where Jimothy is.
 */
export function territory(heat, wildlife = [], waste = []) {
  const byZone = new Map(heat.map((h) => [h.zone, h]));

  const obsByZone = new Map();
  for (const w of wildlife) {
    if (!w.zone) continue;
    obsByZone.set(w.zone, (obsByZone.get(w.zone) || 0) + 1);
  }

  // Attribute each waste report to its nearest zone centroid.
  const wasteByZone = new Map();
  for (const p of waste) {
    let best = null, bestD = Infinity;
    for (const z of ZONES) {
      if (z.zone === "Ballard (general)") continue;
      const d = Math.hypot((z.lat - p.lat) * 111_320, (z.lon - p.lon) * 75_000);
      if (d < bestD) { bestD = d; best = z; }
    }
    if (best && bestD <= 900) wasteByZone.set(best.zone, (wasteByZone.get(best.zone) || 0) + 1);
  }

  const maxObs = Math.max(1, ...obsByZone.values());
  const maxWaste = Math.max(1, ...wasteByZone.values());

  return ZONES.filter((z) => z.zone !== "Ballard (general)")
    .map((z) => {
      const h = byZone.get(z.zone);
      const obs = obsByZone.get(z.zone) || 0;
      const food = wasteByZone.get(z.zone) || 0;
      const chat = h?.intensity ?? 0;
      // Observations dominate: they are the only input that is an actual
      // raccoon, in that place, on a date.
      const score = 0.55 * (obs / maxObs) + 0.30 * (food / maxWaste) + 0.15 * chat;
      return {
        zone: z.zone, lat: z.lat, lon: z.lon, radius: z.radius,
        observations: obs,
        foodReports: food,
        chatter: h?.mentions ?? 0,
        chatterIntensity: chat,
        score: Number(score.toFixed(3)),
        isModel: true,
      };
    })
    .sort((a, b) => b.score - a.score);
}

// --- World heat -----------------------------------------------------------
// Outlet and instance geography. Anything unmatched is reported as UNKNOWN
// rather than guessed into a country.
const OUTLET_GEO = [
  [/komonews|kiro7|fox13seattle|seattletimes|mynorthwest|geekwire|king5|kuow|myballard|thestranger/i, { cc: "US", city: "Seattle", lat: 47.6062, lon: -122.3321 }],
  [/nytimes|nypost|wsj|abcnews|nbcnews|cbsnews|people\.com|eonline|yahoo|aol|newsweek|usatoday|buzzfeed|huffpost|axios|thehill/i, { cc: "US", city: "New York", lat: 40.7128, lon: -74.0060 }],
  [/washingtonpost|npr|politico/i, { cc: "US", city: "Washington DC", lat: 38.9072, lon: -77.0369 }],
  [/latimes|variety|hollywoodreporter|tmz/i, { cc: "US", city: "Los Angeles", lat: 34.0522, lon: -118.2437 }],
  [/bbc|guardian|independent|telegraph|dailymail|metro\.co\.uk|mirror|thesun|sky\s?news|ladbible|unilad/i, { cc: "GB", city: "London", lat: 51.5074, lon: -0.1278 }],
  [/cbc|ctvnews|globalnews|torontosun|nationalpost/i, { cc: "CA", city: "Toronto", lat: 43.6532, lon: -79.3832 }],
  [/abc\.net\.au|news\.com\.au|smh\.com\.au|9news|7news/i, { cc: "AU", city: "Sydney", lat: -33.8688, lon: 151.2093 }],
  [/timesofindia|ndtv|hindustantimes|indianexpress|india\.com|firstpost/i, { cc: "IN", city: "New Delhi", lat: 28.6139, lon: 77.2090 }],
  [/dw\.com|spiegel|bild|welt|faz\.net/i, { cc: "DE", city: "Berlin", lat: 52.52, lon: 13.405 }],
  [/lemonde|lefigaro|france24|bfmtv/i, { cc: "FR", city: "Paris", lat: 48.8566, lon: 2.3522 }],
  [/wyborcza|onet|interia|wp\.pl|tvn24/i, { cc: "PL", city: "Warsaw", lat: 52.2297, lon: 21.0122 }],
  [/\.ru\b|rt\.com|lenta|ria\.ru/i, { cc: "RU", city: "Moscow", lat: 55.7558, lon: 37.6173 }],
  [/japantimes|nhk|asahi/i, { cc: "JP", city: "Tokyo", lat: 35.6762, lon: 139.6503 }],
  [/scmp|straitstimes|channelnewsasia/i, { cc: "SG", city: "Singapore", lat: 1.3521, lon: 103.8198 }],
  [/globo|folha|uol/i, { cc: "BR", city: "São Paulo", lat: -23.5505, lon: -46.6333 }],
];

const INSTANCE_GEO = [
  [/pdx\.social/i, { cc: "US", city: "Portland", lat: 45.5152, lon: -122.6784 }],
  [/(^|\.)sfba\.social/i, { cc: "US", city: "San Francisco", lat: 37.7749, lon: -122.4194 }],
  [/vivaldi\.net/i, { cc: "NO", city: "Oslo", lat: 59.9139, lon: 10.7522 }],
  [/\.de$|troet|chaos\.social/i, { cc: "DE", city: "Germany", lat: 51.1657, lon: 10.4515 }],
  [/\.nl$|mastodon\.nl/i, { cc: "NL", city: "Netherlands", lat: 52.1326, lon: 5.2913 }],
  [/\.fr$|piaille/i, { cc: "FR", city: "France", lat: 46.6034, lon: 1.8883 }],
  [/\.uk$|mstdn\.social/i, { cc: "GB", city: "United Kingdom", lat: 55.3781, lon: -3.436 }],
  [/\.ca$/i, { cc: "CA", city: "Canada", lat: 56.1304, lon: -106.3468 }],
  [/\.au$|aus\.social/i, { cc: "AU", city: "Australia", lat: -25.2744, lon: 133.7751 }],
  [/\.jp$|mstdn\.jp|pawoo/i, { cc: "JP", city: "Japan", lat: 36.2048, lon: 138.2529 }],
];

// Second pass for the long tail. Google News syndicates to hundreds of small
// outlets, and the named list above only caught about a third of them; the rest
// were being dropped as "unattributed". A country-code TLD is weak evidence but
// it is real evidence, so it is used only after the named list misses.
const TLD_GEO = [
  [/\.co\.uk\b|\.uk\b/i, { cc: "GB", city: "United Kingdom", lat: 54.0, lon: -2.5 }],
  [/\.ca\b/i, { cc: "CA", city: "Canada", lat: 56.13, lon: -106.35 }],
  [/\.com\.au\b|\.au\b/i, { cc: "AU", city: "Australia", lat: -25.27, lon: 133.78 }],
  [/\.co\.nz\b|\.nz\b/i, { cc: "NZ", city: "New Zealand", lat: -40.9, lon: 174.9 }],
  [/\.in\b|\.co\.in\b/i, { cc: "IN", city: "India", lat: 22.0, lon: 79.0 }],
  [/\.ie\b/i, { cc: "IE", city: "Ireland", lat: 53.4, lon: -8.2 }],
  [/\.de\b/i, { cc: "DE", city: "Germany", lat: 51.17, lon: 10.45 }],
  [/\.fr\b/i, { cc: "FR", city: "France", lat: 46.6, lon: 1.89 }],
  [/\.es\b/i, { cc: "ES", city: "Spain", lat: 40.0, lon: -3.7 }],
  [/\.it\b/i, { cc: "IT", city: "Italy", lat: 42.8, lon: 12.5 }],
  [/\.nl\b/i, { cc: "NL", city: "Netherlands", lat: 52.13, lon: 5.29 }],
  [/\.pl\b/i, { cc: "PL", city: "Poland", lat: 52.0, lon: 19.5 }],
  [/\.se\b/i, { cc: "SE", city: "Sweden", lat: 62.0, lon: 15.0 }],
  [/\.no\b/i, { cc: "NO", city: "Norway", lat: 62.0, lon: 10.0 }],
  [/\.br\b|\.com\.br\b/i, { cc: "BR", city: "Brazil", lat: -14.2, lon: -51.9 }],
  [/\.mx\b|\.com\.mx\b/i, { cc: "MX", city: "Mexico", lat: 23.6, lon: -102.5 }],
  [/\.jp\b|\.co\.jp\b/i, { cc: "JP", city: "Japan", lat: 36.2, lon: 138.25 }],
  [/\.kr\b|\.co\.kr\b/i, { cc: "KR", city: "South Korea", lat: 36.5, lon: 127.9 }],
  [/\.ph\b/i, { cc: "PH", city: "Philippines", lat: 12.9, lon: 121.8 }],
  [/\.sg\b/i, { cc: "SG", city: "Singapore", lat: 1.35, lon: 103.82 }],
  [/\.za\b|\.co\.za\b/i, { cc: "ZA", city: "South Africa", lat: -30.6, lon: 22.9 }],
];

// A generic .com news outlet we could not name is still overwhelmingly US —
// but we place it on a neutral US centroid and label it as inferred rather than
// pretending to know the newsroom.
const US_FALLBACK = { cc: "US", city: "United States (inferred)", lat: 39.83, lon: -98.58, inferred: true };

const WIKI_REGION_GEO = {
  en: { cc: "US", city: "English Wikipedia", lat: 39.8283, lon: -98.5795 },
  pl: { cc: "PL", city: "Polish Wikipedia", lat: 52.2297, lon: 21.0122 },
  ru: { cc: "RU", city: "Russian Wikipedia", lat: 55.7558, lon: 37.6173 },
  tok: { cc: "ZZ", city: "Toki Pona Wikipedia", lat: 0, lon: 0 },
};

function geoForItem(item) {
  if (item.origin === "fediverse") {
    const host = item.meta?.instance || "";
    for (const [re, g] of INSTANCE_GEO) if (re.test(host)) return g;
    return null;
  }
  // iNaturalist and hyperlocal items are, by construction, Seattle.
  if (item.origin === "wildlife" || item.origin === "hyperlocal") {
    return { cc: "US", city: "Seattle", lat: 47.6062, lon: -122.3321 };
  }
  // The outlet name is the reliable signal for news; the Google News URL is a
  // redirect and carries no publisher information at all.
  const hay = `${item.meta?.outlet || ""} ${item.source || ""} ${item.url || ""}`;
  for (const [re, g] of OUTLET_GEO) if (re.test(hay)) return g;
  for (const [re, g] of TLD_GEO) if (re.test(hay)) return g;
  // Only news gets the inferred-US fallback; anything else stays unattributed.
  if (item.origin === "news" && item.meta?.outlet) return US_FALLBACK;
  return null;
}

/**
 * Where in the world Jimothy intel is being generated.
 * Unmatched sources are counted honestly under UNKNOWN rather than assigned.
 */
export function worldHeat(items, wiki, now = Date.now()) {
  const buckets = new Map();
  let unknown = 0;

  const add = (g, weight, label, url) => {
    const key = `${g.cc}:${g.city}`;
    if (!buckets.has(key)) {
      buckets.set(key, { cc: g.cc, city: g.city, lat: g.lat, lon: g.lon,
        inferred: Boolean(g.inferred), weight: 0, count: 0, examples: [] });
    }
    const b = buckets.get(key);
    b.weight += weight;
    b.count += 1;
    if (b.examples.length < 6 && label) b.examples.push({ label, url });
  };

  for (const it of items) {
    const g = geoForItem(it);
    if (!g) { unknown++; continue; }
    const ageH = Math.max(0, (now - (it.ts || it.fetchedAt)) / 3600_000);
    if (ageH > 14 * 24) continue;
    add(g, decay(ageH), it.title?.slice(0, 80), it.url);
  }

  // Wikipedia language editions are a real, independent global-spread signal.
  for (const l of wiki?.langs || []) {
    const g = WIKI_REGION_GEO[l.lang];
    if (!g) continue;
    add(g, Math.log10(Math.max(10, l.latest)) , `${l.lang}.wikipedia — ${l.latest.toLocaleString()} views/day`, l.url);
  }

  const rows = [...buckets.values()];
  // Inferred rows are excluded from the intensity scale AND from the map: a
  // couple of hundred unidentified outlets on a country centroid is one giant
  // bloom over Kansas that means nothing and drowns every real origin. The
  // count is still reported — as a count, which is all we actually know.
  const located = rows.filter((r) => !r.inferred);
  const maxW = Math.max(1e-6, ...located.map((r) => r.weight));
  const inferredCount = rows.filter((r) => r.inferred).reduce((a, r) => a + r.count, 0);

  return {
    rows: located
      .map((r) => ({ ...r, intensity: Number((r.weight / maxW).toFixed(3)) }))
      .sort((a, b) => b.intensity - a.intensity),
    unattributed: unknown,
    inferredUS: inferredCount,
    note: "Origin of intel, not location of Jimothy.",
  };
}
