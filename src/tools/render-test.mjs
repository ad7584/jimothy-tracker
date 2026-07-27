// Headless smoke test for the dashboard client.
//
// web/app.js is a classic script full of DOM work, so a syntax check proves
// almost nothing about whether the page actually renders. This stubs just
// enough of the browser to load it and run a real render pass against real
// state, which catches the failure this refactor is most likely to produce: a
// panel reading a field that moved, or an element that no longer exists.
//
//   node src/tools/render-test.mjs
//
// It is not a browser. It will not catch layout, CSS or paint problems.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../config.mjs";
import * as store from "../store.mjs";

const html = await readFile(join(ROOT, "web", "index.html"), "utf8");
const js = await readFile(join(ROOT, "web", "app.js"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

let warnings = [];
const listeners = new Map();

function makeEl(id = "?") {
  const el = {
    id,
    _html: "",
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      // Give the panel loops something to iterate that behaves like elements.
      const n = (this._html.match(/<(button|div|article)\b/g) || []).length;
      this.children = Array.from({ length: n }, () => makeEl("child"));
    },
    textContent: "",
    hidden: false,
    href: "", src: "", title: "", value: "",
    appendChild() {}, insertBefore() {}, removeChild() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener(ev, fn) { listeners.set(`${id}:${ev}`, fn); },
    querySelector: () => makeEl("q"),
    querySelectorAll: () => [],
    scrollIntoView() {}, focus() {}, select() {},
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    offsetWidth: 100, scrollTop: 0, childElementCount: 0,
    insertAdjacentHTML() {},
  };
  return el;
}

const pool = new Map();
const byId = (id) => {
  if (!pool.has(id)) {
    if (!ids.has(id)) warnings.push(`getElementById("${id}") — not in index.html`);
    pool.set(id, makeEl(id));
  }
  return pool.get(id);
};

globalThis.document = {
  getElementById: byId,
  createElement: (t) => makeEl(t),
  createDocumentFragment: () => makeEl("frag"),
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => makeEl("q"),
  head: makeEl("head"),
  body: makeEl("body"),
  hidden: false,
  documentElement: makeEl("html"),
};
globalThis.window = globalThis;
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { constructor() {} addEventListener() {} close() {} };
// navigator is a getter-only global in Node; define it rather than assign.
try { Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true }); } catch {}
globalThis.maplibregl = {
  Map: class {
    constructor() {}
    addControl() {} addSource() {} addLayer() {} on() {} once() {}
    getSource() { return { setData() {} }; }
    getStyle() { return { layers: [1] }; }
    isStyleLoaded() { return false; }
    setLayoutProperty() {} flyTo() {} jumpTo() {}
    getCanvas() { return { style: {} }; }
  },
  NavigationControl: class {}, Popup: class { setLngLat() { return this; } setHTML() { return this; } addTo() {} remove() {} },
};

const state = await store.loadState();
if (!state) {
  console.error("no data/state.json — run `node src/runner.mjs --once` first");
  process.exit(1);
}

// Load the client. Top-level initMap()/connect() run against the stubs.

let render;
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${js}\nreturn { render, renderEnv, renderAttention, renderLeads, renderLedger, renderCams, renderFeed, renderHealth, renderZones, renderRecognition, renderGauge, renderChips, renderTicker };`);
  const api = fn();
  render = api.render;
  console.log("app.js loaded and top-level init ran");

  const panels = ["renderEnv", "renderAttention", "renderLeads", "renderLedger",
                  "renderCams", "renderFeed", "renderZones", "renderRecognition",
                  "renderHealth", "renderChips", "renderTicker"];
  let ok = 0;
  for (const name of panels) {
    try { api[name](state); ok++; console.log(`  PASS  ${name}`); }
    catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); }
  }

  // A full render pass, which is what the SSE handler actually calls.
  try { render(state); console.log("  PASS  render(state) — full pass"); ok++; }
  catch (e) { console.log(`  FAIL  render(state): ${e.message}`); }

  console.log(`\n${ok}/${panels.length + 1} render entry points ran clean`);

  // Show what the new panels actually produced.
  for (const id of ["env", "attn", "leads", "ledger", "camWall"]) {
    const el = pool.get(id);
    const len = el?._html?.length ?? 0;
    console.log(`  #${id.padEnd(8)} ${String(len).padStart(6)} bytes of HTML` +
      (len ? "" : "   <-- EMPTY"));
  }

  // DUMP=env,attn node src/tools/render-test.mjs — eyeball what a panel emits.
  if (process.env.DUMP) {
    for (const id of String(process.env.DUMP).split(",")) {
      const body = (pool.get(id)?._html || "(empty)")
        .replace(/\s+/g, " ")
        .split("><").join(">\n<")
        .slice(0, 1500);
      console.log(`\n===== #${id} =====\n${body}`);
    }
  }

  if (warnings.length) {
    console.log("\nmissing elements:");
    for (const w of [...new Set(warnings)]) console.log("  " + w);
  }
  process.exit(ok === panels.length + 1 ? 0 : 1);
} catch (e) {
  console.error("app.js failed to load:", e.message);
  console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}
