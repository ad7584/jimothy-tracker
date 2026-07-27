// Ballard place resolution.
//
// Two mechanisms, because they catch different things:
//   1. Named landmarks — coordinates verified against Nominatim on 2026-07-26.
//   2. The street grid — Ballard is numbered (NW 65th St, 24th Ave NW), and
//      during recon the landmark list alone resolved only generic "Ballard".
//      The grid is where specific sightings actually live.

import { BALLARD } from "../config.mjs";
import { snapToZone, redactCoordinates } from "./privacy.mjs";

/** @type {{zone:string, lat:number, lon:number, radius:number, aliases:string[]}[]} */
export const ZONES = [
  { zone: "Ballard Locks",     lat: 47.6660, lon: -122.3978, radius: 400,
    aliases: ["ballard locks", "chittenden locks", "the locks", "fish ladder", "carl english garden"] },
  { zone: "Golden Gardens",    lat: 47.6922, lon: -122.4030, radius: 500,
    aliases: ["golden gardens"] },
  { zone: "Ballard Commons",   lat: 47.6706, lon: -122.3855, radius: 300,
    aliases: ["ballard commons", "the commons", "ballard library"] },
  { zone: "Bergen Place",      lat: 47.6684, lon: -122.3845, radius: 300,
    aliases: ["bergen place"] },
  { zone: "Shilshole",         lat: 47.6826, lon: -122.4059, radius: 600,
    aliases: ["shilshole", "shilshole bay", "eddie vine"] },
  { zone: "Ballard Bridge",    lat: 47.6589, lon: -122.3762, radius: 350,
    aliases: ["ballard bridge"] },
  { zone: "Ballard High",      lat: 47.6768, lon: -122.3745, radius: 350,
    aliases: ["ballard high"] },
  { zone: "Gilman Playground", lat: 47.6675, lon: -122.3697, radius: 300,
    aliases: ["gilman playground", "gilman park"] },
  { zone: "Ballard Ave",       lat: 47.6664, lon: -122.3846, radius: 300,
    aliases: ["ballard ave", "ballard avenue", "farmers market", "historic ballard"] },
  { zone: "NW Market St",      lat: 47.6686, lon: -122.3846, radius: 400,
    aliases: ["market st", "market street", "nw market"] },
  { zone: "Sunset Hill",       lat: 47.6790, lon: -122.4010, radius: 500,
    aliases: ["sunset hill"] },
  { zone: "Loyal Heights",     lat: 47.6840, lon: -122.3900, radius: 600,
    aliases: ["loyal heights"] },
  { zone: "Whittier Heights",  lat: 47.6820, lon: -122.3760, radius: 500,
    aliases: ["whittier heights"] },
  { zone: "Salmon Bay",        lat: 47.6640, lon: -122.3860, radius: 400,
    aliases: ["salmon bay"] },
  { zone: "West Woodland",     lat: 47.6680, lon: -122.3690, radius: 500,
    aliases: ["west woodland"] },
  { zone: "Adams",             lat: 47.6720, lon: -122.3930, radius: 500,
    aliases: ["adams neighborhood"] },
  { zone: "Ballard (general)", lat: BALLARD.lat, lon: BALLARD.lon, radius: 1200,
    aliases: ["ballard"] },
];

// The grid. Ballard's avenues run NW and its streets run NW; both are numbered.
// Bounds below keep us from matching Seattle addresses in other neighbourhoods.
const AVE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+ave(?:nue)?\s*n\.?w\.?\b/gi;
const ST_RE = /\bn\.?w\.?\s+(\d{2,3})(?:st|nd|rd|th)?\s+st(?:reet)?\b/gi;

// Ballard's numbered grid, roughly: 8th–36th Ave NW, NW 43rd–NW 90th St.
const AVE_MIN = 8, AVE_MAX = 36;
const ST_MIN = 43, ST_MAX = 90;

// Linear fits over the real grid. Anchors: 15th Ave NW ~ -122.3765,
// 24th Ave NW ~ -122.3880; NW 45th ~ 47.6615, NW 85th ~ 47.6905.
const aveToLon = (n) => -122.3765 - (n - 15) * 0.001278;
const stToLat = (n) => 47.6615 + (n - 45) * 0.000725;

