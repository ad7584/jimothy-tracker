# Jimothy Tracker

Real-time intelligence fusion for **Jimothy**, the short-spine raccoon of Ballard,
Seattle — an animal that Washington's governor has officially honoured and
cannot find.

Built in the shape of [World Monitor](https://www.worldmonitor.app/): many real
feeds, one correlation surface, every number sourced. See [SPEC.md](SPEC.md).

```bash
node src/runner.mjs          # ingest + dashboard on http://localhost:8140
node src/runner.mjs --once   # single cycle, print a report, exit
```

Zero runtime dependencies. Node ≥ 20.

---

## What it does

Thirteen live sources are polled on independent timers, normalised, scored for
location and sighting language, corroborated across independent origins, and
fused into two maps and a set of indices.

| | |
|---|---|
| **Story carousel** | premise + live headlines + findings from our own engine |
| **Hero metric** | `LAST VERIFIED SIGHTING` — and it is honest when stale |
| **Intel map** | one map, two scopes: **WORLD** hot zones ⇄ **BALLARD** ground truth |
| **Ballard scope** | territory model · raccoon GPS · chatter bloom · 311 waste |
| **Live feed** | platform-badged and filterable: X · Reddit · Mastodon · Bluesky · News · Ballard · iNaturalist |
| **Recognition** | every image scored: raccoon? short-spined? |
| **Wildlife cams** | verified channels, server-side live probe, honest offline state |
| **Indices** | attention · foraging conditions |
| **Source health** | which feeds are up, latency, last success |

### Feed fairness

News outnumbers everything roughly 5:1 and is always fresher, so a straight
recency slice consumed the entire feed and left every other platform's filter
chip reading zero. Each platform now gets a floor of `FEED_PER_PLATFORM`.

### Reddit politeness

Reddit's rate limit is account-less, IP-wide and persists across restarts. Four
queries per cycle at a 2.5s gap got us throttled hard enough that a raw `curl`
returned 429. Now: 6s gap, **one** subreddit per cycle round-robin, and a
10-minute cooldown on the whole source the moment a 429 appears.

## Sources

All keyless and verified live before inclusion. Full table with measured
densities in [SPEC.md §3](SPEC.md).

**Jimothy-specific** — Google News RSS · Bing News RSS · `old.reddit.com` RSS
(r/Seattle, r/SeattleWA, r/Ballard, r/all) · Mastodon `#jimothy` ·
MyBallard.com · X (hydrate-by-ID) · Wikipedia pageviews (en/pl/ru/tok)

**Environment** — NWS weather · sunrise-sunset · NOAA tides (Shilshole) ·
Seattle 311 · Seattle 911 · iNaturalist `Procyon lotor`


### Notes earned the hard way

- `www.reddit.com/search.rss` returns an **empty document**; `old.reddit.com`
  works. The JSON API returns HTML. Six parallel Reddit calls earn a 429, so
  every Reddit request is serialised.
- X cannot be searched without a paid API, but
  `cdn.syndication.twimg.com/tweet-result?id=…` hydrates any tweet by ID given
  a `Referer: platform.twitter.com` header.
- Wikimedia's `top-by-country` and `per-article-flat` routes both 404. Global
  spread comes from **per-language** pageviews instead.
- Bluesky's public API returns 403; bridged Bluesky posts still arrive via
  Mastodon's `bsky.brid.gy`.
- Traffic cameras are live but ~330×190px at night — a raccoon is 2–5 pixels.
  Deliberately excluded from recognition.

## Recognition filter

Two-stage, provider-agnostic, cost-bounded.

1. **Triage** (cheap) — is there a real raccoon here at all? Kills murals,
   tattoos, plushes, merch, charts and AI images.
2. **Identification** — torso length-to-height ratio, neck visibility,
   hindquarter slope. Returns a score *and its reasoning, shown verbatim*.

Highest-value input is **iNaturalist**: photo + GPS + timestamp +
community verification, so a positive hit is a *located, dated, corroborated*
event.

```bash
cp .env.example .env          # set OPENROUTER_API_KEY or ANTHROPIC_API_KEY
node src/tools/vision-test.mjs   # score one real Ballard raccoon photo
```

Without a key, ingest runs normally and images queue as `UNSCORED`.

A match is only ever reported as **"consistent with Jimothy"** — never "is
Jimothy".

## Rules the code enforces

- **All data real.** Nothing simulated. Empty panels say they are empty.
- **Chatter heat ≠ position.** Posting density and verified sightings are
  separate arrays, separate layers, separate colours. A bloom means people are
  posting about a place, not that he is there.
- **Zone resolution only.** Never a street address, never a live position.
  Jimothy is a wild animal that a few million people want to find; precise
  coordinates would draw crowds and traffic to him and map residents' homes.
- **Models are labelled `MODEL`.** Territory and both indices are estimates
  computed from measured inputs, and every component keeps a link to its source.
- **Conservation framing.** No hunt language. Wildlife-safety notice on the page.

## Honest limits

- **No live dot, ever.** Expect a handful of located candidates per week.
- X is hydrate-only; it cannot be searched.
- iNaturalist is sparse in Ballard — 85 observations all-time within 3km, 7 in
  the last 90 days.
- World attribution covers roughly a third of items; the remainder is reported
  as `unattributed` rather than guessed.

## Layout

```
src/
  runner.mjs          scheduler, pipeline, CLI report
  server.mjs          REST + SSE + static
  store.mjs           append-only NDJSON + snapshot
  config.mjs          every tunable
  sources/            feeds · social · wildlife · signals
  engine/             gazetteer · extract · recognise · corroborate · indices · heat
  tools/              vision-test
web/                  dashboard (MapLibre + OpenFreeMap)
data/                 items.ndjson · state.json · seen.json   (gitignored)
```

## API

`/api/state` · `/api/stream` (SSE) · `/api/sightings` · `/api/heat` ·
`/api/recognition` · `/api/health`

---

Fan-made. Not affiliated with Jimothy or the City of Seattle.
Do not approach or feed wildlife.

---

Built by [0xbl33p](https://github.com/0xbl33p).
