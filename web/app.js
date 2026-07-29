/* Jimothy Tracker — dashboard client.

   Renders only what the server provides. Generates nothing: if a field is
   absent the panel says so rather than inventing a value.

   UX notes are inline where a law drove the decision. */

const $ = (id) => document.getElementById(id);
const BALLARD = [-122.3843, 47.6685];
// "liberty" is a light style and renders as a white slab in a dark dashboard.
const STYLE = "https://tiles.openfreemap.org/styles/dark";

const C = { accent: "#f2ab42", signal: "#45d3e0", chatter: "#b06fd6", bad: "#ff6b60",
            ok: "#55d685", waste: "#8fa07f", cam: "#7de3a3" };

let STATE = null;
let scope = "ballard";            // ballard | seattle — Seattle-area only, by scope decision
let platformFilter = new Set();   // empty = show all
let camType = "street";           // street | wildlife
let camId = null;
let camTick = null;               // refresh timer for SDOT stills
let camRenderedFor = null;        // which camera the stage currently holds
let camView = "wall";             // wall | single | wildlife
let tapeTimer = null;             // time-lapse playback timer

/* ── formatting ─────────────────────────────────────────────────────── */
const fmtAge = (ts) => {
  if (!ts) return "—";
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return `${Math.max(0, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── maps ───────────────────────────────────────────────────────────── */
let map, mapReady = false;

/**
 * Run `fn` once the style is parsed.
 * NOT map.on("load") — that waits for a rendered frame, so in a background or
 * non-compositing tab rAF is throttled, the event never fires, and the map
 * stays empty forever. "style.load" fires on parse; the poll is a fallback.
 */
function whenStyleReady(m, fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    try { fn(); } catch (e) { console.error("map init failed", e); }
  };
  const poll = setInterval(() => { if (m.getStyle && m.getStyle()?.layers?.length) run(); }, 250);
  m.once("style.load", run);
  if (m.isStyleLoaded && m.isStyleLoaded()) run();
}

const empty = { type: "FeatureCollection", features: [] };
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (lon, lat, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

function initMap() {
  map = new maplibregl.Map({
    container: "map", style: STYLE, center: BALLARD, zoom: 13.3,
    attributionControl: { compact: true }, minZoom: 8.5, maxZoom: 18,
    // Seattle only — there is nothing for this product outside Puget Sound.
    maxBounds: [[-122.75, 47.30], [-121.95, 47.95]],
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  whenStyleReady(map, () => { buildLayers(); mapReady = true; applyScope(true); if (STATE) paint(); });
}

function buildLayers() {
  for (const id of ["territory", "chatter", "wildlife", "waste", "cams"]) {
    map.addSource(id, { type: "geojson", data: empty });
  }

  // Modelled territory.
  map.addLayer({
    id: "territory-fill", type: "circle", source: "territory",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        11, ["+", 4, ["*", ["get", "score"], 20]],
        15, ["+", 14, ["*", ["get", "score"], 74]]],
      "circle-color": C.accent,
      "circle-opacity": ["+", 0.05, ["*", ["get", "score"], 0.16]],
      "circle-stroke-color": C.accent, "circle-stroke-width": 1,
      "circle-stroke-opacity": ["+", 0.18, ["*", ["get", "score"], 0.42]],
    },
  });
  // Chatter — violet and blurred so it can never read as a position marker.
  map.addLayer({
    id: "chatter-bloom", type: "circle", source: "chatter",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        11, ["*", ["get", "intensity"], 24], 15, ["*", ["get", "intensity"], 86]],
      "circle-color": C.chatter,
      "circle-opacity": ["+", 0.05, ["*", ["get", "intensity"], 0.2]],
      "circle-blur": 0.85,
    },
  });
  map.addLayer({
    id: "waste-pt", type: "circle", source: "waste",
    paint: { "circle-radius": 2, "circle-color": C.waste, "circle-opacity": 0.55 },
  });

  // SDOT street cameras — square markers so they read as equipment, not events.
  map.addLayer({
    id: "cam-pt", type: "symbol", source: "cams",
    layout: {
      "text-field": "▣",
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 12, 15, 20],
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": ["case", ["get", "ok"], C.cam, "#5b6c76"],
      "text-halo-color": "#070a0d", "text-halo-width": 1.6,
    },
  });
  map.addLayer({
    id: "wildlife-halo", type: "circle", source: "wildlife",
    filter: ["==", ["get", "hit"], true],
    paint: { "circle-radius": 14, "circle-color": C.bad, "circle-opacity": 0.18, "circle-blur": 0.4 },
  });
  // The only crisp points on the map: real observed GPS.
  map.addLayer({
    id: "wildlife-pt", type: "circle", source: "wildlife",
    paint: {
      "circle-radius": ["case", ["get", "hit"], 6.5, 4],
      "circle-color": ["case", ["get", "hit"], C.bad, C.signal],
      "circle-stroke-color": "#070a0d", "circle-stroke-width": 1.5,
    },
  });

  const pop = new maplibregl.Popup({ closeButton: false, offset: 11 });
  const muted = (t) => `<span style="color:#7d8f9a">${t}</span>`;
  const hover = (layer, html) => {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("mousemove", layer, (e) => {
      const f = e.features?.[0];
      if (f) pop.setLngLat(e.lngLat).setHTML(html(f.properties)).addTo(map);
    });
  };
  hover("cam-pt", (p) =>
    `<b>${esc(p.name)}</b><br>SDOT street camera · ${Number(p.km).toFixed(2)}km from Ballard centre<br>` +
    (p.ok ? muted("live still — click to open") : muted("not currently serving")));
  hover("territory-fill", (p) =>
    `<b>${esc(p.zone)}</b><br>model score ${Number(p.score).toFixed(2)}<br>` +
    `obs ${p.observations} · food ${p.foodReports} · chatter ${p.chatter}<br>` +
    muted("modelled — not a position"));
  hover("chatter-bloom", (p) =>
    `<b>${esc(p.zone)}</b><br>${p.mentions} posts mention this place<br>` +
    muted("posting density — NOT Jimothy's position"));
  hover("wildlife-pt", (p) =>
    `<b>Raccoon observation</b><br>${esc(p.zone || "Ballard")} · ${fmtAge(Number(p.ts))} ago` +
    `${p.quality ? ` · ${esc(p.quality)}` : ""}` +
    `${p.hit ? `<br><b style="color:${C.bad}">RECOGNITION HIT</b>` : ""}<br>` +
    muted("any individual — not necessarily Jimothy"));

  map.on("click", "territory-fill", (e) => {
    const z = e.features?.[0]?.properties?.zone;
    if (z) openZoneDossier(z);
  });
  // Clicking a camera pin selects it in the camera panel and scrolls to it.
  map.on("click", "cam-pt", (e) => {
    const p = e.features?.[0]?.properties;
    if (!p) return;
    camView = "single";
    camType = "street";
    camId = p.id;
    camRenderedFor = null;
    renderCams(STATE);
    $("camStage").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  for (const box of ["lyTerritory", "lyChatter", "lyWildlife", "lyWaste", "lyCams"]) {
    $(box).addEventListener("change", () => applyScope());
  }
}

const vis = (l, on) => map.setLayoutProperty(l, "visibility", on ? "visible" : "none");

/** Hick's Law: one switch moves camera, layers, side list and caption together. */
function applyScope(instant = false) {
  if (!mapReady) return;
  const wide = scope === "seattle";

  vis("territory-fill", $("lyTerritory").checked);
  vis("chatter-bloom", $("lyChatter").checked);
  vis("wildlife-pt", $("lyWildlife").checked);
  vis("wildlife-halo", $("lyWildlife").checked);
  vis("waste-pt", $("lyWaste").checked);
  vis("cam-pt", $("lyCams").checked);

  $("scopeBallard").classList.toggle("is-on", !wide);
  $("scopeSeattle").classList.toggle("is-on", wide);
  $("scopeBallard").setAttribute("aria-selected", String(!wide));
  $("scopeSeattle").setAttribute("aria-selected", String(wide));

  const cam = wide
    ? { center: [-122.3421, 47.6205], zoom: 10.6 }   // Seattle / Puget Sound
    : { center: BALLARD, zoom: 13.3 };
  if (instant) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 1100 });

  $("mapnote").innerHTML =
    `<strong>Amber</strong> modelled territory · <strong style="color:${C.signal}">cyan</strong> real raccoon GPS
     (any individual) · <strong style="color:${C.chatter}">violet</strong> chatter, never a position ·
     <strong style="color:${C.cam}">▣</strong> SDOT street camera.`;

  renderSide();
  renderOverlay();
}

function paint() {
  if (!mapReady) return;
  const s = STATE;
  map.getSource("cams").setData(fc((s.cams?.traffic || []).map((c) =>
    pt(c.lon, c.lat, { id: c.id, name: c.name, km: c.km, ok: Boolean(c.ok) }))));
  map.getSource("territory").setData(fc((s.zones || []).map((z) =>
    pt(z.lon, z.lat, { zone: z.zone, score: z.score, observations: z.observations,
      foodReports: z.foodReports, chatter: z.chatter }))));
  map.getSource("chatter").setData(fc((s.heat || []).map((h) =>
    pt(h.lon, h.lat, { zone: h.zone, intensity: h.intensity, mentions: h.mentions }))));
  map.getSource("wildlife").setData(fc((s.wildlife || []).map((w) =>
    pt(w.lon, w.lat, { zone: w.zone || "", ts: w.ts || 0, quality: w.quality || "",
      hit: w.recognition?.status === "CONSISTENT_WITH_JIMOTHY" }))));
  map.getSource("waste").setData(fc((s.civic?.waste || []).map((w) => pt(w.lon, w.lat, {}))));
  renderSide();
  renderOverlay();
}

function renderOverlay() {
  if (!STATE) return;
  const s = STATE;
  $("mapover").innerHTML =
    `<b>${s.totals?.observations ?? 0}</b> raccoon GPS fixes<br>
     <b>${s.cams?.trafficLive ?? 0}</b> street cameras live<br>
     <b>${(s.civic?.waste || []).length}</b> waste reports<br>
     <b>${s.zones?.length ?? 0}</b> zones modelled`;
}

/** Side list mirrors the map scope — Law of Proximity: the list is the legend. */
function renderSide() {
  if (!STATE) return;
  const el = $("sidePanel");
  if (scope === "seattle") {
    const cams = STATE.cams?.traffic || [];
    el.innerHTML = `<div class="sidehead">SDOT STREET CAMERAS · ${cams.length}</div>` +
      cams.map((c) => `
        <div class="srow" data-cam="${esc(c.id)}" data-lat="${c.lat}" data-lon="${c.lon}">
          <span class="scc" style="background:${c.ok ? C.cam : "#31424e"};color:#070a0d">${c.ok ? "ON" : "—"}</span>
          <span class="sname">${esc(c.name)}</span>
          <span class="sval">${c.km.toFixed(1)}km</span>
        </div>`).join("");
    for (const row of el.querySelectorAll(".srow")) {
      row.addEventListener("click", () => {
        camType = "street"; camId = row.dataset.cam; renderCams(STATE);
        map.flyTo({ center: [+row.dataset.lon, +row.dataset.lat], zoom: 15.6, duration: 800 });
      });
    }
  } else {
    const rows = STATE.zones || [];
    el.innerHTML = `<div class="sidehead">TERRITORY · ${rows.length} ZONES</div>` +
      rows.map((z) => `
        <div class="srow" data-zone="${esc(z.zone)}">
          <span class="sname">${esc(z.zone)}</span>
          <span class="sval" style="color:${C.accent}">${z.score.toFixed(2)}</span>
        </div>`).join("");
    for (const row of el.querySelectorAll(".srow")) {
      row.addEventListener("click", () => openZoneDossier(row.dataset.zone));
    }
  }
}


$("scopeBallard").addEventListener("click", () => { scope = "ballard"; applyScope(); });
$("scopeSeattle").addEventListener("click", () => { scope = "seattle"; applyScope(); });

/* ── carousel ───────────────────────────────────────────────────────── */
let slides = [], cIdx = 0, cTimer = null, cStart = 0, cPaused = false;
const C_MS = 7000;

function renderCarousel(list) {
  const same = list.length === slides.length &&
    list.every((s, i) => s.headline === slides[i]?.headline);
  slides = list;
  if (!slides.length) return;
  cIdx = Math.min(cIdx, slides.length - 1);
  paintSlide();
  if (!same) restart();   // don't restart the rotation on every poll
}

// The premise headline's key phrase carries the accent — Von Restorff.
const accentise = (h) =>
  esc(h).replace("Washingtonian of the Day", "<em>Washingtonian of the Day</em>");

function paintSlide() {
  const s = slides[cIdx];
  if (!s) return;
  const el = $("cfeat");

  // The whole strip row is the link target (Fitts's Law).
  if (s.url) { el.href = s.url; el.removeAttribute("aria-disabled"); }
  else { el.removeAttribute("href"); el.setAttribute("aria-disabled", "true"); }

  el.innerHTML = `
    <span class="ceyebrow">${esc(s.eyebrow || "")}</span>
    <span class="chead">${s.accent ? accentise(s.headline) : esc(s.headline)}</span>
    ${s.url ? `<span class="go">READ ↗</span>` : ""}`;

  // Retrigger the slide-in so each headline visibly arrives.
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";

  $("hcount").textContent = `${cIdx + 1}/${slides.length}`;
}

function go(i) {
  if (!slides.length) return;
  cIdx = (i + slides.length) % slides.length;
  paintSlide();
  restart();
}

/* ── proximity gauge ────────────────────────────────────────────────── */
const RING = 2 * Math.PI * 84;

function renderGauge(p) {
  if (!p) return;
  $("gnum").textContent = p.score;
  $("gfill").style.strokeDashoffset = String(RING * (1 - p.score / 100));
  // Colour tracks meaning: cold when there is no trail, warm as evidence builds.
  const col = p.score >= 50 ? C.ok : p.score >= 25 ? C.accent : p.score >= 10 ? "#d98040" : "#5b6c76";
  $("gfill").style.stroke = col;
  $("gfill").style.filter = `drop-shadow(0 0 9px ${col}80)`;
  $("gverdict").textContent = p.verdict;
  $("gbars").innerHTML = (p.components || []).map((c) => `
    <div class="gb" title="${esc(c.detail)}">
      <span class="gbl">${esc(c.label)}</span>
      <span class="gbv">${c.value}/${c.max}</span>
      <span class="gbt"><i style="width:${(c.value / c.max) * 100}%"></i></span>
      <span class="gbd">${esc(c.detail)}</span>
    </div>`).join("");
  $("gnote").textContent = p.note || "";
}

function restart() {
  cStart = performance.now();
  if (!cTimer) cTimer = requestAnimationFrame(tickCarousel);
}

function tickCarousel(now) {
  cTimer = requestAnimationFrame(tickCarousel);
  if (cPaused) { cStart = now - 0; $("cbar").style.width = "0%"; return; }
  const p = Math.min(1, (now - cStart) / C_MS);
  $("cbar").style.width = `${p * 100}%`;
  if (p >= 1) go(cIdx + 1);
}

$("cPrev").addEventListener("click", () => go(cIdx - 1));
$("cNext").addEventListener("click", () => go(cIdx + 1));
// Respect intent: stop advancing while the reader is engaged.
$("carousel").addEventListener("mouseenter", () => (cPaused = true));
$("carousel").addEventListener("mouseleave", () => (cPaused = false));
$("carousel").addEventListener("focusin", () => (cPaused = true));
$("carousel").addEventListener("focusout", () => (cPaused = false));

/* ── render ─────────────────────────────────────────────────────────── */
function render(s) {
  STATE = s;
  $("conn").textContent = "LIVE";
  $("conn").className = "pill ok";

  const ls = s.lastSighting;
  if (ls?.found) {
    const h = ls.ageMs / 3.6e6;
    $("lastSighting").textContent = h < 48 ? `${h.toFixed(1)}h AGO` : `${(h / 24).toFixed(1)}d AGO`;
    $("lastSightingSub").textContent = `${ls.band} · ${ls.zone} · ${ls.originCount} independent origins`;
  } else {
    $("lastSighting").textContent = "NONE ON RECORD";
    $("lastSightingSub").textContent = ls?.note || "Position unknown.";
  }

  const at = s.attention;
  $("attention").textContent = at ? at.score : "—";
  $("attentionBar").style.width = `${at?.score ?? 0}%`;
  $("attentionSub").textContent = at?.components?.find((c) => c.key === "wikipedia-en")?.detail || "—";

  const fg = s.foraging;
  $("foraging").textContent = fg ? fg.score : "—";
  $("foragingBar").style.width = `${fg?.score ?? 0}%`;
  $("foragingSub").textContent = fg?.components?.[0]?.detail || "—";

  const src = s.sources || {}, keys = Object.keys(src), up = keys.filter((k) => src[k].ok).length;
  $("srcUp").textContent = keys.length ? `${up}/${keys.length}` : "—";
  $("srcBar").style.width = keys.length ? `${(up / keys.length) * 100}%` : "0%";
  $("srcSub").textContent = `${(s.totals?.items ?? 0).toLocaleString()} items · cycle ${s.cycles}`;

  renderCarousel(s.stories || []);
  renderGauge(s.proximity);
  renderTicker(s);
  renderChips(s);
  renderFeed(s);
  renderTikTok(s);
  renderZones(s);
  renderRecognition(s);
  renderCams(s);
  renderEnv(s);
  renderAttention(s);
  renderLeads(s);
  renderLedger(s);
  renderHealth(s);
  paint();
}

function renderTicker(s) {
  $("ticker").innerHTML = [
    `<b>${s.totals?.jimothyMentions ?? 0}</b> mentions`,
    `<b>${s.totals?.observations ?? 0}</b> GPS fixes`,
    `<b>${s.zones?.[0]?.zone ?? "—"}</b> top territory`,
    `<b>${s.cams?.trafficLive ?? 0}</b> street cams`,
    `<b>${s.cams?.liveCount ?? 0}</b> cams live`,
    `updated <b>${fmtAge(s.updatedAt)}</b> ago`,
  ].join('<span class="sep">·</span>');
}

/* Law of Similarity: the chip colour IS the badge colour IS the platform. */
function renderChips(s) {
  const plats = (s.platforms || []).filter((p) => p.count > 0);
  $("chips").innerHTML = plats.map((p) => `
    <button class="chip ${platformFilter.has(p.key) ? "on" : ""}" data-k="${p.key}"
            style="${platformFilter.has(p.key) ? `color:${p.colour}` : ""}"
            aria-pressed="${platformFilter.has(p.key)}">
      <i style="background:${p.colour}"></i>${esc(p.label)}<span class="n">${p.count}</span>
    </button>`).join("");
  for (const b of $("chips").children) {
    b.addEventListener("click", () => {
      // Doherty: repaint immediately, no round trip.
      platformFilter.has(b.dataset.k) ? platformFilter.delete(b.dataset.k) : platformFilter.add(b.dataset.k);
      renderChips(STATE); renderFeed(STATE);
    });
  }
}

const platMeta = (k) => (STATE?.platforms || []).find((p) => p.key === k) || { label: k, colour: "#7d8f9a" };

function renderFeed(s) {
  const all = s.feed || [];
  const list = platformFilter.size ? all.filter((i) => platformFilter.has(i.platform)) : all;
  $("feedCount").textContent = `${list.length} shown · ${s.totals?.located ?? 0} located`;

  $("feed").innerHTML = list.length ? list.slice(0, 90).map((i) => {
    const p = platMeta(i.platform);
    return `
    <article class="fitem">
      <div class="frow">
        <span class="plat" style="color:${p.colour}"><i></i>${esc(p.label)}</span>
        <span class="band band-${esc(i.band)}">${esc(i.band)}</span>
        ${i.zone ? `<span class="fzone">▸ ${esc(i.zone)}</span>` : ""}
        <span class="fage">${fmtAge(i.ts)}</span>
      </div>
      <p class="ftitle">${i.url
        ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>`
        : esc(i.title)}</p>
      <p class="fsrc">${esc(i.source)}</p>
    </article>`;
  }).join("") : `<p class="empty">No items match this filter.</p>`;

  // Honest about what "live" means here — no keyless realtime stream exists.
  $("feednote").textContent =
    "Polled, not streamed — Mastodon 45s · Reddit 150s · news 240s. No public realtime socket exists for these platforms.";
}

