// Location privacy — the enforcement point for SPEC.md §6.
//
// SPEC §6 says "zone resolution only … never a street address, never a house"
// and config.PRIVACY.minZoneRadiusM = 300 puts a number on it. Until now that
// was a stated intention with nothing enforcing it: gazetteer.resolvePlaces()
// emitted `24th Ave NW & NW 70th St` with coordinates derived from a linear fit
// over the street grid, which is a ~100m fix, and extract.mjs scored that
// precision HIGHER than anything else it could find.
//
// Two real, measured inputs make that untenable:
//
//   1. Raw coordinates are being posted. r/SeattleWA 1v6l8wr, body verbatim:
//      "47.69121° N, 122.34483° W I SAW HIM HERE". Nothing in the pipeline
//      looked for these, so the text persisted to NDJSON and — because titles
//      render verbatim into /api/state — a coordinate in a title would reach
//      the page.
//
//   2. Intersections are being posted deliberately and falsely. On 2026-07-18
//      r/Seattle ran a location-flooding campaign (post 1uzk5cr, +5,358:
//      "All it takes is one person to ruin the peaceful life of Jimothy").
//      Cross-street decoys are exactly the shape this module used to reward
//      most. Neighbours protecting the animal and our own scoring function
//      were pulling in opposite directions.
//
// So: coordinates are stripped before storage or scoring, and any location
// finer than a named zone is snapped up to the zone that contains it. We keep
// the FACT that a fine-grained reference was made — it is real signal about how
// specific a claim is — but we never keep, store, or emit the point itself.

import { PRIVACY } from "../config.mjs";

/** Puget Sound bounding box. A pair outside this is not a local sighting. */
const LAT_RANGE = [46.8, 48.5];
const LON_RANGE = [-123.4, -121.5];

// Decimal degrees with an explicit hemisphere: "47.69121° N, 122.34483° W".
// The degree mark or the hemisphere letter is required — a bare pair of decimals
// is far too common in ordinary prose (prices, versions, scores) to redact.
const DMS_OR_HEMI =
  /\b(\d{1,3}(?:\.\d{2,8})?)\s*(?:°|deg\b|º)?\s*([NnSs])\s*[,;/ ]+\s*(-?\d{1,3}(?:\.\d{2,8})?)\s*(?:°|deg\b|º)?\s*([EeWw])\b/g;

// Signed decimal pair: "47.69121, -122.34483". Requires >= 3 decimal places on
// both halves, which is ~100m precision — below that it cannot identify a house.
const DECIMAL_PAIR = /(-?\d{1,3}\.\d{3,8})\s*[,;]\s*(-?\d{1,3}\.\d{3,8})/g;

// Degrees-minutes-seconds: 47°41'28"N 122°20'41"W
const DMS_FULL =
  /\b\d{1,3}\s*[°º]\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*["″]?\s*[NnSsEeWw]\b/g;

const inSound = (lat, lon) =>
  lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1] && lon >= LON_RANGE[0] && lon <= LON_RANGE[1];

/**
 * Strip anything that reads as a coordinate pair.
 *
 * Runs before scoring AND before persistence, so the raw point never lands in
 * items.ndjson either. Returns the count so the pipeline can surface "we
 * redacted N coordinates today" — that is a fact worth showing, and it is much
 * more interesting than silently dropping it.
 *
 * @param {string} text
 * @returns {{text:string, redacted:number, wasLocal:boolean}}
 */
export function redactCoordinates(text) {
  if (!text) return { text: text ?? "", redacted: 0, wasLocal: false };

  let redacted = 0;
  let wasLocal = false;
  let out = String(text);

  out = out.replace(DMS_OR_HEMI, (match, a, ns, b, ew) => {
    const lat = Number(a) * (/[Ss]/.test(ns) ? -1 : 1);
    const lon = Number(b) * (/[Ww]/.test(ew) ? -1 : 1);
    // A hemisphere-marked pair is unambiguous; redact it wherever on Earth it
    // points. Somewhere else on the planet is not our business either.
    redacted++;
    if (inSound(lat, Math.abs(lon) > 180 ? lon : lon)) wasLocal = true;
    return "[coordinates removed]";
  });

  out = out.replace(DECIMAL_PAIR, (match, a, b) => {
    const lat = Number(a);
    const lon = Number(b);
    // Only redact when it actually looks like a geographic pair — otherwise
    // "1.234, 5.678" in a table of numbers would be mangled.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return match;
    redacted++;
    if (inSound(lat, lon)) wasLocal = true;
    return "[coordinates removed]";
  });

  out = out.replace(DMS_FULL, () => {
    redacted++;
    return "[coordinates removed]";
  });

  return { text: out, redacted, wasLocal };
}

/**
 * Snap a point to the named zone containing it.
 *
 * `zones` is injected rather than imported to keep this module free of a cycle
 * with gazetteer.mjs, which imports this one.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{zone:string,lat:number,lon:number,radius:number}[]} zones
 * @returns {{zone:string, lat:number, lon:number, radius:number}}
 */
export function snapToZone(lat, lon, zones) {
  let best = null;
  let bestD = Infinity;
  for (const z of zones) {
    const d = Math.hypot((z.lat - lat) * 111_320, (z.lon - lon) * 75_000);
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  // Fall back to the widest zone rather than returning the raw point. There is
  // no code path here that may hand back an unsnapped coordinate.
  const fallback = zones.find((z) => z.zone === "Ballard (general)") || zones[zones.length - 1];
  const z = best || fallback;
  return {
    zone: z.zone,
    lat: z.lat,
    lon: z.lon,
    radius: Math.max(z.radius ?? 0, PRIVACY.minZoneRadiusM),
  };
}

/**
 * Widen an observation whose own accuracy is finer than our floor.
 *
 * iNaturalist is the case that matters. Its contributors geotag to 2–20m and
 * `obscured` is false by default, so the wildlife layer was plotting other
 * people's raccoon sightings — and therefore their gardens — at house
 * precision. The one Jimothy record on iNat is blurred to 2,953m because the
 * observer chose to protect him; we should not be less careful with everyone
 * else's records than she was with hers.
 *
 * @returns {{lat:number, lon:number, zone:string, radius:number, snapped:boolean}}
 */
export function enforceObservationPrivacy(lat, lon, zones, accuracyM = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat: null, lon: null, zone: null, radius: null, snapped: false };
  }
  if (!PRIVACY.zoneResolutionOnly) {
    return { lat, lon, zone: null, radius: accuracyM, snapped: false };
  }
  const z = snapToZone(lat, lon, zones);
  return { ...z, snapped: true };
}
