// Persistence. Append-only NDJSON for the raw record, plus a single JSON
// snapshot for whatever the dashboard needs on connect. No database — the
// volume here is a few thousand items a day and a file is the honest answer.

import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const ITEMS = () => join(DATA_DIR, "items.ndjson");
const STATE = () => join(DATA_DIR, "state.json");
const SEEN = () => join(DATA_DIR, "seen.json");

let seen = new Set();
let dirtySeen = false;

export async function init() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    seen = new Set(JSON.parse(await readFile(SEEN(), "utf8")));
  } catch {
    seen = new Set();
  }
}

/** Has this item id been ingested before? */
export function isSeen(id) {
  return seen.has(id);
}

export function markSeen(id) {
  if (!seen.has(id)) {
    seen.add(id);
    dirtySeen = true;
  }
}

/**
 * Append newly-ingested items. Returns only those that were actually new, so
 * callers can report real ingest counts rather than poll counts.
 */
export async function appendItems(items) {
  const fresh = items.filter((i) => i.id && !isSeen(i.id));
  if (!fresh.length) return [];
  for (const i of fresh) markSeen(i.id);
  await appendFile(ITEMS(), fresh.map((i) => JSON.stringify(i)).join("\n") + "\n", "utf8");
  await flushSeen();
  return fresh;
}

async function flushSeen() {
  if (!dirtySeen) return;
  dirtySeen = false;
  // Bounded: keep the most recent 50k ids. Older ones cannot recur in a feed window.
  const arr = [...seen].slice(-50_000);
  seen = new Set(arr);
  await writeFile(SEEN(), JSON.stringify(arr), "utf8");
}

/** Read back items newer than `sinceMs`. Streams — the file only grows. */
export async function readItems({ sinceMs = 0, limit = 5000 } = {}) {
  try {
    await stat(ITEMS());
  } catch {
    return [];
  }
  const out = [];
  const rl = createInterface({ input: createReadStream(ITEMS(), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const it = JSON.parse(line);
      if ((it.ts || it.fetchedAt || 0) >= sinceMs) out.push(it);
    } catch {
      // A truncated final line after a hard kill is expected; skip it.
    }
  }
  rl.close();
  return out.slice(-limit);
}

// --- Recognition cache ----------------------------------------------------
// Vision calls cost money, so a scored image must never be scored twice —
// including across restarts. Keyed by image URL.
const RECOG = () => join(DATA_DIR, "recognition.json");

export async function loadRecognition() {
  try {
    const j = JSON.parse(await readFile(RECOG(), "utf8"));
    return { results: j.results || [], spend: j.spend || {}, frameSpend: j.frameSpend || {} };
  } catch {
    return { results: [], spend: {}, frameSpend: {} };
  }
}

export async function saveRecognition(results, spend, frameSpend = {}) {
  await writeFile(RECOG(), JSON.stringify({ results: results.slice(0, 500), spend, frameSpend }), "utf8");
}

export async function saveState(state) {
  await writeFile(STATE(), JSON.stringify(state, null, 2), "utf8");
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE(), "utf8"));
  } catch {
    return null;
  }
}