/**
 * Resolve every place reference in a blob of text.
 * @returns {{zone:string, lat:number, lon:number, precision:"grid"|"landmark"|"area", matched:string}[]}
 */
export function resolvePlaces(text) {
  const t = (text || "").toLowerCase();
  const out = [];
  const seen = new Set();

  // Grid first — it is more specific than a landmark name, so it wins.
  const aves = [];
  const sts = [];
  let m;
  AVE_RE.lastIndex = 0;
  while ((m = AVE_RE.exec(t))) {
    const n = Number(m[1]);
    if (n >= AVE_MIN && n <= AVE_MAX) aves.push({ n, raw: m[0].trim() });
  }
  ST_RE.lastIndex = 0;
  while ((m = ST_RE.exec(t))) {
    const n = Number(m[1]);
    if (n >= ST_MIN && n <= ST_MAX) sts.push({ n, raw: m[0].trim() });
  }

  // A cross-street is the most SPECIFIC thing this system can extract from
  // text — and we deliberately refuse to keep it.
  //
  // It used to be emitted verbatim as the zone name ("24th Ave NW & NW 70th
  // St") with coordinates off the linear fit above: a ~100m fix, well inside
  // PRIVACY.minZoneRadiusM = 300, and a direct breach of SPEC §6. Two things
  // make that worse than a theoretical leak. Ballard residents ran a
  // location-flooding campaign on 2026-07-18 precisely to stop this, so most
  // intersections in the corpus are now deliberate decoys; and extract.mjs
  // scored `grid` higher than any other precision, so the decoys outranked
  // every honest signal.
  //
  // So we resolve the intersection, snap it to the zone that contains it, and
  // keep only the fact that a cross-street was mentioned. `gridRef` records
  // what matched for the audit trail — never a coordinate, never a name.
  const gridPoint =
    aves.length && sts.length ? { lat: stToLat(sts[0].n), lon: aveToLon(aves[0].n),
                                  matched: `${aves[0].raw} / ${sts[0].raw}` }
    : aves.length ? { lat: BALLARD.lat, lon: aveToLon(aves[0].n), matched: aves[0].raw }
    : sts.length ? { lat: stToLat(sts[0].n), lon: BALLARD.lon, matched: sts[0].raw }
    : null;

  if (gridPoint) {
    const z = snapToZone(gridPoint.lat, gridPoint.lon, ZONES);
    if (!seen.has(z.zone)) {
      seen.add(z.zone);
      out.push({
        zone: z.zone, lat: z.lat, lon: z.lon, radius: z.radius,
        // "street" means: a street-level reference was made and we blurred it.
        // It is not a finer precision than "landmark" — it is the same zone
        // resolution, reached by a different route.
        precision: "street",
        matched: gridPoint.matched,
        gridRef: true,
      });
    }
  }

  // Named landmarks. Skip the catch-all "ballard" if anything specific matched.
  for (const z of ZONES) {
    if (z.zone === "Ballard (general)") continue;
    const hit = z.aliases.find((a) => t.includes(a));
    if (hit && !seen.has(z.zone)) {
      seen.add(z.zone);
      out.push({ zone: z.zone, lat: z.lat, lon: z.lon,
                 radius: Math.max(z.radius, 300), precision: "landmark", matched: hit });
    }
  }

  if (!out.length && /\bballard\b/.test(t)) {
    const g = ZONES.find((z) => z.zone === "Ballard (general)");
    out.push({ zone: g.zone, lat: g.lat, lon: g.lon, radius: g.radius,
               precision: "area", matched: "ballard" });
  }
  return out;
}

/** Nearest named zone to a coordinate — used to bucket iNat/311/911 points. */
export function zoneForPoint(lat, lon) {
  let best = null, bestD = Infinity;
  for (const z of ZONES) {
    const d = Math.hypot((z.lat - lat) * 111_320, (z.lon - lon) * 75_000);
    if (d < bestD) { bestD = d; best = z; }
  }
  return bestD <= 2000 ? best.zone : null;
}