/* ── tiktok ─────────────────────────────────────────────────────────── */
/* Nothing embeds until pressed. Each TikTok iframe pulls ~300KB of
   third-party assets, so the reader decides who gets embedded — one at a
   time. Poster frames come from our own cache (/api/tikthumb): TikTok's CDN
   thumbnail URLs are signed and die ~48h after issue, so hotlinking them
   would leave every card broken within two days. */
let ttPlaying = null;   // videoId of the card currently embedded, if any

const TT_STATUS = {
  CONSISTENT_WITH_JIMOTHY: { label: "CONSISTENT W/ JIMOTHY", cls: "tts-hit" },
  RACCOON_NOT_JIMOTHY:     { label: "RACCOON · NOT HIM",     cls: "tts-no" },
  NOT_RACCOON:             { label: "NOT A RACCOON",         cls: "tts-no" },
  BUDGET_CAPPED:           { label: "QUEUED",                cls: "tts-wait" },
  UNSCORED:                { label: "UNSCORED",              cls: "tts-wait" },
  ERROR:                   { label: "UNSCORED",              cls: "tts-wait" },
};

function renderTikTok(s) {
  const list = s.tiktok || [];
  const hits = list.filter((t) => t.recognition?.status === "CONSISTENT_WITH_JIMOTHY").length;
  $("ttCount").textContent = list.length
    ? `${list.length} videos${hits ? ` · ${hits} consistent` : ""}`
    : "—";

  // Never clobber a playing embed on a state push — same rule as the camera
  // stage. Counts above stay live; cards repaint after the reader closes it
  // (✕ button or Escape).
  if (ttPlaying) return;

  $("tiktok").innerHTML = list.length ? list.map((t) => {
    const st = (t.recognition && TT_STATUS[t.recognition.status]) || TT_STATUS.UNSCORED;
    return `
    <article class="ttcard" data-id="${esc(t.id)}">
      <button class="ttthumb" data-id="${esc(t.id)}" aria-label="Play TikTok by @${esc(t.author || "unknown")}">
        ${t.thumb ? `<img src="${API}${esc(t.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}
        <span class="ttbadge ${st.cls}">${st.label}</span>
        <span class="ttplay" aria-hidden="true">▶</span>
      </button>
      <p class="ttmeta"><b>@${esc(t.author || "unknown")}</b> · ${fmtAge(t.ts)}${
        t.zone ? ` · ▸ ${esc(t.zone)}` : ""} ·
        <a href="${esc(t.url)}" target="_blank" rel="noopener">open ↗</a></p>
      ${t.title ? `<p class="tttitle">${esc(t.title)}</p>` : ""}
      ${t.recognition?.reasoning ? `<p class="ttwhy"><b>vision:</b> ${esc(t.recognition.reasoning)}</p>` : ""}
    </article>`;
  }).join("") : `<p class="empty">No TikTok videos discovered yet. Links are harvested from Bluesky,
    Reddit, Mastodon and news items as they appear — TikTok itself offers no public search.</p>`;

  for (const b of $("tiktok").querySelectorAll(".ttthumb")) {
    b.addEventListener("click", () => playTikTok(b.dataset.id));
  }

  $("ttNote").innerHTML = list.length
    ? `Playback is TikTok's own embedded player, loaded only when you press play.
       A verdict applies to the <em>poster frame</em>, not every frame of the video.`
    : "";
}

function playTikTok(id) {
  if (!id || ttPlaying === id) return;
  if (ttPlaying) {
    // One embed at a time: repaint (which restores the old card's poster),
    // then promote this one.
    ttPlaying = null;
    renderTikTok(STATE);
  }
  const host = $("tiktok").querySelector(`.ttthumb[data-id="${id}"]`);
  if (!host) return;
  ttPlaying = id;
  // Swap the <button> for a plain container — an iframe inside a button is
  // invalid HTML and hostile to keyboard and screen-reader users — and give
  // the embed an explicit close control, or the first click would freeze this
  // panel for the rest of the visit.
  const wrap = document.createElement("div");
  wrap.className = "ttthumb playing";
  wrap.innerHTML = `<iframe src="https://www.tiktok.com/embed/v2/${encodeURIComponent(id)}"
    title="TikTok video" loading="lazy"
    allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
    <button class="ttclose" aria-label="Close video">✕</button>`;
  host.replaceWith(wrap);
  wrap.querySelector(".ttclose")?.addEventListener("click", stopTikTok);
  wrap.querySelector(".ttclose")?.focus();
}

/** Close the playing embed and let the panel repaint. Also bound to Escape. */
function stopTikTok() {
  if (!ttPlaying) return;
  ttPlaying = null;
  if (STATE) renderTikTok(STATE);
}

function renderZones(s) {
  $("zones").innerHTML = (s.zones || []).map((r) => `
    <div class="zrow" data-zone="${esc(r.zone)}" tabindex="0">
      <span class="zname">${esc(r.zone)}</span>
      <span class="zscore">${r.score.toFixed(2)}</span>
      <span class="zbar"><i style="width:${Math.round(r.score * 100)}%"></i></span>
      <span class="zstat">${r.observations} obs · ${r.foodReports} food · ${r.chatter} posts</span>
    </div>`).join("");
  for (const el of $("zones").children) {
    el.addEventListener("click", () => openZoneDossier(el.dataset.zone));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") openZoneDossier(el.dataset.zone); });
  }
}

function renderRecognition(s) {
  const v = s.vision || {}, badge = $("visionStatus");
  if (v.enabled) {
    badge.textContent = s.visionSpend ? `${v.provider.toUpperCase()} · ${s.visionSpend.usedToday} TODAY` : v.provider.toUpperCase();
    badge.className = "pill ok";
  } else { badge.textContent = "NO VISION KEY"; badge.className = "pill"; }

  // Live camera watch status — says plainly why nothing is being scored, which
  // is usually "it is daylight" or "nothing in frame changed".
  const w = s.camWatch;
  $("camWatchLine").innerHTML = !w
    ? ""
    : `<span class="wdot ${w.night ? "on" : ""}"></span>` +
      (w.night
        ? `Watching <b>${w.checked}</b> street cams · <b>${w.framesToday}</b> frames scored today ·
           ${w.framesRemaining} left · skipped ${w.skipped.notModified} unchanged, ${w.skipped.static} static`
        : `Daylight — street-cam watch sleeps until civil dusk. Raccoons are crepuscular.`);

  const r = s.recognition || [];
  $("recognition").innerHTML = r.length ? r.slice(0, 24).map((x) => `
    <div class="ritem${x.kind === "camera" ? " is-cam" : ""}">
      <img class="rthumb" src="${esc(String(x.imageUrl || "").startsWith("/") ? API + x.imageUrl : x.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="rbody">
        <span class="rstat rs-${esc(x.status)}">${esc(x.status.replace(/_/g, " "))}</span>
        ${x.kind === "camera" ? `<span class="rkind">LIVE CAM</span>` : ""}
        <p class="rreason">${esc(x.reasoning || "—")}</p>
        <p class="rmeta">${esc(x.itemSource || "")}${x.km != null ? ` · ${Number(x.km).toFixed(2)}km` : ""}${x.confidence != null ? ` · confidence ${x.confidence.toFixed(2)}` : ""}${x.torsoRatio ? ` · torso ${esc(x.torsoRatio)}` : ""}</p>
      </div>
    </div>`).join("")
    : `<p class="empty">${v.enabled ? "No images scored yet." :
        "Idle — no vision API key configured. Images are being collected now and will be scored, once, when a key is set."}</p>`;
}

/* -- camera wall ---------------------------------------------------- */
/* One tile at a time was the wrong shape for the thing people came to look at.
   The wall shows every camera at once; the stage promotes one. */

let hls = null;               // active Hls.js instance, torn down on switch
let videoOn = false;          // is the focused tile playing HLS rather than stills
const tileTimers = new Map(); // camId -> interval for that tile's still

function stopCamRefresh() {
  if (camTick) { clearInterval(camTick); camTick = null; }
}
function stopAllTiles() {
  for (const t of tileTimers.values()) clearInterval(t);
  tileTimers.clear();
}
function stopVideo() {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  videoOn = false;
}

/** Freshness colour against SDOT's measured ~5-minute publish cadence. */
const ageClass = (ms) =>
  ms == null ? "age-cold" : ms < 300000 ? "age-fresh" : ms < 900000 ? "age-warm" : "age-cold";

function stopTape() {
  if (tapeTimer) { clearInterval(tapeTimer); tapeTimer = null; }
  const b = $("tapePlay");
  if (b) b.classList.remove("playing");
}

/** Wall: every serving camera at once, one shared refresh timer. */
function renderWall(s) {
  const street = s.cams?.traffic || [];
  const wall = $("camWall");
  wall.hidden = false;
  $("camSwitch").hidden = true;
  $("camStage").hidden = true;
  $("tapeBar").hidden = true;

  if (camRenderedFor !== "wall") {
    camRenderedFor = "wall";
    stopCamRefresh();
    wall.innerHTML = street.map((c) => `
      <button class="camtile" data-id="${esc(c.id)}" title="${esc(c.name)} — click for playback">
        <img alt="${esc(c.name)}" data-src="${esc(c.url)}">
        <span class="km">${c.km.toFixed(1)}km</span>
        <b>${esc(c.name)}</b>
      </button>`).join("");
    for (const t of wall.children) {
      t.addEventListener("click", () => {
        camType = "street"; camId = t.dataset.id; camView = "single"; renderCams(STATE);
        $("camStage").scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    // One timer for all nine tiles, at SDOT's own cadence rather than faster.
    const tick = () => {
      const stamp = Date.now();
      for (const img of wall.querySelectorAll("img")) img.src = `${img.dataset.src}?t=${stamp}`;
    };
    tick();
    camTick = setInterval(tick, 15000);
  }

  const newest = Math.max(0, ...street.map((c) => c.frameAt || 0));
  $("camNote").innerHTML =
    `<strong style="color:var(--text2)">${street.length} SDOT street cameras</strong> across Ballard —
     newest frame ${newest ? fmtAge(newest) : "—"} ago. Click any tile for time-lapse playback.
     <span style="color:var(--dimmer)">SDOT publishes roughly every 5 minutes; these tiles refresh every 15s.</span>`;
  $("camCount").textContent = `${s.cams?.trafficLive ?? 0}/${street.length} street · ${s.cams?.wildlifeLive ?? 0}/${(s.cams?.wildlife || []).length} wildlife`;
}

function renderCams(s) {
  if (!s) return;
  const street = s.cams?.traffic || [];
  const wild = s.cams?.wildlife || [];

  $("ctabWall").classList.toggle("is-on", camView === "wall");
  $("ctabStreet").classList.toggle("is-on", camView === "single");
  $("ctabWild").classList.toggle("is-on", camView === "wildlife");

  if (camView === "wall") { stopTape(); return renderWall(s); }

  $("camWall").hidden = true;
  $("camSwitch").hidden = false;
  $("camStage").hidden = false;

  const list = camView === "single" ? street : wild;
  $("camCount").textContent =
    `${s.cams?.trafficLive ?? 0}/${street.length} street · ${s.cams?.trafficHls ?? 0} video · ` +
    `${s.cams?.wildlifeLive ?? 0}/${wild.length} wildlife`;

  if (!list.length) { $("camStage").innerHTML = `<p class="camoff">No cameras configured.</p>`; return; }
  if (!camId || !list.some((c) => c.id === camId)) camId = (list.find((c) => c.live) || list[0]).id;

  for (const b of $("camWall").children) {
    b.addEventListener("click", () => {
      if (b.dataset.id === camId) return;
      camId = b.dataset.id; stopVideo(); renderCams(STATE);
    });
  }

  // Each tile refreshes its own still, and the whole wall pauses when the tab
  // is hidden. The quantised cache-buster lets the browser share one fetch
  // between a tile and the stage instead of downloading the frame twice.
  stopAllTiles();
  if (camType === "street") {
    for (const img of $("camWall").querySelectorAll("img[data-cam]")) {
      const cam = street.find((c) => c.id === img.dataset.cam);
      if (!cam?.ok) continue;
      const tick = () => {
        if (document.hidden) return;
        img.src = `${cam.url}?t=${Math.floor(Date.now() / 30000)}`;
      };
      tick();
      tileTimers.set(cam.id, setInterval(tick, 30000));
    }
  }

  const cam = list.find((c) => c.id === camId);
  const key = `${camView}:${cam.id}`;
  if (camRenderedFor !== key) { stopCamRefresh(); stopTape(); }

  if (cam.kind === "traffic") {
    const tape = s.camTape?.[cam.id];
    $("tapeBar").hidden = !(tape && tape.count > 1);

    if (!cam.ok) {
      camRenderedFor = key;
      $("camStage").innerHTML = `<div class="camoff"><b>${esc(cam.name)}</b>
        SDOT is not currently serving this camera.<br>
        <a href="${esc(cam.url)}" target="_blank" rel="noopener">Open the image directly &#8599;</a></div>`;
    } else if (camRenderedFor !== key) {
      // Rebuild ONLY on selection change. Doing it every state push made each
      // viewer re-download an 80KB JPEG every ~2.5s for a frame that changes
      // every five minutes.
      camRenderedFor = key;
      $("camStage").innerHTML = `<img id="camImg" class="camimg" alt="${esc(cam.name)} street camera">`;
      const tick = () => { const el = $("camImg"); if (el && !tapeTimer) el.src = `${cam.url}?t=${Date.now()}`; };
      tick();
      camTick = setInterval(tick, 8000);
      if (cam.hls) $("camLive").addEventListener("click", () => toggleVideo(cam));
    }

    if (tape && tape.count > 1) {
      const scrub = $("tapeScrub");
      scrub.max = String(tape.count - 1);
      if (!tapeTimer) scrub.value = String(tape.count - 1);
      const f = tape.frames[Number(scrub.value)] || tape.frames.at(-1);
      const span = tape.frames.at(-1).at - tape.frames[0].at;
      $("tapeMeta").textContent =
        `${Number(scrub.value) + 1}/${tape.count} · ${f ? fmtAge(f.at) : "—"} ago · spans ${Math.round(span / 60000)}min`;
    }

    const age = cam.frameAt ? fmtAge(cam.frameAt) : null;
    $("camNote").innerHTML =
      `<strong style="color:var(--text2)">${esc(cam.name)}</strong> · SDOT · ${cam.km.toFixed(2)}km from Ballard centre${cam.note ? ` · ${esc(cam.note)}` : ""}<br>
       <span style="color:var(--dimmer)">${age ? `Frame published <b style="color:var(--text2)">${age} ago</b>. ` : ""}SDOT publishes roughly every 5 minutes. ${tape && tape.count > 1 ? `${tape.count} frames recorded — press play for time-lapse.` : "Recording frames for time-lapse…"}</span>`;
    return;
  }

  $("tapeBar").hidden = true;

  // Area camera — a public outdoor still from a non-YouTube operator (UW
  // Atmospheric Sciences, Seattle Pacific). The server already resolved it to a
  // concrete, cache-busted, currently-valid URL, because neither is a stable
  // link: UW needs a two-step lookup and caches for 48h, SPU 403s a bare
  // User-Agent and caches for 24h. So the client stays a plain <img>.
  if (cam.kind === "area") {
    if (camRenderedFor !== key) {
      camRenderedFor = key;
      $("camStage").innerHTML = cam.url
        ? `<img class="camimg" src="${esc(cam.url)}" alt="${esc(cam.name)}">`
        : `<div class="camoff"><b>${esc(cam.name)}</b>
             ${esc(cam.where)}<br>Not reachable right now${cam.error ? ` — ${esc(cam.error)}` : ""}.</div>`;
    }
    $("camNote").innerHTML =
      `<strong style="color:var(--text2)">${esc(cam.name)}</strong> · ${esc(cam.where)}` +
      `${cam.km != null ? ` · ${cam.km.toFixed(1)}km from Ballard centre` : ""}<br>` +
      `<span style="color:var(--dimmer)">${esc(cam.note || "")}` +
      `${cam.frameAt ? ` · frame ${fmtAge(cam.frameAt)} old` : ""}. ` +
      `Courtesy of <b style="color:var(--text2)">${esc(cam.attribution || cam.operator || "")}</b>.</span>`;
    return;
  }

  // Wildlife stream. Embed ONLY when the server confirmed, against the video's
  // own watch page, both that it is broadcasting and who owns it — the caption
  // uses the owner it read, never our own configured label.
  //
  // `showable` was lost in a stash merge: the two lines below referenced it
  // while the declaration had been replaced by an unused `unverified`, so
  // opening this tab threw a ReferenceError.
  const showable = cam.live && cam.verified;
  if (camRenderedFor !== key) {
    camRenderedFor = key;
    $("camStage").innerHTML = showable
      ? `<iframe src="${esc(cam.embed)}" title="${esc(cam.title || cam.name)}"
           allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
      : `<div class="camoff"><b>${esc(cam.name)} is not broadcasting</b>
           ${esc(cam.where)}${cam.note ? ` · ${esc(cam.note)}` : ""}<br>
           Checked ${fmtAge(s.cams.checkedAt)} ago — switches on by itself when the stream starts.<br>
           <a href="${esc(cam.url)}" target="_blank" rel="noopener">Open the channel &#8599;</a></div>`;
  }
  $("camNote").innerHTML = showable
    ? `<strong style="color:var(--text2)">${esc(cam.title || cam.name)}</strong> · ${esc(cam.where)}` +
      `${cam.note ? ` · ${esc(cam.note)}` : ""}<br>` +
      `<span style="color:var(--dimmer)">Broadcast by <b style="color:var(--text2)">${esc(cam.owner)}</b> —
       identity confirmed against the video page, not assumed from our configuration.</span>`
    : `<strong style="color:var(--text2)">${esc(cam.name)}</strong> · ${esc(cam.where)} —
       <span style="color:var(--dimmer)">not currently broadcasting${cam.ended ? " (stream has ended)" : ""}.</span>`;
}

