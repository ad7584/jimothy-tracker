// Non-item signals: attention, and the physical conditions that actually
// govern whether a raccoon is out foraging.
//
// These do not produce feed "items" — they produce measurements that the index
// engine fuses. Each returns a plain object with its own provenance.

import { getJson, get, POLITE_UA, BROWSER_UA } from "../util/http.mjs";
import { WIKI_ARTICLES, BALLARD } from "../config.mjs";

// --- Attention ------------------------------------------------------------
// Per-language pageviews are our global-spread signal. Wikimedia's per-country
// routes (top-by-country, per-article-flat) both 404 — they are not available.
function ymd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Last-known-good per language, so one transient 404 cannot blank the panel.
const lastGoodWiki = new Map();

export async function fetchWikipedia() {
  const end = new Date(Date.now() - 86400_000);
  const start = new Date(Date.now() - 31 * 86400_000);
  const langs = [];

  // Per-language failures are RECORDED, not swallowed.
  //
  // This used to be a bare `catch {}` reasoned as "a language edition with no
  // article yet simply has no series". But the Wikimedia pageviews endpoint
  // returns transient 404s: the English article — our single loudest signal at
  // ~46,500 views/day — was measured 404 and then 200 with 9 points from the
  // byte-identical URL a minute apart. Under the old code that language just
  // vanished, `attention` under-reported, and the caption cheerfully read
  // "3 Wikipedia language editions" with no hint that a fetch had failed.
  //
  // Last-known-good is kept per language so one bad poll cannot blank a panel,
  // and `stale` says plainly when that is what is being shown.
  const failures = [];
  for (const w of WIKI_ARTICLES) {
    const url =
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${w.lang}.wikipedia` +
      `/all-access/user/${encodeURIComponent(w.article)}/daily/${ymd(start)}/${ymd(end)}`;
    let series = null;
    let error = null;
    // One cheap retry: the observed failure mode is transient, not structural.
    for (let attempt = 0; attempt < 2 && !series; attempt++) {
      try {
        const res = await getJson(url, { ua: POLITE_UA });
        const rows = (res.items || []).map((i) => ({
          // Timestamps arrive as YYYYMMDD00.
          day: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`,
          views: i.views,
        }));
        if (rows.length) series = rows;
        else error = "no data returned";
      } catch (e) {
        error = String(e.message || e).slice(0, 80);
      }
    }

    if (series) {
      const row = {
        lang: w.lang, region: w.region, article: w.article, series,
        latest: series.at(-1).views,
        peak: Math.max(...series.map((s) => s.views)),
        url: `https://${w.lang}.wikipedia.org/wiki/${encodeURIComponent(w.article)}`,
        stale: false,
      };
      lastGoodWiki.set(w.lang, row);
      langs.push(row);
    } else {
      failures.push({ lang: w.lang, error });
      const prev = lastGoodWiki.get(w.lang);
      if (prev) langs.push({ ...prev, stale: true });
    }
  }

  const en = langs.find((l) => l.lang === "en");
  let trend = null;
  if (en && en.series.length >= 3) {
    const last = en.series.at(-1).views;
    trend = { latest: last, peak: en.peak, offPeakPct: en.peak ? (1 - last / en.peak) * 100 : 0 };
  }
  return {
    ok: langs.length > 0,
    langs,
    trend,
    failures,
    provenance: [{ source: "Wikimedia REST", n: langs.length, failed: failures.length }],
  };
}

