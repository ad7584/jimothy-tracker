// Operations bus.
//
// Everything the pipeline actually does, emitted as it happens: every HTTP
// fetch with its host, latency and byte count; every gazetteer hit; every
// camera frame diff; every vision call with its model, latency and verdict;
// every corroboration decision.
//
// This exists so the dashboard can show real work in real time. NOTHING here
// is synthesised for effect — if the console looks busy it is because the
// machine is busy, and if it goes quiet that is the truth too.

const RING = 400;
const buffer = [];
const subscribers = new Set();

let seq = 0;
const counters = {
  fetches: 0, bytes: 0, items: 0, extracted: 0, geo: 0,
  frames: 0, visionCalls: 0, visionMs: 0, clusters: 0, passes: 0, errors: 0,
};

/**
 * @param {string} kind  poll|fetch|parse|extract|geo|cam|vision|hit|corr|index|warn
 * @param {string} text  human-readable, already formatted
 * @param {object} [meta]
 */
export function emit(kind, text, meta = {}) {
  const ev = { i: ++seq, t: Date.now(), kind, text, ...meta };
  buffer.push(ev);
  if (buffer.length > RING) buffer.shift();
  for (const fn of subscribers) {
    try { fn(ev); } catch { /* a dead subscriber must not stall the pipeline */ }
  }
  return ev;
}

export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
export const recent = (n = 120) => buffer.slice(-n);
export const stats = () => ({ ...counters, seq });

export function bump(key, by = 1) {
  if (key in counters) counters[key] += by;
}

/* ── convenience emitters, so call sites stay one line ──────────────── */

export function opFetch(host, ms, bytes, status = 200) {
  bump("fetches"); bump("bytes", bytes || 0);
  return emit("fetch", `GET ${host} · ${status} · ${ms}ms · ${fmtBytes(bytes)}`, { ms, bytes, status });
}

export function opPoll(source, n, ms) {
  return emit("poll", `POLL ${source} · ${n} items · ${ms}ms`, { source, n, ms });
}

export function opExtract(n, located, ms) {
  bump("extracted", n); bump("geo", located);
  return emit("extract", `EXTRACT ${n} items scanned · ${located} geolocated · ${ms}ms`, { n, located, ms });
}

export function opGeo(zone, precision, matched) {
  return emit("geo", `GEO ${zone} · ${precision} · "${matched}"`, { zone, precision });
}

export function opCam(name, delta, action) {
  bump("frames");
  return emit("cam", `CAM ${name} · Δ${delta} · ${action}`, { name, delta, action });
}

export function opVision(model, ms, verdict, subject) {
  bump("visionCalls"); bump("visionMs", ms);
  return emit("vision", `VISION ${short(model)} · ${ms}ms · ${verdict} · ${subject}`, { model, ms, verdict });
}

export function opHit(text, meta) {
  return emit("hit", text, meta);
}

export function opCorr(clusters, promoted) {
  // Counts PASSES, not clusters — summing the cluster count on every pass
  // produced a number that only ever grew and meant nothing.
  bump("passes");
  counters.clusters = clusters;   // current, not cumulative
  return emit("corr", `CORROBORATE ${clusters} clusters · ${promoted} at PROBABLE+`, { clusters, promoted });
}

// An index that has not moved is not news. Emitting it every pass buried the
// console in identical lines and made real changes invisible.
const lastIndex = new Map();
export function opIndex(name, value, detail = "") {
  if (lastIndex.get(name) === value) return null;
  const prev = lastIndex.get(name);
  lastIndex.set(name, value);
  const arrow = prev === undefined ? "" : value > prev ? ` ▲${value - prev}` : ` ▼${prev - value}`;
  return emit("index", `INDEX ${name} = ${value}${arrow}${detail ? ` · ${detail}` : ""}`, { name, value });
}

export function opWarn(text) {
  bump("errors");
  return emit("warn", text);
}

const short = (m) => String(m || "").split("/").pop();
function fmtBytes(b) {
  if (!b) return "0B";
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(2)}MB`;
}
