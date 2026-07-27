// iNaturalist — the highest-value input in the system.
//
// Every observation carries a photo, GPS coordinates, a timestamp and a
// community verification grade. A positive recognition hit on one of these is a
// located, dated, corroborated Jimothy event — nothing else we ingest can
// produce that.
//
// Density reality check (measured 2026-07-26): 85 Procyon lotor observations
// all-time within 3km of Ballard, 7 in the last 90 days. Sparse. Widening the
// radius to 8km gives 487 all-time, which is useful as a behavioural baseline
// (what hour are raccoons active) but is no longer Jimothy's territory.

import { getJson, POLITE_UA } from "../util/http.mjs";
import { hashId } from "../util/text.mjs";
import { BALLARD } from "../config.mjs";
import { ZONES } from "../engine/gazetteer.mjs";
import { enforceObservationPrivacy } from "../engine/privacy.mjs";

const BASE = "https://api.inaturalist.org/v1/observations";

function toItem(o, { baseline }) {
  const [rawLat, rawLon] = (o.location || "").split(",").map(Number);

  // Snap before anything downstream can see the real point.
  //
  // iNaturalist contributors geotag to 2-20m and `obscured` is false by
  // default, so this layer was plotting other people's raccoon sightings — and
  // therefore their gardens — at house precision, straight onto a public map,
  // in a product whose SPEC §6 forbids exactly that. Note that the observer of
  // the one Jimothy record set positional_accuracy to 2,953m herself, and the
  // other iNat Jimothy record's description reads "hopefully zoomed in enough
  // photos to preserve his location". The people supplying this data are being
  // more careful with it than we were. Both consumers of meta.lat/lon —
  // extract.mjs and runner.mjs — inherit the fix from here.
  const priv = enforceObservationPrivacy(rawLat, rawLon, ZONES, o.positional_accuracy ?? null);

  const photos = (o.photos || [])
    .map((p) => (p.url || "").replace("/square.", "/medium."))
    .filter(Boolean);
  const ts = Date.parse(o.time_observed_at || o.observed_on_string || o.created_at) || null;
  return {
    id: hashId("inat", String(o.id)),
    origin: "wildlife",
    source: baseline ? "iNaturalist (baseline 8km)" : "iNaturalist (Ballard 3km)",
    title: `Procyon lotor observation #${o.id}`,
    text: [o.species_guess, o.place_guess, o.description].filter(Boolean).join(" · "),
    url: o.uri || `https://www.inaturalist.org/observations/${o.id}`,
    ts,
    images: photos,
    meta: {
      inatId: o.id,
      qualityGrade: o.quality_grade || null,
      // Zone centroid, never the reported point. `zoneRadiusM` is published so
      // the map can draw honest uncertainty instead of implying a fix.
      lat: priv.lat,
      lon: priv.lon,
      zone: priv.zone,
      zoneRadiusM: priv.radius,
      snapped: priv.snapped,
      reportedAccuracyM: o.positional_accuracy ?? null,
      obscured: o.geoprivacy === "obscured" || o.taxon_geoprivacy === "obscured",
      baseline: Boolean(baseline),
      observer: o.user?.login || null,
    },
    fetchedAt: Date.now(),
  };
}

async function query({ radius, baseline, days }) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const url =
    `${BASE}?taxon_name=Procyon%20lotor&lat=${BALLARD.lat}&lng=${BALLARD.lon}` +
    `&radius=${radius}&d1=${since}&order=desc&order_by=observed_on&per_page=50`;
  const res = await getJson(url, { ua: POLITE_UA, timeout: 25000 });
  return (res.results || []).map((o) => toItem(o, { baseline }));
}

export const inaturalistSource = {
  id: "inaturalist",
  origin: "wildlife",
  label: "iNaturalist",
  async fetch() {
    // Tight radius = candidate Jimothy sightings. Wide radius = behavioural
    // baseline only, and is tagged as such so it never counts as a sighting.
    const [near, wide] = await Promise.all([
      query({ radius: 3, baseline: false, days: 365 }),
      query({ radius: 8, baseline: true, days: 365 }),
    ]);
    const seen = new Set(near.map((i) => i.id));
    return [...near, ...wide.filter((i) => !seen.has(i.id))];
  },
};