/**
 * Live video on the focused tile.
 *
 * Safari plays HLS natively. Everything else needs a remuxer, so hls.js is
 * loaded lazily from our own origin and ONLY on click - no viewer pays 85KB
 * for a button they never press. Never autoplays: at ~2 Mbps this is 0.9 GB an
 * hour and that has to be the viewer's decision.
 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Hls) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(el);
  });
}

async function toggleVideo(cam) {
  if (videoOn) { stopVideo(); camRenderedFor = null; renderCams(STATE); return; }

  const stage = $("camStage");
  const btn = $("camLive");
  const img = $("camImg");
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.controls = true;
  video.setAttribute("aria-label", `${cam.name} live video`);

  const fail = (why) => {
    stopVideo();
    video.remove();
    if (img) img.style.display = "";
    if (btn) { btn.classList.remove("on"); btn.innerHTML = `<i></i>LIVE VIDEO`; }
    $("camNote").innerHTML =
      `<span style="color:var(--bad)">Live video unavailable in this browser — ${esc(why)}.</span>
       <a href="${esc(cam.hls)}" target="_blank" rel="noopener">Open the stream directly &#8599;</a>`;
  };

  if (img) img.style.display = "none";
  stage.insertBefore(video, stage.firstChild);
  videoOn = true;
  if (btn) { btn.classList.add("on"); btn.innerHTML = `<i></i>LIVE · STOP`; }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = cam.hls;                       // Safari / iOS, no library needed
    video.addEventListener("error", () => fail("the stream did not load"));
  } else {
    try {
      await loadScript("vendor/hls.light.min.js");
    } catch {
      return fail("the video player could not be loaded");
    }
    if (!window.Hls?.isSupported()) return fail("Media Source Extensions are unavailable");
    hls = new window.Hls({ liveDurationInfinity: true });
    hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d?.fatal) fail("the stream stopped"); });
    hls.loadSource(cam.hls);
    hls.attachMedia(video);
  }
  video.play().catch(() => { /* a blocked autoplay still leaves working controls */ });
  $("camNote").innerHTML =
    `<strong style="color:var(--text2)">${esc(cam.name)}</strong> · SDOT ·
     <b style="color:var(--bad)">LIVE VIDEO</b> ${esc(cam.hlsResolution || "")} —
     <span style="color:var(--dimmer)">HLS, roughly 25s behind real time. Recognition still runs
     on the stills: decoding video needs a codec this project does not ship, so the model never
     sees these frames.</span>`;
}

