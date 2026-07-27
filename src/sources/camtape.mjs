// Camera tape — a short rolling recording of every SDOT street camera.
//
// SDOT publishes a still roughly every 5 minutes and the bytes are identical in
// between, so a conditional GET costs nothing when nothing has changed. That
// makes it cheap to keep ALL nine cameras recorded rather than just the three
// we point the recogniser at.
//
// Two things are built on this tape:
//   * the camera WALL — every camera's latest frame, side by side
//   * TIME-LAPSE playback — the last N frames of one camera played in sequence,
//     which is the only honest way to get motion out of a still camera. A
//     raccoon crossing the frame becomes visible as movement instead of
//     something you had to be looking at the right five-minute window to catch.
//
// Frames live in memory only. Nine cameras x 12 frames x ~80KB is under 9MB,
// and none of it is worth persisting across a restart.

import { BROWSER_UA } from "../util/http.mjs";
import { opCam } from "../engine/ops.mjs";

export const FRAMES_PER_CAM = Number(process.env.JM_TAPE_FRAMES || 12);

/** camId -> { etag, lastModified, size, frames: [{ buf, at, size, delta }] } */
const tapes = new Map();

function tapeFor(id) {
  if (!tapes.has(id)) tapes.set(id, { etag: null, lastModified: null, size: 0, frames: [] });
  return tapes.get(id);
}

/**
 * Fetch one camera, appending to its tape only when the frame actually advanced.
 * @returns {{added:boolean, reason?:string, delta?:number}}
 */
async function record(cam) {
  const tape = tapeFor(cam.id);
  const headers = { "User-Agent": BROWSER_UA };
  if (tape.etag) headers["If-None-Match"] = tape.etag;
  if (tape.lastModified) headers["If-Modified-Since"] = tape.lastModified;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${cam.url}?t=${Date.now()}`, { signal: ctrl.signal, headers });
    if (res.status === 304) return { added: false, reason: "not-modified" };
    if (!res.ok) return { added: false, reason: `HTTP ${res.status}` };

    const buf = Buffer.from(await res.arrayBuffer());
    const lastModified = res.headers.get("last-modified");
    const etag = res.headers.get("etag");

    // Same publish timestamp means the same picture, whatever the cache did.
    if (tape.lastModified && lastModified === tape.lastModified) {
      return { added: false, reason: "same-frame" };
    }

    const delta = tape.size ? Math.abs(buf.length - tape.size) / tape.size : 1;
    tape.etag = etag;
    tape.lastModified = lastModified;
    tape.size = buf.length;
    tape.frames.push({
      buf,
      at: lastModified ? Date.parse(lastModified) : Date.now(),
      size: buf.length,
      delta,
    });
    while (tape.frames.length > FRAMES_PER_CAM) tape.frames.shift();

    return { added: true, delta, first: tape.frames.length === 1 };
  } catch (e) {
    return { added: false, reason: String(e.message || e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record every serving camera. Returns the frames that are genuinely new, so
 * the recogniser can decide which of them are worth spending a token on.
 */
export async function pollTape(trafficCams = []) {
  const cams = trafficCams.filter((c) => c.ok);
  const fresh = [];
  const skipped = { notModified: 0, error: 0 };

  // Serialised: nine polite conditional GETs, not nine simultaneous ones.
  for (const cam of cams) {
    const r = await record(cam);
    if (!r.added) {
      if (r.reason === "not-modified" || r.reason === "same-frame") skipped.notModified++;
      else skipped.error++;
      continue;
    }
    opCam(cam.name, `${(r.delta * 100).toFixed(2)}%`, r.first ? "recorded (first frame)" : "NEW FRAME recorded");
    fresh.push({ cam, delta: r.delta, first: r.first, frame: tapeFor(cam.id).frames.at(-1) });
  }
  return { fresh, checked: cams.length, skipped };
}

/** Frame metadata for the client — never the bytes, those come per-frame. */
export function tapeIndex() {
  const out = {};
  for (const [id, t] of tapes) {
    out[id] = {
      count: t.frames.length,
      max: FRAMES_PER_CAM,
      frames: t.frames.map((f, i) => ({ i, at: f.at, delta: Number((f.delta * 100).toFixed(2)) })),
      latestAt: t.frames.at(-1)?.at ?? null,
    };
  }
  return out;
}

export function getFrame(camId, index) {
  const t = tapes.get(camId);
  if (!t || !t.frames.length) return null;
  const i = Math.max(0, Math.min(t.frames.length - 1, Number(index)));
  return t.frames[i] || null;
}

export function latestFrame(camId) {
  const t = tapes.get(camId);
  return t?.frames.at(-1) || null;
}

export function tapeStats() {
  let frames = 0, bytes = 0;
  for (const t of tapes.values()) {
    frames += t.frames.length;
    for (const f of t.frames) bytes += f.size;
  }
  return { cameras: tapes.size, frames, bytes, perCam: FRAMES_PER_CAM };
}
