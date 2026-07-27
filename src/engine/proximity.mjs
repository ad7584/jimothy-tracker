// "How close are we to actually finding him?"
//
// A single 0–100 read on the strength of the CURRENT evidence. Every component
// is measured, and every component is shown with its own value so the number
// can never be taken on faith.
//
// This scores the EVIDENCE, not the animal. 100 does not mean he is found; it
// means multiple independent origins, a recognition hit, a fresh timestamp and
// a street-level location all agree at once. Right now it is near zero, and
// that is the honest answer.

const RECOG_WINDOW = 14 * 86400_000;

export function proximityIndex({ clusters = [], recognition = [], zones = [] } = {}, now = Date.now()) {
  const components = [];

  // 1. Corroboration — the single most important signal. Three independent
  //    origin types agreeing is the bar for CONFIRMED.
  const best = clusters.reduce((a, c) => (c.originCount > (a?.originCount ?? -1) ? c : a), null);
  const originCount = best?.originCount ?? 0;
  const corr = Math.min(1, originCount / 3) * 40;
  components.push({
    key: "corroboration", label: "Independent origins", value: Math.round(corr), max: 40,
    detail: originCount ? `${originCount} of 3 needed${best?.zone ? ` · ${best.zone}` : ""}` : "no located cluster yet",
  });

  // 2. Recognition — a photo scored as consistent with a short-spined raccoon.
  const hits = recognition.filter(
    (r) => r.status === "CONSISTENT_WITH_JIMOTHY" && now - (r.checkedAt || 0) < RECOG_WINDOW
  );
  const best2 = hits.reduce((a, r) => Math.max(a, r.confidence ?? 0), 0);
  const rec = best2 * 25;
  components.push({
    key: "recognition", label: "Photo identification", value: Math.round(rec), max: 25,
    detail: hits.length
      ? `${hits.length} image(s) consistent · best confidence ${best2.toFixed(2)}`
      : "no image scored consistent with Jimothy",
  });

  // 3. Freshness — evidence decays fast. A week-old lead is not a lead.
  const newest = clusters.reduce((a, c) => Math.max(a, c.ts || 0), 0);
  const ageH = newest ? (now - newest) / 3.6e6 : Infinity;
  const fresh = Number.isFinite(ageH) ? Math.max(0, 1 - ageH / 72) * 20 : 0;
  components.push({
    key: "freshness", label: "Lead freshness", value: Math.round(fresh), max: 20,
    detail: Number.isFinite(ageH)
      ? `newest located lead ${ageH < 48 ? `${ageH.toFixed(0)}h` : `${(ageH / 24).toFixed(1)}d`} old`
      : "no located lead on record",
  });

  // 4. Precision — a cross-street beats a landmark beats "somewhere in Ballard".
  const rank = { grid: 1, landmark: 0.6, area: 0.25 };
  const bestPrec = clusters.reduce((a, c) => Math.max(a, rank[c.precision] ?? 0), 0);
  const prec = bestPrec * 15;
  components.push({
    key: "precision", label: "Location precision", value: Math.round(prec), max: 15,
    detail: bestPrec === 1 ? "cross-street resolved"
      : bestPrec >= 0.6 ? "named landmark only"
      : bestPrec > 0 ? "neighbourhood-level only" : "no location resolved",
  });

  const score = Math.round(components.reduce((a, c) => a + c.value, 0));

  // Plain-language read. Deliberately blunt at the low end.
  const verdict =
    score >= 75 ? "STRONG — multiple independent origins agree on a fresh, precise location"
    : score >= 50 ? "PROMISING — real evidence, but not yet corroborated enough to act on"
    : score >= 25 ? "WEAK — scattered signals, nothing that would let anyone go and look"
    : score >= 10 ? "COLD — traces only"
    : "NO TRAIL — nothing currently points anywhere";

  return {
    score,
    verdict,
    components,
    isModel: true,
    // Each axis takes the best value available across the whole evidence pool,
    // so a strong score can be assembled from different leads. Say so — the
    // alternative reading (one lead scoring this on every axis) would be a
    // considerably bigger claim than the data supports.
    note: "Best value on each axis across all current leads — not necessarily one lead scoring well on all four. Scores the evidence, not the animal.",
    topZone: zones?.[0]?.zone || null,
  };
}
