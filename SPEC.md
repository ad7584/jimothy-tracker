# JIMOTHY TRACKER — Specification

> A real-time intelligence dashboard for a raccoon whose location nobody knows.
> Built in the shape of [World Monitor](https://www.worldmonitor.app/): many real feeds,
> one correlation surface, every number sourced.

**Status:** BUILT. Ingest, engine, API and dashboard all running against live
feeds as of 2026-07-26. Recognition filter is wired but idle pending an API key.
**Verified:** every source marked ✅ below was fetched live on 2026-07-26 before being listed.

---

## 1. What this is

Washington's governor named Jimothy "Washingtonian of the Day" and **cannot find him to
present the award**. That is the actual premise, straight from the Pubity post:

> "They're trying to track Jimothy down so they can give him the award."

So the product is not a novelty map with a raccoon on it. It is a genuine
intelligence-fusion problem with a genuinely unknown target:

- **The target is real** — a specific animal, in a specific ~4km² neighbourhood.
- **The target is unlocated** — no feed on Earth publishes his position.
- **The signal is abundant but indirect** — 174 Jimothy mentions per sweep, almost
  none of them containing a location.

The job is to fuse everything obtainable into a defensible estimate, and to be
honest about the confidence on every single thing we display.

---

## 2. The three layers

### Layer 1 — INTEL ORIGIN (world map)
Where in the world Jimothy intel is being generated. News outlets by country,
Mastodon instances by host, Reddit activity. Answers *"the whole
planet is looking for one raccoon in one neighbourhood"* and it is always full,
because attention is our densest real signal.

### Layer 2 — TERRITORY (Ballard map)
Zoomed to Ballard. Zone-level probability surface built from real inputs:
verified sighting history, 311 waste density (food), iNaturalist raccoon
observation history, habitat, and foraging conditions. **Zone resolution only —
never a street address.** See §6.

### Layer 3 — RECOGNITION
Every image that enters the system gets scored: *is this a raccoon, and is it
Jimothy?* A positive hit on a geotagged photo is the single highest-value event
the system can produce.

---

## 3. Feed inventory — verified live

### Jimothy-specific
| Source | Status | Yield | Notes |
|---|---|---|---|
| Google News RSS | ✅ | 108 items/sweep | High volume, mostly national, low location content |
| Bing News RSS | ✅ | independent 2nd news origin | Needed for corroboration counting |
| `www.reddit.com/search.rss` | ✅ | 96 items/sweep | **Best sighting source.** ⚠️ **THE HOSTS SWAPPED.** Re-measured 2026-07-26 seconds apart, same UA: `old.` → 302 `/login/?reason=lor2`; `www.` → 200 valid Atom. Budget is **1 request per ~60s window** (`x-ratelimit-remaining: 0.0`); a second call inside it returns **200 with an empty body**, not 429 — so check body SHAPE, never status. No ETag, so no conditional GET |
| `r/JimothyTheRaccoon` · `r/JimothyRaccoon` | ✅ | 17 of 25 global-search hits | Dedicated subs, 9,032 subs, 668 posts in 10 days, no decay. Its `🚨 RECENT SIGHTING` flair is **not an oracle** — 6 of 8 flaired posts are *media* sightings and the only geographic one is satire |
| ~~`r/Ballard`~~ | ❌ | 0 ever | Dropped. ~20 posts in seven months, none about Jimothy; it was consuming a quarter of the request budget |
| Mastodon `#jimothy` timeline | ✅ | 40 items | Keyless, includes media attachments |
| MyBallard.com RSS | ✅ | 2 items, both relevant | **Highest signal-to-noise.** Hyperlocal Ballard blog |
| X (`cdn.syndication.twimg.com/tweet-result`) | ✅ | hydrate-by-ID only | **Works** — re-verified 2026-07-26, 200 with full text, timestamps and media. Still **cannot search**, so it is only as good as the URLs harvested elsewhere |
| Bluesky `api.bsky.app` searchPosts | ✅ | ~0.6 posts/min | ⚠️ **Previously recorded as 403 — that was the wrong hostname.** `public.api.bsky.app` is CDN-blocked; `api.bsky.app` returns 200. Token bucket ≈10 calls recovering ~15s, so serialise |
| TikTok (`www.tiktok.com/oembed` hydrate-by-URL) | ✅ | ~2-3 videos/day | **Cannot be searched keylessly** — search/tag pages are empty shells behind signed XHR (verified 2026-07-29). Discovery = Bluesky `searchPosts?q=jimothy&domain=tiktok.com` (25/25 posts carried links) + regex harvest over all ingested text. oEmbed is official, keyless, accepts `/t/` short links, 400s on dead videos. `thumbnail_url` is signed, **expires ~48h** — bytes cached to `data/tikthumbs/` at ingest. `id >> 32` = unix creation seconds. Dashboard playback via `embed/v2/<id>` iframe (no X-Frame-Options, verified). ⚠️ All verification was from a residential IP — run `npm run smoke:tiktok` from Railway after deploy |
| Wikipedia pageviews REST | ✅ | daily | Attention curve: 46 → 677 → 8,965 → 24,148/day |

### Environment (governs raccoon behaviour)
| Source | Status | Notes |
|---|---|---|
| `api.weather.gov` | ✅ | Rain suppresses foraging |
| sunrise-sunset.org | ✅ | Raccoons are crepuscular. Civil twilight is the foraging window |
| NOAA tides, Shilshole (9447130) | ✅ | Shoreline foraging at the Locks / Golden Gardens |
| Seattle 311 (`5ngg-rpne`) | ✅ | 2,545 Ballard requests/30d, geolocated. 293 illegal dumping = **food** |
| Seattle 911 fire/medic (`kzjm-xkqj`) | ✅ | Live, geolocated, neighbourhood disturbance |
| iNaturalist `Procyon lotor` | ✅ | **85 all-time / 7 in 90d within 3km.** Sparse but photo + GPS + timestamp |

### Rejected after testing
| Source | Why |
|---|---|
| WSDOT / SDOT traffic cameras | Live and real (verified: bytes change between fetches) but **~330×190px, night, freeway**. A raccoon is 2–5px. Unusable for recognition. May appear as an ambient "watching" layer, explicitly never as a detection source |
| Bluesky public API | HTTP 403 |
| Reddit JSON API | Returns HTML; needs OAuth |
| Nitter | HTTP 403 |
| X profile timeline / oEmbed | HTTP 200 but empty body |

---

## 4. Pipeline

```
POLL ──► PARSE ──► EXTRACT ──► RECOGNISE ──► CORROBORATE ──► FUSE ──► SERVE ──► RENDER
```

1. **Poll** — independent timers per source. Signals ~60s, social/news ~5min,
   Wikipedia/iNat/weather/tides ~1h. Staggered, cached, backoff on 429
   (Reddit rate-limited us at 6 parallel calls — must serialise).
2. **Parse** — RSS/Atom/JSON → `{text, url, timestamp, origin, images[]}`.
3. **Extract** — Ballard gazetteer (Nominatim-verified coords) **plus street-grid
   regex** (`NW \d+th St`, `\d+th Ave NW`) — Ballard is a numbered grid and this is
   the single biggest geolocation win available. Post bodies and top comments, not
   just titles.
4. **Recognise** — see §5.
5. **Corroborate** — cluster by space + time, count *independent origin types*.
   1 origin = UNVERIFIED · 2 = PROBABLE · 3+ = CONFIRMED. (World Monitor fires
   breaking alerts on 5 independent origins; ours is scaled to available density.)
6. **Fuse** — indices, each component retaining a pointer to its source.
7. **Store** — append-only NDJSON + state snapshot. No database.
8. **Serve** — `node:http`, REST + SSE.
9. **Render** — MapLibre + OpenFreeMap, panels on the stream, ⌘K palette.

**Invariant:** nothing renders without a provenance tag and a confidence value.
Anything computed is labelled computed.

---

## 5. The recognition filter

Jimothy is unusually identifiable. Short spine syndrome gives him a compressed
torso, no visible neck, and a distinctive low length-to-height silhouette that
normal raccoons do not have. That is a real discriminative feature, not a vibe.

**Two-stage, cost-controlled:**

- **Stage 1 — triage (cheap).** Every inbound image. `claude-haiku-4-5`:
  *is there a raccoon in this image at all?* Most inbound images are murals,
  tattoos, plushes, charts and merch — they die here.
- **Stage 2 — identification.** Survivors go to `claude-sonnet-5` with a rubric:
  torso length-to-height ratio, neck visibility, hindquarter slope, gait posture.
  Returns a score plus a written justification, which we display verbatim.

**Inputs, best first:**
1. **iNaturalist observation photos** — photo + GPS + timestamp + research-grade
   verification. A positive here is a *located, dated, corroborated* hit. This is
   the highest-value path in the whole system.
2. Reddit image posts, Mastodon media, X media (via `tweet-result`), news images.

**Never claimed:** a match is "consistent with Jimothy," never "is Jimothy."
Confidence and the model's own reasoning are always shown.

---

## 6. Constraints that are not negotiable

- **All data real.** No simulation, no placeholder, no synthesised sighting. If a
  panel has no data it says so.
- **Zone resolution only.** Never a street address, never a house. A few million
  people want to find this animal; precise real-time coordinates would draw
  crowds, feeding and traffic to a wild animal, and would map residents' homes.
  We blur deliberately and we say so on the front page.
- **Conservation framing.** Sarvey Wildlife Care Center has already commented
  publicly, and there is a live thread criticising mockery of his deformity as
  ableist. No "hunt" language. Celebration and wildlife-safety framing throughout.
- **Model output is labelled model output.** The territory surface is an estimate.
- **Enforced, not merely intended.** `engine/privacy.mjs` is the choke point and
  `tools/privacy-test.mjs` asserts it against the real corpus. Coordinates are
  stripped before scoring *and* before persistence; anything finer than a named
  zone is snapped up to the zone containing it; iNaturalist points are widened
  from their native 2–20m to the zone centroid. Previously the gazetteer emitted
  `24th Ave NW & NW 70th St` with a ~100m fix and `extract` scored that
  precision higher than anything else it could find.
- **The neighbours got there first.** On 2026-07-18, r/Seattle post `1uzk5cr`
  (+5,358) asked people to flood the zone with false locations to protect him,
  and they did — Fremont Troll +175, Archie McPhee +90, Museum of Glass Tacoma
  +24. Across 1,629 comments the commonest place token is `tacoma` (27), ahead
  of `ballard` (25). Ballard decided to blur him before we did; the scorer now
  treats a named cross-street as the *least* reliable geography in the corpus,
  not the most.
- **Speculative-asset chatter is excluded outright**, not down-ranked. It carries
  the name, carries no information about an animal, and nothing here should
  point anyone at it.

---

## 7. Honest limits

- **We will not produce a live dot.** Expect a handful of located sightings per
  week at best. The headline metric is `LAST VERIFIED SIGHTING: Nd ago` and it
  will often be stale. That is the truth and it is also the story.
- **X cannot be searched**, only hydrated by ID from links found elsewhere.
- **iNaturalist is sparse in Ballard** — 7 observations in 90 days.
- **Traffic cameras cannot see a raccoon.**

---

## 8. Open decisions

1. Recognition on photos, cameras demoted to ambient layer — confirm?
2. Claude vision (needs API key + budget) vs. a local ONNX detector?
3. World map = intel origin, Ballard map = territory — confirm?
4. Hosting: continuous ingest needs persistent Node (Railway/Fly/Render), not
   static Vercel.
5. Name / domain.