/* Time-lapse: real recorded frames from the server tape, played in sequence.
   This is the only honest way to get motion out of a still camera. */
function showFrame(i) {
  const img = $("camImg");
  const tape = STATE?.camTape?.[camId];
  if (!img || !tape || !tape.count) return;
  const idx = Math.max(0, Math.min(tape.count - 1, i));
  img.src = `${API}/api/camframe/${encodeURIComponent(camId)}/${idx}`;
  $("tapeScrub").value = String(idx);
  const f = tape.frames[idx];
  const span = tape.frames.at(-1).at - tape.frames[0].at;
  $("tapeMeta").textContent = `${idx + 1}/${tape.count} · ${f ? fmtAge(f.at) : "—"} ago · spans ${Math.round(span / 60000)}min`;
}

$("tapePlay").addEventListener("click", () => {
  if (tapeTimer) { stopTape(); return; }
  const tape = STATE?.camTape?.[camId];
  if (!tape || tape.count < 2) return;
  let i = 0;
  $("tapePlay").classList.add("playing");
  showFrame(i);
  tapeTimer = setInterval(() => {
    i = (i + 1) % tape.count;
    showFrame(i);
  }, 450);
});

$("tapeScrub").addEventListener("input", (e) => { stopTape(); showFrame(Number(e.target.value)); });