// --- Conditions -----------------------------------------------------------
// Raccoons are crepuscular/nocturnal. Twilight is the foraging window; rain
// suppresses activity; tide governs shoreline foraging at the Locks and
// Golden Gardens.
export async function fetchConditions() {
  const out = { ok: false, provenance: [] };

  try {
    const sun = await getJson(
      `https://api.sunrise-sunset.org/json?lat=${BALLARD.lat}&lng=${BALLARD.lon}&formatted=0`
    );
    const r = sun.results || {};
    out.sun = {
      sunset: Date.parse(r.sunset) || null,
      sunrise: Date.parse(r.sunrise) || null,
      civilTwilightEnd: Date.parse(r.civil_twilight_end) || null,
      civilTwilightBegin: Date.parse(r.civil_twilight_begin) || null,
    };
    out.provenance.push({ source: "sunrise-sunset.org" });
    out.ok = true;
  } catch (e) {
    out.provenance.push({ source: "sunrise-sunset.org", error: e.message });
  }

  try {
    // NWS is a two-step API: resolve the point to a gridpoint, then read it.
    const pt = await getJson(
      `https://api.weather.gov/points/${BALLARD.lat},${BALLARD.lon}`,
      { ua: POLITE_UA }
    );
    const stationsUrl = pt.properties?.observationStations;
    if (stationsUrl) {
      const st = await getJson(stationsUrl, { ua: POLITE_UA });
      const first = st.features?.[0]?.id;
      if (first) {
        const obs = await getJson(`${first}/observations/latest`, { ua: POLITE_UA });
        const p = obs.properties || {};
        out.weather = {
          description: p.textDescription || null,
          tempC: p.temperature?.value ?? null,
          precipLastHourMm: p.precipitationLastHour?.value ?? null,
          windKph: p.windSpeed?.value ?? null,
          station: first.split("/").pop(),
          observedAt: Date.parse(p.timestamp) || null,
        };
        out.provenance.push({ source: "NWS api.weather.gov" });
      }
    }
  } catch (e) {
    out.provenance.push({ source: "NWS api.weather.gov", error: e.message });
  }

  try {
    // Station 9447130 — Seattle / Shilshole area.
    const t = await getJson(
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=today&station=9447130" +
        "&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=h",
      { ua: POLITE_UA }
    );
    const preds = (t.predictions || []).map((p) => ({ t: p.t, v: Number(p.v) }));
    if (preds.length) {
      out.tide = {
        now: preds.reduce((a, b) =>
          Math.abs(Date.parse(b.t) - Date.now()) < Math.abs(Date.parse(a.t) - Date.now()) ? b : a
        ),
        low: preds.reduce((a, b) => (b.v < a.v ? b : a)),
        high: preds.reduce((a, b) => (b.v > a.v ? b : a)),
        station: "9447130",
      };
      out.provenance.push({ source: "NOAA CO-OPS" });
    }
  } catch (e) {
    out.provenance.push({ source: "NOAA CO-OPS", error: e.message });
  }

  return out;
}

// --- Civic ----------------------------------------------------------------
// 311 waste reports are a real proxy for food availability; 911 calls are a
// real proxy for neighbourhood disturbance. Both carry coordinates.
const BALLARD_ZIPS = "'98107','98117'";

export async function fetchCivic() {
  const out = { ok: false, provenance: [], waste: [] };
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19);

  try {
    const url =
      "https://data.seattle.gov/resource/5ngg-rpne.json" +
      "?$select=servicerequestnumber,webintakeservicerequests,createddate,latitude,longitude" +
      `&$where=zipcode in (${BALLARD_ZIPS}) AND createddate > '${since}' AND latitude IS NOT NULL` +
      "&$order=createddate DESC&$limit=400";
    const rows = await getJson(encodeURI(url), { ua: BROWSER_UA, timeout: 30000 });
    out.waste = rows
      .filter((r) => /dumping|garbage|litter|encampment|overgrown/i.test(r.webintakeservicerequests || ""))
      .map((r) => ({
        type: r.webintakeservicerequests,
        ts: Date.parse(r.createddate) || null,
        lat: Number(r.latitude),
        lon: Number(r.longitude),
      }))
      .filter((r) => Number.isFinite(r.lat));
    out.provenance.push({ source: "Seattle Open Data 5ngg-rpne", n: out.waste.length });
    out.ok = true;
  } catch (e) {
    out.provenance.push({ source: "Seattle Open Data 5ngg-rpne", error: e.message });
  }

  // Seattle 911 fire/medic (kzjm-xkqj) IS NOT FETCHED, deliberately.
  //
  // It was ingested as a "neighbourhood disturbance" proxy, shipped 1,739 B on
  // every push, and rendered nowhere — no engine read it and no panel drew it.
  // Before reviving it, look at what it actually contains: Aid Response, Auto
  // Fire Alarm, Activated CO Detector, Crisis Center, Ladder Code Red, each
  // carrying coordinates, filtered to a 3.5km circle that is overwhelmingly
  // residential.
  //
  // README justifies zone-only resolution partly because precise coordinates
  // "would map residents' homes". Plotting somebody's crisis call on a raccoon
  // map honours the letter of that rule and inverts its spirit — and there is
  // no causal link between a medic call and a raccoon's foraging behaviour, so
  // it could never have earned its place on the merits either.
  //
  // Removed rather than aggregated. An aggregate of data that means nothing is
  // still nothing.

  return out;
}
