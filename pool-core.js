#!/usr/bin/env node
// =====================================================================
// Ultron Pool Manager — CORE (embeddable lease-pool HTTP server).
// Same lease model as the standalone pool-server.js, but packaged as a
// MODULE the Electron app starts in-process. Keys are read LIVE from a
// callback (so add/revoke/renew apply instantly, no restart), and
// profiles are scanned from PROFILES_BASE (only real logged-in contexts).
//
//   const { startPool } = require("./pool-core");
//   const pool = startPool({ port, profilesBase, workerPath, nodeBin,
//                            getKeys: () => ["key1-...","key2-..."],
//                            getMeta: (name) => ({service,proxy}),
//                            onEvent: (ev) => {...} });
//   pool.status();  // { total, free, leased, busy, activeLeases, profiles:[...] }
//   pool.stop();
// =====================================================================
"use strict";
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function startPool(opts) {
  const PORT = Number(opts.port || 8787);
  const PROFILES_BASE = opts.profilesBase;
  const WORKER = opts.workerPath;
  const NODE_BIN = opts.nodeBin || process.execPath;
  const LEASE_TTL = Number(opts.leaseTtlMs || 10 * 60 * 1000);
  const LEASE_MAX = Number(opts.leaseMax || 6);
  const getKeys = opts.getKeys || (() => []);
  const getMeta = opts.getMeta || (() => ({}));
  const onEvent = opts.onEvent || (() => {});
  const ADMIN = opts.admin || null; // { token:()=>string, html, api:{status,memberAdd,memberRenew,memberDelete} }

  const log = (...a) => {
    const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    onEvent({ t: Date.now(), line });
  };

  // --- profile registry -----------------------------------------------------
  // A real Playwright persistent-context profile dir contains a "Default"
  // subfolder; strays (e.g. "browser", "locks") are skipped.
  function scanProfiles() {
    let names = [];
    try {
      names = fs
        .readdirSync(PROFILES_BASE, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROFILES_BASE, d.name, "Default")))
        .map((d) => d.name);
    } catch (e) {
      log("WARN cannot read profiles dir", PROFILES_BASE, e.message);
    }
    const prev = new Map(PROFILES.map((p) => [p.name, p]));
    return names.map((name) => {
      const meta = getMeta(name) || {};
      const old = prev.get(name);
      return {
        name,
        service: meta.service || "gemini",
        proxy: meta.proxy || null,
        lease: old ? old.lease : null,
        busy: old ? old.busy : false,
      };
    });
  }
  let PROFILES = [];
  PROFILES = scanProfiles();
  log(`loaded ${PROFILES.length} profiles from ${PROFILES_BASE}`);

  function rescan() {
    PROFILES = scanProfiles();
    return PROFILES.length;
  }

  // --- leases ---------------------------------------------------------------
  const leases = new Map(); // leaseId -> { key, names:Set, expiry }
  function touch(id) {
    const l = leases.get(id);
    if (l) l.expiry = Date.now() + LEASE_TTL;
  }
  function acquireLease(key, count, service) {
    const want = Math.max(1, Math.min(count || LEASE_MAX, LEASE_MAX));
    const free = PROFILES.filter((p) => !p.lease && p.service === (service || "gemini")).slice(0, want);
    if (!free.length) return null;
    const leaseId = crypto.randomBytes(8).toString("hex");
    free.forEach((p) => (p.lease = leaseId));
    leases.set(leaseId, { key, names: new Set(free.map((p) => p.name)), expiry: Date.now() + LEASE_TTL });
    log(`LEASE ${leaseId} -> [${free.map((p) => p.name).join(", ")}] (key ${String(key).slice(0, 8)})`);
    return { leaseId, profiles: free.map((p) => p.name) };
  }
  function releaseLease(leaseId, reason) {
    const l = leases.get(leaseId);
    if (!l) return;
    PROFILES.forEach((p) => {
      if (p.lease === leaseId) {
        p.lease = null;
        p.busy = false;
      }
    });
    leases.delete(leaseId);
    log(`RELEASE ${leaseId} (${reason || "explicit"})`);
  }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, l] of leases) if (l.expiry < now) releaseLease(id, "ttl-expired");
  }, 30000);
  sweep.unref && sweep.unref();

  async function pickProfile(leaseId) {
    if (!leases.has(leaseId)) return null;
    for (let w = 0; w < 120; w++) {
      const p = PROFILES.find((x) => x.lease === leaseId && !x.busy);
      if (p) {
        p.busy = true;
        return p;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  // --- run one prompt on a profile via the proven worker --------------------
  function runWorker(profile, prompt, model) {
    return new Promise((resolve) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ultron-poolmgr-"));
      const inF = path.join(tmp, "in.txt");
      const outF = path.join(tmp, "out.json");
      try {
        fs.writeFileSync(inF, prompt, "utf8");
      } catch (e) {
        return resolve({ ok: false, error: "write in: " + e.message });
      }
      let tail = "";
      const child = spawn(NODE_BIN, [WORKER], {
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PROFILES_BASE,
          GEMINI_PROFILE: profile.name,
          GEMINI_IN: inF,
          GEMINI_OUT: outF,
          GEMINI_MODEL: model || "3.1 Pro",
          ...(profile.proxy ? { GEMINI_PROXY: profile.proxy } : {}),
        },
      });
      child.stdout.on("data", (d) => (tail = (tail + d.toString()).slice(-3000)));
      child.stderr.on("data", (d) => (tail = (tail + d.toString()).slice(-3000)));
      child.on("error", (e) => resolve({ ok: false, error: "spawn: " + e.message, tail }));
      child.on("close", () => {
        let res;
        try {
          res = JSON.parse(fs.readFileSync(outF, "utf8"));
        } catch {
          res = { ok: false, error: "worker produced no result", tail: tail.slice(-800) };
        }
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {}
        resolve(res);
      });
    });
  }

  async function chatOnLease(leaseId, prompt, model) {
    if (!leases.has(leaseId)) return { ok: false, error: "invalid or expired lease" };
    touch(leaseId);
    const p = await pickProfile(leaseId);
    if (!p) return { ok: false, error: "all leased profiles busy (timed out)" };
    try {
      const r = await runWorker(p, prompt, model);
      touch(leaseId);
      return r.ok
        ? { ok: true, text: r.text, profile: p.name, model: r.model }
        : { ok: false, error: r.error || "failed", profile: p.name };
    } finally {
      p.busy = false;
    }
  }

  // --- HTTP -----------------------------------------------------------------
  function authed(req) {
    const keys = getKeys() || [];
    if (!keys.length) return false; // no keys configured = closed (safer default)
    const k = (req.headers["x-api-key"] || "").toString();
    return keys.includes(k);
  }
  function body(req) {
    return new Promise((resolve) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        try {
          resolve(d ? JSON.parse(d) : {});
        } catch {
          resolve({});
        }
      });
    });
  }
  function send(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
    res.end(s);
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    try {
      if (req.method === "GET" && url === "/pool/status") {
        return send(res, 200, publicStatus());
      }

      // ---- remote admin panel (separate admin token) ----
      if (ADMIN && url === "/admin") {
        const html = ADMIN.html || "<h3>Admin page not bundled</h3>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
        return res.end(html);
      }
      if (ADMIN && url.startsWith("/admin/api/")) {
        const tok = (req.headers["x-admin-token"] || "").toString();
        const want = (typeof ADMIN.token === "function" ? ADMIN.token() : ADMIN.token) || "";
        if (!want || tok !== want) return send(res, 401, { ok: false, error: "bad admin token" });
        if (req.method === "GET" && url === "/admin/api/status") return send(res, 200, { ok: true, ...ADMIN.api.status() });
        if (req.method === "POST" && url === "/admin/api/member") {
          const b = await body(req);
          return send(res, 200, { ok: true, member: ADMIN.api.memberAdd(b.name) });
        }
        if (req.method === "POST" && url === "/admin/api/member/renew") {
          const b = await body(req);
          return send(res, 200, { ok: true, member: ADMIN.api.memberRenew(String(b.id || "")) });
        }
        if (req.method === "POST" && url === "/admin/api/member/delete") {
          const b = await body(req);
          return send(res, 200, { ok: true, ...ADMIN.api.memberDelete(String(b.id || "")) });
        }
        return send(res, 404, { ok: false, error: "not found" });
      }

      if (!authed(req)) return send(res, 401, { ok: false, error: "bad api key" });
      if (req.method === "POST" && url === "/lease") {
        const b = await body(req);
        const r = acquireLease((req.headers["x-api-key"] || "anon").toString(), Number(b.count) || LEASE_MAX, b.service);
        if (!r) return send(res, 503, { ok: false, error: "no free profiles — pool busy, retry shortly" });
        return send(res, 200, { ok: true, ...r, ttlMs: LEASE_TTL });
      }
      if (req.method === "POST" && url === "/release") {
        const b = await body(req);
        releaseLease(String(b.leaseId || ""), "client");
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url === "/chat") {
        const b = await body(req);
        if (!b.leaseId || !b.prompt) return send(res, 400, { ok: false, error: "leaseId + prompt required" });
        const r = await chatOnLease(String(b.leaseId), String(b.prompt), b.model);
        return send(res, r.ok ? 200 : 502, r);
      }
      return send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) || "server error" });
    }
  });

  function publicStatus() {
    return {
      ok: true,
      total: PROFILES.length,
      free: PROFILES.filter((p) => !p.lease).length,
      leased: PROFILES.filter((p) => p.lease).length,
      busy: PROFILES.filter((p) => p.busy).length,
      activeLeases: leases.size,
      profiles: PROFILES.map((p) => ({ name: p.name, service: p.service, state: p.busy ? "busy" : p.lease ? "leased" : "free" })),
    };
  }

  let listenErr = null;
  server.on("error", (e) => {
    listenErr = e.message;
    log("SERVER ERROR " + e.message);
  });
  server.listen(PORT, () => log(`pool server on :${PORT} (profiles=${PROFILES.length})`));

  return {
    status: publicStatus,
    rescan,
    port: PORT,
    stop: () =>
      new Promise((r) => {
        clearInterval(sweep);
        try {
          server.close(() => r());
        } catch {
          r();
        }
      }),
    lastError: () => listenErr,
  };
}

module.exports = { startPool };