$("ctabWall").addEventListener("click", () => { camView = "wall"; camRenderedFor = null; renderCams(STATE); });
$("ctabStreet").addEventListener("click", () => { camView = "single"; camType = "street"; camId = null; camRenderedFor = null; renderCams(STATE); });
$("ctabWild").addEventListener("click", () => { camView = "wildlife"; camType = "wildlife"; camId = null; camRenderedFor = null; renderCams(STATE); });


/* ── environment ────────────────────────────────────────────────────── */
/* Weather, tide and civil twilight were fetched every cycle and rendered
   NOWHERE — zero references in the whole frontend — for an animal whose entire
   activity pattern is governed by them. This is also the page's heartbeat: the
   dusk countdown is real astronomy on a timestamp we already hold, so it can
   tick every second without anything being invented. */

const fmtCountdown = (ms) => {
  if (ms == null || !isFinite(ms)) return "—";
  const neg = ms < 0;
  const t = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return `${neg ? "+" : ""}${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
};
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

/** Where "now" sits between dusk and dawn, 0..1, for the twilight band. */
function nightProgress(sun, now = Date.now()) {
  if (!sun?.civilTwilightEnd || !sun?.civilTwilightBegin) return null;
  const DAY = 86400000;
  const dusk = sun.civilTwilightEnd, dawn = sun.civilTwilightBegin;
  const t = ((now - dusk) % DAY + DAY) % DAY;
  const len = ((dawn - dusk) % DAY + DAY) % DAY;
  return t <= len ? { inNight: true, frac: t / len } : { inNight: false, frac: null };
}

function renderEnv(s) {
  const c = s.conditions;
  const el = $("env");
  if (!c || (!c.sun && !c.weather && !c.tide)) {
    el.innerHTML = `<p class="empty">No environmental data yet.</p>`;
    return;
  }
  const sun = c.sun || {}, w = c.weather || {}, tide = c.tide || {};
  const np = nightProgress(sun);
  const rain = (w.precipLastHourMm ?? 0) > 0.2;

  const rows = [];

  // The countdown is the loud one. `data-dusk` lets the 1Hz clock rewrite just
  // this node instead of re-rendering the panel.
  rows.push(`
    <div class="ebig">
      <div class="ek">${np?.inNight ? "CIVIL DAWN IN" : "CIVIL DUSK IN"}</div>
      <div class="ev" id="envCountdown" data-dusk="${sun.civilTwilightEnd || 0}"
           data-dawn="${sun.civilTwilightBegin || 0}">—</div>
      <div class="ed">dusk ${hhmm(sun.civilTwilightEnd)} · dawn ${hhmm(sun.civilTwilightBegin)} ·
        ${np?.inNight ? "foraging window OPEN" : "raccoons typically denned"}</div>
      <div class="enight"><i id="envMarker" style="left:${np?.inNight ? (np.frac * 100).toFixed(1) : 0}%"></i></div>
    </div>`);

  if (w.tempC != null || w.description) {
    rows.push(`
      <div class="erow">
        <span class="ek">WEATHER</span>
        <span class="ev">${w.tempC != null ? `${w.tempC.toFixed(1)}°C` : "—"}</span>
        <span class="ed">${esc(w.description || (rain ? "precipitation" : "dry"))}${
          rain ? ` · <b style="color:var(--bad)">rain suppresses foraging</b>` : ""}${
          w.windKph != null ? ` · wind ${w.windKph.toFixed(0)} km/h` : ""} ·
          NWS ${esc(w.station || "")} ${w.observedAt ? `· observed ${fmtAge(w.observedAt)} ago` : ""}</span>
      </div>`);
  }

  if (tide.now) {
    const range = (tide.high?.v ?? 1) - (tide.low?.v ?? 0) || 1;
    const rel = ((tide.now.v - (tide.low?.v ?? 0)) / range);
    rows.push(`
      <div class="erow">
        <span class="ek">TIDE · SHILSHOLE</span>
        <span class="ev">${tide.now.v.toFixed(1)}ft</span>
        <span class="ed">low ${tide.low?.v.toFixed(1)}ft · high ${tide.high?.v.toFixed(1)}ft ·
          ${rel < 0.4 ? "<b>low water — shoreline foraging open</b>" : "shoreline covered"} ·
          NOAA ${esc(tide.station || "")}</span>
      </div>`);
  }

  if (c.wasteCount != null) {
    rows.push(`
      <div class="erow">
        <span class="ek">FOOD · 311</span>
        <span class="ev">${c.wasteCount}</span>
        <span class="ed">waste and illegal-dumping reports in Ballard, last 30 days · Seattle Open Data</span>
      </div>`);
  }

  el.innerHTML = rows.join("");
  tickEnvClock();
}

/** 1Hz. Only rewrites two nodes, so it is cheap enough to run forever. */
function tickEnvClock() {
  const el = document.getElementById("envCountdown");
  if (!el) return;
  const dusk = Number(el.dataset.dusk) || 0;
  const dawn = Number(el.dataset.dawn) || 0;
  const np = nightProgress({ civilTwilightEnd: dusk, civilTwilightBegin: dawn });
  const DAY = 86400000;
  const target = np?.inNight ? dawn : dusk;
  let delta = target - Date.now();
  while (delta < 0) delta += DAY;
  el.textContent = fmtCountdown(delta);
  const marker = document.getElementById("envMarker");
  if (marker && np?.inNight) marker.style.left = `${(np.frac * 100).toFixed(2)}%`;
  const clk = $("envClock");
  if (clk) clk.textContent = np?.inNight ? "NIGHT" : "DAY";
}

/* ── world attention ────────────────────────────────────────────────── */
/* 31 days x 4 language editions were on the wire and collapsed into a single
   26-character caption. Inline SVG, no charting library. */

function sparkline(series) {
  if (!series || series.length < 2) return "";
  const vals = series.map((d) => d.views);
  const max = Math.max(...vals) || 1;
  const n = vals.length;
  const x = (i) => (i / (n - 1)) * 100;
  const y = (v) => 26 - (v / max) * 24;
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join("");
  const fill = `${line}L100,26L0,26Z`;
  return `<svg class="aspark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
    <path class="fill" d="${fill}"/><path d="${line}"/></svg>`;
}

function renderAttention(s) {
  const langs = s.wiki?.langs || [];
  const el = $("attn");
  const total = langs.reduce((a, l) => a + (l.latest || 0), 0);
  $("attnTotal").textContent = total ? `${total.toLocaleString()}/day` : "—";

  if (!langs.length) {
    el.innerHTML = `<p class="empty">No pageview data returned.</p>`;
    return;
  }

  el.innerHTML = langs
    .slice()
    .sort((a, b) => (b.latest || 0) - (a.latest || 0))
    .map((l) => `
      <div class="arow">
        <span class="alang">${esc(l.lang)}</span>
        <span class="aregion">${esc(l.region || "")}${l.stale ? " · last known" : ""}</span>
        <span class="aval">${(l.latest || 0).toLocaleString()}</span>
        ${sparkline(l.series)}
        <span class="aregion" style="grid-column:1/-1">peak ${(l.peak || 0).toLocaleString()}/day
          ${l.peak ? `· now ${Math.round((l.latest / l.peak) * 100)}% of peak` : ""}
          · <a href="${esc(l.url)}" target="_blank" rel="noopener">article ↗</a></span>
      </div>`).join("") +
    // Say plainly when a language failed rather than letting it vanish.
    ((s.wiki?.failures || []).length
      ? `<div class="arow"><span class="aregion" style="grid-column:1/-1; color:var(--bad)">
           No data returned for: ${(s.wiki.failures).map((f) => esc(f.lang)).join(", ")}.
           Wikimedia pageviews are batch-computed and lag 24–48h.</span></div>`
      : "");
}

/* ── located leads ──────────────────────────────────────────────────── */
/* The feed is 144 items; the ones that actually resolved to a place are a
   handful. They were indistinguishable from chatter in one long list. */

function renderLeads(s) {
  // Dedupe by link before ranking. The same post can legitimately arrive from
  // more than one query, and showing it twice reads as the panel repeating
  // itself. Keeps the highest-scoring copy.
  const seen = new Map();
  for (const i of (s.feed || []).filter((x) => x.zone)) {
    const k = String(i.url || i.title).replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    const prev = seen.get(k);
    if (!prev || (i.score ?? 0) > (prev.score ?? 0)) seen.set(k, i);
  }
  const leads = [...seen.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.ts || 0) - (a.ts || 0));
  $("leadCount").textContent = `${leads.length} with a zone`;

  $("leads").innerHTML = leads.length
    ? leads.slice(0, 40).map((i) => {
        const p = platMeta(i.platform);
        const why = (i.why || [])
          .filter((w) => w.w !== 0)
          .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
          .slice(0, 4)
          .map((w) => `<b>${esc(w.k)}</b> ${w.w > 0 ? "+" : ""}${w.w.toFixed(2)}`)
          .join(" · ");
        return `
        <article class="lrow">
          <span class="plat" style="color:${p.colour}"><i></i>${esc(p.label)}</span>
          <span class="lzone">▸ ${esc(i.zone)}</span>
          <span class="band band-${esc(i.band)}">${esc(i.band)}</span>
          <p class="ltitle">${i.url
            ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>`
            : esc(i.title)}</p>
          <p class="lmeta">${esc(i.source)} · ${fmtAge(i.ts)} ago · score ${(i.score ?? 0).toFixed(2)}</p>
          ${why ? `<p class="lwhy">${why}</p>` : ""}
        </article>`;
      }).join("")
    : `<p class="empty">Nothing has resolved to a zone yet. That is the normal state —
       almost no post about Jimothy contains a location.</p>`;
}

