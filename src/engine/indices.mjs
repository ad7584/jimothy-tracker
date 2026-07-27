// Fused indices. Every component keeps its own inputs and a pointer to the
// source, so the dashboard can open any number and show what produced it.
//
// These are MODELS built from real measurements. They are labelled as such
// everywhere they appear.

import { clamp } from "../util/text.mjs";

/**
 * Foraging conditions — how likely a raccoon is to be active right now.
 * Raccoons are crepuscular/nocturnal; rain suppresses foraging; low tide opens
 * shoreline feeding at the Locks and Golden Gardens.
 */
export function foragingIndex(conditions, now = Date.now()) {
  const components = [];
  let score = 0;

  const sun = conditions?.sun;
  if (sun?.sunset && sun?.sunrise) {
    // Peak activity runs from civil dusk through the night to civil dawn.
    const dusk = sun.civilTwilightEnd || sun.sunset;
    const dawn = sun.civilTwilightBegin || sun.sunrise;
    const dayMs = 86400_000;
    const t = ((now - dusk) % dayMs + dayMs) % dayMs;
    const nightLen = ((dawn - dusk) % dayMs + dayMs) % dayMs;
    const inNight = t <= nightLen;
    // Sharpest in the first three hours after dusk.
    let v;
    if (!inNight) v = 8;
    else if (t < 3 * 3600_000) v = 45;
    else v = 32;
    score += v;
    components.push({
      key: "nocturnal-window", value: v, max: 45,
      detail: inNight ? (t < 3 * 3600_000 ? "post-dusk peak" : "night") : "daylight — raccoons typically denned",
      source: "sunrise-sunset.org",
    });
  }

  const w = conditions?.weather;
  if (w) {
    const rain = (w.precipLastHourMm ?? 0) > 0.2;
    const v = rain ? 6 : 25;
    score += v;
    components.push({
      key: "weather", value: v, max: 25,
      detail: rain ? `precipitation suppressing activity (${w.precipLastHourMm}mm/h)` : (w.description || "dry"),
      source: `NWS ${w.station || ""}`.trim(),
    });
  }

  const tide = conditions?.tide;
  if (tide?.now && tide?.low && tide?.high) {
    const range = tide.high.v - tide.low.v || 1;
    const rel = (tide.now.v - tide.low.v) / range;
    // Low water exposes the shoreline foraging that Ballard raccoons use.
    const v = Math.round((1 - rel) * 15);
    score += v;
    components.push({
      key: "tide", value: v, max: 15,
      detail: `${tide.now.v.toFixed(1)}ft (low ${tide.low.v.toFixed(1)} / high ${tide.high.v.toFixed(1)})`,
      source: "NOAA CO-OPS 9447130",
    });
  }

  // Food availability from real waste reports.
  const wasteN = conditions?.wasteCount ?? null;
  if (wasteN !== null) {
    const v = Math.round(clamp(wasteN / 20, 0, 1) * 15);
    score += v;
    components.push({
      key: "food-availability", value: v, max: 15,
      detail: `${wasteN} waste/dumping reports in Ballard, last 30d`,
      source: "Seattle Open Data 5ngg-rpne",
    });
  }

  const max = components.reduce((a, c) => a + c.max, 0) || 1;
  return {
    score: Math.round((score / max) * 100),
    components,
    isModel: true,
    note: "Modelled from measured conditions. Not an observation of Jimothy.",
  };
}

/** Attention — how hard the world is currently looking. */
export function attentionIndex(wiki, itemsLast24h, itemsPrev24h) {
  const components = [];
  let score = 0;

  const en = wiki?.langs?.find((l) => l.lang === "en");
  if (en) {
    const rel = en.peak ? en.latest / en.peak : 0;
    const v = Math.round(clamp(rel, 0, 1) * 50);
    score += v;
    components.push({
      key: "wikipedia-en", value: v, max: 50,
      detail: `${en.latest.toLocaleString()}/day (peak ${en.peak.toLocaleString()})`,
      source: "Wikimedia REST", url: en.url,
    });
  }

  const langs = wiki?.langs?.length ?? 0;
  if (langs) {
    const v = Math.min(15, langs * 5);
    score += v;
    components.push({
      key: "language-spread", value: v, max: 15,
      detail: `${langs} Wikipedia language editions: ${wiki.langs.map((l) => l.lang).join(", ")}`,
      source: "Wikimedia langlinks",
    });
  }

  const velocity = itemsLast24h ?? 0;
  const v2 = Math.round(clamp(velocity / 60, 0, 1) * 35);
  score += v2;
  const delta = itemsPrev24h ? ((velocity - itemsPrev24h) / itemsPrev24h) * 100 : null;
  components.push({
    key: "mention-velocity", value: v2, max: 35,
    detail: `${velocity} items in 24h${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs prior 24h)`}`,
    source: "ingest pipeline",
  });

  const max = components.reduce((a, c) => a + c.max, 0) || 1;
  return {
    score: Math.round((score / max) * 100),
    components,
    trend: wiki?.trend || null,
    isModel: true,
  };
}
