// Zero-dependency fetch helpers: timeout, retry with backoff, browser-ish UA.
// Several of our upstreams (old.reddit, Google News) reject default Node UAs,
// so every request here carries one.

import { opFetch } from "../engine/ops.mjs";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Wikimedia asks for a descriptive UA with contact info rather than a spoofed one.
export const POLITE_UA =
  "JimothyTracker/0.1 (https://github.com/; open-source neighbourhood wildlife tracker)";

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * fetch with an abort timeout and bounded retries.
 * Retries on network errors and 5xx/429 only — a 403 means we are blocked and
 * hammering it will not help.
 */
export async function get(url, { timeout = 15000, retries = 2, ua = BROWSER_UA, accept, headers } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const t0 = Date.now();
    let host = url;
    try { host = new URL(url).host; } catch {}
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          "Accept-Language": "en-US,en;q=0.9",
          ...(accept ? { Accept: accept } : {}),
          ...(headers || {}),
        },
      });
      if (!res.ok) {
        // Only the final outcome is reported. Emitting per attempt turned one
        // rate-limited Reddit call into three identical console lines.
        if (attempt === retries || (res.status < 500 && res.status !== 429)) {
          opFetch(host, Date.now() - t0, 0, res.status);
        }
        const err = new HttpError(res.status, url);
        // Not worth retrying a hard block or a not-found.
        if (res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      } else {
        const body = await res.text();
        // Every outbound request is reported to the ops console — this is what
        // makes the live feed real rather than decorative.
        opFetch(host, Date.now() - t0, body.length, res.status);
        return body;
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt);
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const body = await get(url, { accept: "application/json", ...opts });
  return JSON.parse(body);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
