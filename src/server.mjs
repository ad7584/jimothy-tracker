// HTTP API + SSE + static hosting for the dashboard. Zero dependencies.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { gzipSync, brotliCompressSync, constants as zc } from "node:zlib";
import { createHash } from "node:crypto";
import { WEB_DIR, PORT } from "./config.mjs";
import { subscribe, recent, stats } from "./engine/ops.mjs";
import { tapeIndex, getFrame } from "./sources/camtape.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export class Server {
  constructor(getState) {
    this.getState = getState;
    this.clients = new Set();
    this.http = createServer((req, res) => this.route(req, res));

    // Push each operation the moment it happens, rather than waiting for the
    // next full state snapshot. This is what makes the live console live.
    subscribe((ev) => {
      const payload = `event: op\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const c of this.clients) {
        try { c.write(payload); } catch { this.clients.delete(c); }
      }
    });
  }

  listen(port = PORT) {
    this.http.listen(port, () => console.log(`[server] http://localhost:${port}`));
  }

  /**
   * Compress every JSON response.
   *
   * /api/state measured 166,845 B uncompressed with no Content-Encoding at all.
   * Same body: gzip -6 = 25,944 B (-84.4%), brotli q5 = 21,867 B (-86.9%).
   * `node:zlib` is a builtin, so this costs no dependency.
   *
   * Brotli is pinned to QUALITY 5, not the default 11. q11 buys about 3 KB more
   * and costs ~100ms of BLOCKED EVENT LOOP per call — on a single-threaded
   * ingest process that publishes to every SSE client on a shared loop, that is
   * a much worse trade than the bytes are worth.
   */
  json(res, body, code = 200, req = null) {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const accept = String(req?.headers?.["accept-encoding"] || "");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      Vary: "Accept-Encoding",
    };

    let out = raw;
    if (raw.length > 1024 && /\bbr\b/.test(accept)) {
      out = brotliCompressSync(raw, {
        params: {
          [zc.BROTLI_PARAM_QUALITY]: 5,
          [zc.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      });
      headers["Content-Encoding"] = "br";
    } else if (raw.length > 1024 && /\bgzip\b/.test(accept)) {
      out = gzipSync(raw, { level: 6 });
      headers["Content-Encoding"] = "gzip";
    }

    headers["Content-Length"] = out.length;
    res.writeHead(code, headers);
    res.end(out);
  }

  async route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    try {
      if (p === "/api/state") return this.json(res, this.getState(), 200, req);
      if (p === "/api/health") {
        const s = this.getState();
        return this.json(res, {
          ok: true, sources: s.sources, startedAt: s.startedAt, cycles: s.cycles,
          // Answers "is production actually running this commit?" in one glance.
          // /api/ops returning 404 in production while being defined right here
          // was the signal that the deployed build was behind main.
          commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
        }, 200, req);
      }
      if (p === "/api/sightings") return this.json(res, this.getState().clusters || [], 200, req);
      if (p === "/api/heat") {
        const s = this.getState();
        return this.json(res, { ballard: s.heat, world: s.world }, 200, req);
      }
      if (p === "/api/recognition") return this.json(res, this.getState().recognition || [], 200, req);
      if (p === "/api/cams") return this.json(res, this.getState().cams || { ok: false, rows: [] }, 200, req);
      if (p === "/api/ops") return this.json(res, { events: recent(200), stats: stats() }, 200, req);
      if (p === "/api/camtape") return this.json(res, tapeIndex(), 200, req);
      // /api/camframe/<camId>/<index> — raw JPEG straight from the tape.
      // NOT routed through json(): it is already-compressed binary, so gzipping
      // it again would cost CPU and add bytes.
      if (p.startsWith("/api/camframe/")) {
        const [, , , camId, idx] = p.split("/");
        const frame = getFrame(decodeURIComponent(camId || ""), idx ?? 0);
        if (!frame) { res.writeHead(404); return res.end("no frame"); }
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": frame.buf.length,
          "Cache-Control": "public, max-age=600",
          "Access-Control-Allow-Origin": "*",
          "X-Frame-At": String(frame.at),
        });
        return res.end(frame.buf);
      }
      if (p === "/api/stories") return this.json(res, this.getState().stories || [], 200, req);
      if (p === "/api/stream") return this.stream(req, res);

      return this.static(p, res, req);
    } catch (e) {
      return this.json(res, { error: e.message }, 500, req);
    }
  }

  stream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    // Send current state immediately so a fresh tab is never blank.
    res.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
    // …and a backlog of operations, so the console has history on arrival
    // rather than an empty box until the next poll fires.
    res.write(`event: ops\ndata: ${JSON.stringify({ events: recent(80), stats: stats() })}\n\n`);

    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    this.clients.add(res);
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  publish(state) {
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  async static(p, res, req = null) {
    if (p === "/" || p.endsWith("/")) p += "index.html";
    const file = normalize(join(WEB_DIR, p));
    // Compare with a separator. A bare startsWith(WEB_DIR) also accepts a
    // sibling directory whose name merely begins with it — `web-private`.
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    try {
      const buf = await readFile(file);
      const etag = `"${createHash("sha1").update(buf).digest("hex").slice(0, 16)}"`;
      const type = TYPES[extname(file)] || "application/octet-stream";

      // The dashboard is three files that change only on deploy; without this
      // every reload re-downloaded all 78 KB because nothing was cacheable.
      if (req?.headers?.["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
        return res.end();
      }

      const accept = String(req?.headers?.["accept-encoding"] || "");
      const headers = {
        "Content-Type": type,
        ETag: etag,
        // "no-cache" means revalidate, not "don't store" — so a repeat visit
        // costs one conditional request and a 304, rather than the whole file.
        "Cache-Control": "no-cache",
        Vary: "Accept-Encoding",
      };

      let out = buf;
      const compressible = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
      if (compressible && buf.length > 1024 && /\bbr\b/.test(accept)) {
        out = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } });
        headers["Content-Encoding"] = "br";
      } else if (compressible && buf.length > 1024 && /\bgzip\b/.test(accept)) {
        out = gzipSync(buf, { level: 6 });
        headers["Content-Encoding"] = "gzip";
      }

      headers["Content-Length"] = out.length;
      res.writeHead(200, headers);
      res.end(out);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  }
}