/* ── corroboration ledger ───────────────────────────────────────────── */
/* 34KB of cluster data per push, rendered nowhere. This is the actual
   intelligence product: promotion needs independent ORIGIN TYPES, not volume. */

function renderLedger(s) {
  const all = s.clusters || [];
  const need = 3;   // CORROBORATION.confirmed
  const promoted = all.filter((c) => c.band === "CONFIRMED" || c.band === "PROBABLE").length;

  // ONE ROW PER ZONE.
  //
  // cluster() buckets by space AND time, so a place with activity across
  // several days legitimately produces several clusters — Ballard Locks had
  // seven. Listing each one made the panel read as though it were repeating
  // itself. The zone is what the reader is tracking, so the zone is the row:
  // best band, best origin count, newest timestamp, and a count of the
  // separate occasions folded into it.
  const byZone = new Map();
  for (const c of all) {
    const z = byZone.get(c.zone);
    if (!z) { byZone.set(c.zone, { ...c, occasions: 1 }); continue; }
    z.occasions++;
    z.originCount = Math.max(z.originCount, c.originCount);
    z.topScore = Math.max(z.topScore, c.topScore);
    z.recognitionHits = (z.recognitionHits || 0) + (c.recognitionHits || 0);
    z.ts = Math.max(z.ts, c.ts);
    z.origins = [...new Set([...(z.origins || []), ...(c.origins || [])])];
    const rank = { CONFIRMED: 3, PROBABLE: 2, UNVERIFIED: 1, MENTION: 0 };
    if ((rank[c.band] ?? 0) > (rank[z.band] ?? 0)) z.band = c.band;
  }
  const cl = [...byZone.values()].sort((a, b) =>
    (b.originCount - a.originCount) || (b.topScore - a.topScore) || (b.ts - a.ts));

  $("ledger").innerHTML =
    (cl.length
      ? cl.slice(0, 24).map((c) => `
        <div class="ldrow">
          <span class="ldzone">${esc(c.zone)}</span>
          <span class="band band-${esc(c.band)}">${esc(c.band)}</span>
          <span class="ldpips">${Array.from({ length: need }, (_, i) =>
            `<span class="ldpip ${i < c.originCount ? "on" : ""}"></span>`).join("")}</span>
          <span class="ldmeta">${c.originCount} independent origin${c.originCount === 1 ? "" : "s"} ·
            ${esc((c.origins || []).join(", "))} · newest ${fmtAge(c.ts)} ago${
            c.occasions > 1 ? ` · ${c.occasions} separate occasions` : ""}${
            c.recognitionHits ? ` · <b style="color:var(--bad)">${c.recognitionHits} recognition hit</b>` : ""}</span>
        </div>`).join("")
      : `<p class="empty">No clusters yet.</p>`) +
    `<p class="ldnote"><b>${promoted}</b> of <b>${all.length}</b> clusters across
      <b>${cl.length}</b> zones reach PROBABLE or better.
      A cluster needs <b>${need}</b> independent origin types to be CONFIRMED —
      posting the same claim in five places is still one origin.</p>`;
}

