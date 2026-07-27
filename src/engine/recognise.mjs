// The recognition filter.
//
// Jimothy is unusually identifiable: short spine syndrome gives him a
// compressed torso, no visible neck and a low length-to-height silhouette that
// ordinary raccoons do not have. That is a genuinely discriminative feature.
//
// Two stages, for cost control. Most inbound images are murals, tattoos,
// plushes, price charts and merch — stage 1 kills those cheaply. Only survivors
// reach the more expensive identification pass.
//
// Provider-agnostic: talks to the Anthropic Messages API directly, or to
// OpenRouter's OpenAI-compatible endpoint. Whichever key is present wins. With
// no key at all, images queue as UNSCORED and ingest continues uninterrupted.

import { VISION } from "../config.mjs";
import { opVision } from "./ops.mjs";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || null;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;

export const provider = OPENROUTER_KEY ? "openrouter" : ANTHROPIC_KEY ? "anthropic" : null;
export const enabled = Boolean(provider);

// OpenRouter prefixes Anthropic model slugs; allow full override via env.
const MODELS = {
  triage: process.env.JM_TRIAGE_MODEL ||
    (provider === "openrouter" ? "anthropic/claude-haiku-4.5" : VISION.triageModel),
  // sonnet-5 on OpenRouter is $2/$10 per M — newer and cheaper than
  // sonnet-4.5's $3/$15. Verified against /api/v1/models on 2026-07-26.
  id: process.env.JM_ID_MODEL ||
    (provider === "openrouter" ? "anthropic/claude-sonnet-5" : VISION.idModel),
};

const TRIAGE_PROMPT =
  "Does this image contain a real, live raccoon photographed in the world? " +
  "Answer NO for drawings, murals, tattoos, plush toys, merchandise, logos, " +
  "screenshots, charts, or AI-generated images. " +
  'Reply with JSON only: {"raccoon": true|false, "reason": "<8 words max>"}';

// Street cameras need a different question. The frame is a wide night-time
// road scene; almost everything in it is tarmac, cars and people. We are only
// asking whether a small four-legged animal is present at all.
const STREET_TRIAGE_PROMPT =
  "This is a fixed street camera frame from Seattle at night. Is there a small " +
  "four-legged ANIMAL visible anywhere in it (raccoon, cat, dog, possum)? " +
  "Vehicles, people, cyclists, bins, shadows and reflections are NOT animals. " +
  "Be strict: answer false unless you can actually see an animal body. " +
  'Reply with JSON only: {"raccoon": true|false, "reason": "<10 words max>"}';

const ID_PROMPT =
  "This is a photo of a raccoon. We are trying to identify one specific individual: " +
  "'Jimothy', a raccoon in Ballard, Seattle with short spine syndrome. His distinguishing " +
  "features are a severely compressed torso (unusually low length-to-height ratio), no " +
  "visible neck, a rounded loaf-like silhouette, and a steeply sloping hindquarter. " +
  "Ordinary raccoons are noticeably longer-bodied with a visible neck.\n\n" +
  "Assess whether this individual is consistent with Jimothy. Be conservative: most " +
  "raccoons are NOT Jimothy. If the posture, angle or image quality make the torso " +
  "proportions unclear, say so and score low.\n\n" +
  'Reply with JSON only: {"consistent": true|false, "confidence": 0.0-1.0, ' +
  '"torsoRatio": "<short|normal|unclear>", "neckVisible": true|false|null, ' +
  '"reasoning": "<one sentence, max 25 words>"}';

// --- Spend guard ----------------------------------------------------------
// Bounded per UTC day and persisted, so neither a runaway loop nor a restart
// can run up a bill. Real supply is ~5-9 new images/day.
let spend = {};
const todayKey = () => new Date().toISOString().slice(0, 10);

export function loadSpend(s) { spend = s || {}; }
export function getSpend() { return spend; }
export function usedToday() { return spend[todayKey()] || 0; }
export function remainingToday() { return Math.max(0, VISION.maxImagesPerDay - usedToday()); }
function chargeOne() { const k = todayKey(); spend[k] = (spend[k] || 0) + 1; }

