// Camera watch — turn SDOT street stills into a recognition feed.
//
// Measured behaviour of the SDOT image endpoint (2026-07-26):
//   Cache-Control: public, max-age=300
//   Last-Modified advanced 10:33:58 -> 10:39:42, i.e. a new frame roughly every
//   5 minutes; between those, bytes are IDENTICAL.
//
// That gives us three free filters before we ever spend a token:
//   1. CONDITIONAL GET. If-None-Match / If-Modified-Since returns 304 and no
//      body when the frame has not advanced. Most polls cost nothing.
//   2. SIZE DELTA. A JPEG of a static street compresses to a near-constant
//      size; something entering the scene adds detail and grows the file.
//      Below the threshold we treat it as an unchanged scene.
//   3. NOCTURNAL WINDOW. Raccoons are crepuscular. Daylight frames are not
//      worth scoring, so the watcher sleeps through them.
//
// Only frames that survive all three reach the vision model.
//
// Fetching now lives in camtape.mjs, which records EVERY camera for the wall
// and time-lapse. This module only decides which recorded frames to score.


const lastScored = new Map();  // id -> when we last paid to score this camera

export const WATCH = {
  // Only the cameras close enough to plausibly cover Jimothy's range.
  maxCameras: Number(process.env.JM_WATCH_CAMS || 3),
  // A frame whose size moved less than this is the same empty street.
  minSizeDelta: Number(process.env.JM_WATCH_DELTA || 0.004), // 0.4%
  // Hard ceiling on frames sent to vision per UTC day, independent of the
  // global image cap.
  maxFramesPerDay: Number(process.env.JM_WATCH_MAX_DAY || 120),
  // Minimum gap between scored frames FROM THE SAME CAMERA. SDOT publishes
  // roughly every 5 minutes; scoring every one of them across three cameras
  // would exhaust the daily budget a few hours into the night. This spreads
  // the same budget evenly from dusk to dawn instead.
  minIntervalMs: Number(process.env.JM_WATCH_GAP_MS || 10 * 60_000),
  // Set to 1 to score frames in daylight too (useful for testing).
  ignoreNightWindow: process.env.JM_WATCH_ALLDAY === "1",
};

let spend = {};
const dayKey = () => new Date().toISOString().slice(0, 10);
export const framesToday = () => spend[dayKey()] || 0;
export const framesRemainingToday = () => Math.max(0, WATCH.maxFramesPerDay - framesToday());
export function loadFrameSpend(s) { spend = s || {}; }
export function getFrameSpend() { return spend; }

/**
 * Are we inside the window when a raccoon is plausibly out?
 * Uses the real civil-twilight times already fetched for the foraging index.
 */
export function inNocturnalWindow(conditions, now = Date.now()) {
  if (WATCH.ignoreNightWindow) return true;
  const sun = conditions?.sun;
  if (!sun?.sunset || !sun?.sunrise) return true; // no data — do not block
  const dusk = sun.civilTwilightEnd || sun.sunset;
  const dawn = sun.civilTwilightBegin || sun.sunrise;
  const DAY = 86400_000;
  const t = ((now - dusk) % DAY + DAY) % DAY;
  const nightLen = ((dawn - dusk) % DAY + DAY) % DAY;
  return t <= nightLen;
}

/**
 * Decide which of the tape's newly-recorded frames are worth scoring.
 *
 * The tape does the fetching for ALL cameras (it feeds the wall and the
 * time-lapse); this only picks. That way a camera is never fetched twice for
 * two different features.
 *
 * @param {Array} freshFrames  from camtape.pollTape() — [{cam, delta, first, frame}]
 */
export function selectFrames(freshFrames = [], conditions = null, trafficCams = []) {
  const night = inNocturnalWindow(conditions);
  const skipped = { notModified: 0, static: 0, error: 0, daylight: 0, budget: 0, cooldown: 0 };

  // Which cameras are in scope, computed once and PUBLISHED. This list was
  // derived and thrown away, so the recogniser's attention — which cameras it
  // is actually watching tonight — was invisible on a page whose whole point is
  // showing what the machine is doing.
  const inScope = trafficCams.filter((c) => c.ok).slice(0, WATCH.maxCameras);
  const watching = inScope.map((c) => c.id);

  if (!night) {
    // `daylight` counted every camera passed in, not the ones actually in
    // scope, so the skip tally read 9 when only 3 could ever have been polled.
    return { frames: [], checked: 0, night, watching,
             skipped: { ...skipped, daylight: inScope.length } };
  }

  // Same set as `watching` above, as a Set for the membership test below.
  const watched = new Set(watching);
  const frames = [];
  const now = Date.now();

  for (const f of freshFrames) {
    if (!watched.has(f.cam.id)) continue;
    // The first frame has no baseline, so its delta is meaningless.
    if (f.first) { skipped.static++; continue; }
    if (f.delta < WATCH.minSizeDelta) { skipped.static++; continue; }
    if (framesRemainingToday() <= 0) { skipped.budget++; continue; }
    const last = lastScored.get(f.cam.id) || 0;
    if (now - last < WATCH.minIntervalMs) { skipped.cooldown++; continue; }

    spend[dayKey()] = framesToday() + 1;
    lastScored.set(f.cam.id, now);
    frames.push({
      camId: f.cam.id,
      camName: f.cam.name,
      lat: f.cam.lat,
      lon: f.cam.lon,
      km: f.cam.km,
      buffer: f.frame.buf,
      sizeDelta: f.delta,
      capturedAt: f.frame.at,
      url: f.cam.url,
    });
  }

  return { frames, checked: watched.size, night, watching, skipped };
}
