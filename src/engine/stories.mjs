// Story slides for the header carousel.
//
// Every slide is built from something real: the founding premise (sourced to
// the reporting), then the strongest genuine headlines currently in the feed,
// then live findings from our own indices. Nothing is written by hand at
// display time — if the data is not there, the slide does not appear.

const PREMISE = {
  kind: "premise",
  eyebrow: "WHY THIS EXISTS",
  headline: "Washington's governor named a raccoon Washingtonian of the Day — and cannot find him to present the award.",
  body: "Jimothy lives somewhere in Ballard, Seattle. No feed on Earth publishes his position. This is the search.",
  source: "Reported 26 Jul 2026",
  url: "https://x.com/pubity/status/2081212916100141463",
  accent: true,
};

/** A headline is only carousel-worthy if it is about the animal, not the merch. */
const WORTHY = /raccoon|jimothy/i;
const UNWORTHY = /token|coin|memecoin|market cap|pump\.fun|price|surge|rally/i;

export function buildStories(feed = [], state = {}) {
  const slides = [PREMISE];
  const seenOutlet = new Set();

  // Strongest real headlines, one per outlet so the carousel does not show the
  // same wire story five times.
  const news = feed
    .filter((i) => (i.platform === "news" || i.platform === "local") && i.title)
    .filter((i) => WORTHY.test(i.title) && !UNWORTHY.test(i.title))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  for (const n of news) {
    const outlet = (n.source || "").split("·").pop().trim();
    if (seenOutlet.has(outlet)) continue;
    seenOutlet.add(outlet);
    slides.push({
      kind: "headline",
      eyebrow: outlet.toUpperCase(),
      headline: n.title.replace(/\s+-\s+[^-]+$/, ""),
      body: "",
      source: n.source,
      url: n.url,
      ts: n.ts,
      image: n.images?.[0] || null,
    });
    if (slides.length >= 7) break;
  }

  // Findings from our own engine — these are the slides nobody else can show.
  const en = state.wiki?.langs?.find((l) => l.lang === "en");
  if (en && en.peak) {
    const off = Math.round((1 - en.latest / en.peak) * 100);
    slides.push({
      kind: "finding",
      eyebrow: "OUR DATA · ATTENTION",
      headline: off > 3
        ? `Global attention has turned — down ${off}% from its peak, and he still has not been found.`
        : `Global attention is at its peak: ${en.latest.toLocaleString()} encyclopedia lookups a day.`,
      body: `English Wikipedia: ${en.latest.toLocaleString()}/day now, ${en.peak.toLocaleString()}/day at peak. Articles exist in ${state.wiki.langs.length} languages.`,
      source: "Wikimedia REST · measured",
      url: en.url,
    });
  }

  const top = state.zones?.[0];
  if (top && top.observations > 0) {
    slides.push({
      kind: "finding",
      eyebrow: "OUR DATA · TERRITORY",
      headline: `${top.zone} is the most probable ground — ${top.observations} verified raccoon fixes.`,
      body: `Modelled from ${top.observations} GPS observations, ${top.foodReports} waste reports and ${top.chatter} posts. An estimate for a Ballard raccoon, not a position for Jimothy.`,
      source: "iNaturalist + Seattle Open Data · modelled",
    });
  }

  const ls = state.lastSighting;
  if (ls && !ls.found) {
    slides.push({
      kind: "finding",
      eyebrow: "OUR DATA · STATUS",
      headline: "No sighting has reached corroboration. Whereabouts remain unknown.",
      body: "A report is promoted only when independent origin types agree. Nothing currently clears that bar — and we will not invent a dot to fill the map.",
      source: "corroboration engine",
    });
  }

  return slides;
}