async function fetchImageAsBase64(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "JimothyTracker/0.1" } });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!/^image\/(jpeg|png|webp|gif)/.test(type)) throw new Error(`not an image: ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > VISION.maxBytes) throw new Error("image too large");
    return { base64: buf.toString("base64"), mediaType: type.split(";")[0] };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonish(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function callAnthropic(model, prompt, img) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.content?.map((c) => c.text || "").join("") || "";
}

async function callOpenRouter(model, prompt, img) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENROUTER_KEY}`,
      "X-Title": "Jimothy Tracker",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

const call = (model, prompt, img) =>
  provider === "openrouter" ? callOpenRouter(model, prompt, img) : callAnthropic(model, prompt, img);

/**
 * Score an already-decoded image. Shared by the URL path and the live
 * street-camera path.
 */
async function scoreImage(img, base, triagePrompt) {
  const subject = base.camName || (base.imageUrl || "").split("/").pop().slice(0, 34);
  const tri0 = Date.now();
  try {
    const triage = parseJsonish(await call(MODELS.triage, triagePrompt, img));
    if (!triage) return { ...base, status: "ERROR", reasoning: "triage returned unparseable output", model: MODELS.triage };
    opVision(MODELS.triage, Date.now() - tri0, triage.raccoon ? "ANIMAL" : "no animal", subject);
    if (!triage.raccoon) {
      return { ...base, status: "NOT_RACCOON", raccoon: false, reasoning: triage.reason || null, model: MODELS.triage };
    }
  } catch (e) {
    return { ...base, status: "ERROR", reasoning: `triage: ${e.message}`, model: MODELS.triage };
  }

  const id0 = Date.now();
  try {
    const id = parseJsonish(await call(MODELS.id, ID_PROMPT, img));
    if (!id) return { ...base, status: "ERROR", raccoon: true, reasoning: "id pass returned unparseable output", model: MODELS.id };
    const confidence = typeof id.confidence === "number" ? Math.max(0, Math.min(1, id.confidence)) : null;
    opVision(MODELS.id, Date.now() - id0, id.consistent ? "CONSISTENT" : "not Jimothy", subject);
    return {
      ...base,
      status: id.consistent && (confidence ?? 0) >= 0.5 ? "CONSISTENT_WITH_JIMOTHY" : "RACCOON_NOT_JIMOTHY",
      raccoon: true,
      consistent: Boolean(id.consistent),
      confidence,
      torsoRatio: id.torsoRatio ?? null,
      neckVisible: id.neckVisible ?? null,
      // Displayed verbatim in the UI — the model's own words, not our summary.
      reasoning: id.reasoning || null,
      model: MODELS.id,
    };
  } catch (e) {
    return { ...base, status: "ERROR", raccoon: true, reasoning: `id: ${e.message}`, model: MODELS.id };
  }
}

/**
 * Score one image by URL.
 * @returns {{status:string, raccoon:boolean|null, consistent:boolean|null,
 *            confidence:number|null, reasoning:string|null, model:string|null,
 *            imageUrl:string, checkedAt:number}}
 */
export async function recogniseImage(imageUrl) {
  const base = { imageUrl, checkedAt: Date.now(), raccoon: null, consistent: null,
    confidence: null, reasoning: null, model: null, kind: "photo" };
  if (!enabled) return { ...base, status: "UNSCORED", reasoning: "no vision API key configured" };
  if (remainingToday() <= 0) {
    return { ...base, status: "BUDGET_CAPPED",
      reasoning: `daily cap of ${VISION.maxImagesPerDay} images reached; resumes 00:00 UTC` };
  }
  chargeOne();

  let img;
  try {
    img = await fetchImageAsBase64(imageUrl);
  } catch (e) {
    return { ...base, status: "ERROR", reasoning: `fetch failed: ${e.message}` };
  }
  return scoreImage(img, base, TRIAGE_PROMPT);
}

/**
 * Score a live street-camera frame we already hold in memory.
 * Uses the street triage prompt — a wide night road scene needs a different
 * first question than a close-up photo of an animal.
 */
export async function recogniseFrame(frame) {
  const base = {
    imageUrl: frame.url,
    checkedAt: Date.now(),
    raccoon: null, consistent: null, confidence: null, reasoning: null, model: null,
    kind: "camera",
    camId: frame.camId,
    camName: frame.camName,
    km: frame.km,
    capturedAt: frame.capturedAt,
    sizeDelta: Number((frame.sizeDelta * 100).toFixed(2)),
  };
  if (!enabled) return { ...base, status: "UNSCORED", reasoning: "no vision API key configured" };
  if (remainingToday() <= 0) {
    return { ...base, status: "BUDGET_CAPPED",
      reasoning: `daily cap of ${VISION.maxImagesPerDay} images reached; resumes 00:00 UTC` };
  }
  chargeOne();

  if (frame.buffer.byteLength > VISION.maxBytes) {
    return { ...base, status: "ERROR", reasoning: "frame too large" };
  }
  const img = { base64: frame.buffer.toString("base64"), mediaType: "image/jpeg" };
  return scoreImage(img, base, STREET_TRIAGE_PROMPT);
}

/** Score a batch, bounded per cycle so a burst cannot run up a bill. */
export async function recogniseBatch(imageUrls, limit = VISION.maxImagesPerCycle) {
  const urls = [...new Set(imageUrls)].slice(0, limit);
  const out = [];
  for (const u of urls) out.push(await recogniseImage(u));
  return out;
}

export function status() {
  return {
    enabled,
    provider,
    triageModel: enabled ? MODELS.triage : null,
    idModel: enabled ? MODELS.id : null,
  };
}