function renderHealth(s) {
  const src = s.sources || {}, keys = Object.keys(src).sort();
  $("totals").textContent = `${s.totals?.observations ?? 0} GPS observations · ${s.totals?.baseline ?? 0} baseline`;
  $("health").innerHTML = keys.map((k) => {
    const v = src[k];
    return `<div class="hrow" title="${esc(v.error || `ok · last success ${fmtAge(v.lastOk)} ago`)}">
      <span class="dot ${v.ok ? "dot-ok" : "dot-bad"}"></span>
      <span class="hname">${esc(k)}</span>
      <span class="hms">${v.lastMs}ms</span>
    </div>`;
  }).join("");
}

/* ── dossier ────────────────────────────────────────────────────────── */
function openZoneDossier(zone) {
  const z = (STATE.zones || []).find((x) => x.zone === zone);
  if (!z) return;
  const heat = (STATE.heat || []).find((h) => h.zone === zone);
  const obs = (STATE.wildlife || []).filter((w) => w.zone === zone);
  $("dosBody").innerHTML = `
    <h3>${esc(zone)}</h3>
    <p class="thelp" style="margin:6px 0 0">Territory model score
      <b style="color:${C.accent}">${z.score.toFixed(2)}</b> — an estimate of where <em>a</em> Ballard
      raccoon is likely to be. Not a position for Jimothy.</p>
    <div class="doskv">
      <b>raccoon GPS observations</b><span>${z.observations}</span>
      <b>311 waste / food reports</b><span>${z.foodReports}</span>
      <b>posts mentioning this zone</b><span>${z.chatter}</span>
      <b>zone centroid</b><span>${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}</span>
    </div>
    ${obs.length ? `<h4>OBSERVATIONS · ${obs.length}</h4>` + obs.slice(0, 10).map((o) =>
      `<div class="doslink"><a href="${esc(o.url)}" target="_blank" rel="noopener">iNaturalist observation</a>
        · ${fmtAge(o.ts)} ago${o.quality ? ` · ${esc(o.quality)}` : ""}</div>`).join("") : ""}
    ${heat?.items?.length ? `<h4>POSTS · ${heat.items.length}</h4>` + heat.items.slice(0, 10).map((i) =>
      `<div class="doslink"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
        · ${esc(i.source)} · ${fmtAge(i.ts)} ago</div>`).join("") : ""}
    ${!obs.length && !heat?.items?.length ? `<p class="empty">No observations or posts recorded here yet.</p>` : ""}`;
  $("dossier").hidden = false;
}
$("dosClose").addEventListener("click", () => ($("dossier").hidden = true));
$("dossier").addEventListener("click", (e) => { if (e.target.id === "dossier") $("dossier").hidden = true; });

/* ── command palette ────────────────────────────────────────────────── */
let palItems = [], palSel = 0;

function buildPalette() {
  const jump = (id) => () => $(id).scrollIntoView({ behavior: "smooth", block: "center" });
  const toggle = (id) => () => { const b = $(id); b.checked = !b.checked; applyScope(); };
  palItems = [
    { kind: "scope", label: "Seattle wide view", run: () => { scope = "seattle"; applyScope(); } },
    ...(STATE?.cams?.traffic || []).map((c) => ({ kind: "camera", label: `${c.name} (SDOT)`, run: () => {
      camType = "street"; camId = c.id; renderCams(STATE);
      map.flyTo({ center: [c.lon, c.lat], zoom: 15.6, duration: 800 }); } })),
    { kind: "scope", label: "Ballard territory", run: () => { scope = "ballard"; applyScope(); } },
    ...(STATE?.zones || []).map((z) => ({ kind: "zone", label: z.zone, run: () => {
      scope = "ballard"; applyScope();
      map.flyTo({ center: [z.lon, z.lat], zoom: 15.4, duration: 900 }); openZoneDossier(z.zone); } })),
    ...(STATE?.cams?.wildlife || []).map((c) => ({ kind: "wildlife cam", label: `${c.name}${c.live ? " (live)" : ""}`,
      run: () => { camType = "wildlife"; camId = c.id; renderCams(STATE); jump("camStage")(); } })),
    ...(STATE?.platforms || []).filter((p) => p.count).map((p) => ({ kind: "filter", label: `Only ${p.label}`,
      run: () => { platformFilter = new Set([p.key]); renderChips(STATE); renderFeed(STATE); jump("feed")(); } })),
    { kind: "filter", label: "Clear feed filters", run: () => { platformFilter.clear(); renderChips(STATE); renderFeed(STATE); } },
    { kind: "panel", label: "Live feed", run: jump("feed") },
    { kind: "panel", label: "TikTok watch", run: jump("tiktokPanel") },
    { kind: "panel", label: "Recognition queue", run: jump("recognition") },
    { kind: "panel", label: "Wildlife cams", run: jump("camStage") },
    { kind: "panel", label: "Source health", run: jump("health") },
    { kind: "layer", label: "Toggle territory", run: toggle("lyTerritory") },
    { kind: "layer", label: "Toggle raccoon GPS", run: toggle("lyWildlife") },
    { kind: "layer", label: "Toggle chatter", run: toggle("lyChatter") },
    { kind: "layer", label: "Toggle waste 311", run: toggle("lyWaste") },
  ];
}

function paintPalette(q = "") {
  const rows = palItems.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  palSel = Math.min(palSel, Math.max(0, rows.length - 1));
  $("palList").innerHTML = rows.length
    ? rows.map((r, i) => `<div class="palrow ${i === palSel ? "sel" : ""}" data-i="${i}">
         <span class="palkind">${r.kind}</span><span>${esc(r.label)}</span></div>`).join("")
    : `<div class="palrow"><span class="palkind">—</span><span>no match</span></div>`;
  $("palList")._rows = rows;
  for (const el of $("palList").querySelectorAll(".palrow[data-i]"))
    el.addEventListener("click", () => { rows[+el.dataset.i].run(); closePalette(); });
}

function openPalette() {
  buildPalette(); palSel = 0;
  $("palette").hidden = false; $("palInput").value = ""; paintPalette(); $("palInput").focus();
}
const closePalette = () => ($("palette").hidden = true);

$("kbtn").addEventListener("click", openPalette);
$("palInput").addEventListener("input", (e) => { palSel = 0; paintPalette(e.target.value); });
$("palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if ($("palette").hidden) {
    if (e.key === "Escape") { $("dossier").hidden = true; stopTikTok(); }
    // Arrow keys drive the carousel when nothing is focused (Jakob's Law).
    if (e.target === document.body && e.key === "ArrowRight") go(cIdx + 1);
    if (e.target === document.body && e.key === "ArrowLeft") go(cIdx - 1);
    return;
  }
  const rows = $("palList")._rows || [];
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, rows.length - 1); paintPalette($("palInput").value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paintPalette($("palInput").value); }
  else if (e.key === "Enter") { rows[palSel]?.run(); closePalette(); }
});

/* ── live operations console ────────────────────────────────────────── */
const OPS_MAX = 140;
let opsStats = null;
const opsTimes = [];          // arrival times, for the real ops/min figure
let lastStatValues = {};

const hhmmss = (t) => new Date(t).toISOString().slice(11, 19);

function pushOps(events) {
  const con = $("opsConsole");
  if (!con || !events.length) return;

  const frag = document.createDocumentFragment();
  for (const ev of events) {
    opsTimes.push(ev.t || Date.now());
    const row = document.createElement("div");
    row.className = `opsline op-${ev.kind}`;
    row.innerHTML = `<span class="opst">${hhmmss(ev.t)}</span><span class="opsx">${esc(ev.text)}</span>`;
    frag.appendChild(row);
  }
  // Mirror the newest operation into the heartbeat strip.
  const newest = events[events.length - 1];
  if (newest) {
    const hb = $("hbLine");
    if (hb) hb.textContent = `${hhmmss(newest.t)}  ${newest.text}`;
  }

  // Newest at the top: the reader never has to chase the tail. Only snap to the
  // top when the reader was already there — otherwise the console yanks itself
  // away mid-read every time an operation lands.
  const pinned = con.scrollTop < 24;
  con.insertBefore(frag, con.firstChild);
  while (con.childElementCount > OPS_MAX) con.removeChild(con.lastChild);
  if (pinned) con.scrollTop = 0;
}

function renderOpsStats(s) {
  if (!s) return;
  opsStats = s;
  const cells = [
    ["FETCHES", s.fetches?.toLocaleString() ?? "0"],
    ["DATA PULLED", fmtBytes(s.bytes)],
    ["ITEMS SCANNED", s.extracted?.toLocaleString() ?? "0"],
    ["GEO MATCHES", s.geo?.toLocaleString() ?? "0"],
    ["FRAMES DIFFED", s.frames?.toLocaleString() ?? "0"],
    ["MODEL CALLS", s.visionCalls?.toLocaleString() ?? "0"],
    ["AVG MODEL", s.visionCalls ? `${Math.round(s.visionMs / s.visionCalls)}ms` : "—"],
    ["ACTIVE CLUSTERS", s.clusters?.toLocaleString() ?? "0"],
    ["PIPELINE PASSES", s.passes?.toLocaleString() ?? "0"],
  ];
  $("opsBar").innerHTML = cells.map(([k, v]) => `
    <div class="opsstat">
      <div class="opsk">${k}</div>
      <div class="opsv${lastStatValues[k] !== undefined && lastStatValues[k] !== v ? " tick" : ""}">${v}</div>
    </div>`).join("");
  for (const [k, v] of cells) lastStatValues[k] = v;
  // Drop the tick highlight shortly after, so it reads as a pulse not a state.
  setTimeout(() => document.querySelectorAll(".opsv.tick").forEach((e) => e.classList.remove("tick")), 700);
}

function fmtBytes(b) {
  if (!b) return "0B";
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)}MB`;
  return `${(b / 1073741824).toFixed(2)}GB`;
}

/** Real throughput: operations actually observed in the last 60 seconds. */
function tickOpsRate() {
  const cut = Date.now() - 60_000;
  while (opsTimes.length && opsTimes[0] < cut) opsTimes.shift();
  const el = $("opsRate");
  if (!el) return;
  const n = opsTimes.length;
  const label = n > 0 ? `${n} OPS/MIN` : "IDLE";
  el.classList.toggle("live", n > 0);
  el.querySelector("span").textContent = label;
  const hb = $("hbRate");
  if (hb) {
    hb.classList.toggle("live", n > 0);
    hb.querySelector("span").textContent = label;
  }
}

/* ── stream ─────────────────────────────────────────────────────────── */
// Same-origin by default. On Railway the runner serves both; on Vercel the
// rewrite in vercel.json proxies /api/* to Railway, so this stays same-origin
// either way and no CORS is involved.
const API = (window.JM_API || "").replace(/\/$/, "");

let sseFailures = 0, pollTimer = null;

function connect() {
  const es = new EventSource(`${API}/api/stream`);

  es.addEventListener("state", (e) => {
    sseFailures = 0;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    try {
      const s = JSON.parse(e.data);
      render(s);
      if (s.ops) renderOpsStats(s.ops);
    } catch (err) { console.error("state parse failed", err); }
  });

  // Backlog on connect, so the console is never an empty box.
  es.addEventListener("ops", (e) => {
    try {
      const { events, stats } = JSON.parse(e.data);
      pushOps((events || []).slice().reverse());
      renderOpsStats(stats);
    } catch (err) { console.error("ops backlog failed", err); }
  });

  // Individual operations, pushed the instant they happen.
  es.addEventListener("op", (e) => {
    try { pushOps([JSON.parse(e.data)]); } catch { /* one bad line is not fatal */ }
  });

  es.onerror = () => {
    $("conn").textContent = "RECONNECTING";
    $("conn").className = "pill bad";
    // Some CDN proxies buffer text/event-stream. After repeated failures stop
    // fighting it and poll instead — the dashboard keeps working either way.
    if (++sseFailures >= 3 && !pollTimer) {
      es.close();
      startPolling();
    }
  };
}

async function pollOnce() {
  try {
    const r = await fetch(`${API}/api/state`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
    $("conn").textContent = "LIVE · POLLED";
    $("conn").className = "pill ok";
  } catch {
    $("conn").textContent = "OFFLINE";
    $("conn").className = "pill bad";
  }
}

function startPolling() {
  pollOnce();
  pollTimer = setInterval(pollOnce, 20000);
}

function tickClock() {
  $("clock").textContent = new Date().toISOString().slice(11, 19) + "Z";
  if (STATE) renderTicker(STATE);
  // Real astronomy on a timestamp we already hold — the one thing on this page
  // that can honestly move every second.
  tickEnvClock();
}

initMap();
connect();
tickClock();
setInterval(tickClock, 1000);
tickOpsRate();
setInterval(tickOpsRate, 1000);
