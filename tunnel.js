"use strict";
// =====================================================================
// Ultron Pool Manager — TUNNEL helper (Cloudflare quick tunnel).
// Spawns `cloudflared tunnel --url http://localhost:<port>` hidden,
// parses the https://<name>.trycloudflare.com URL from its output, and
// keeps it running. Uses a bundled cloudflared if present, else PATH.
// =====================================================================
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function findCloudflared(resourcesDir) {
  const candidates = [
    resourcesDir && path.join(resourcesDir, "cloudflared.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "cloudflared", "cloudflared.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return "cloudflared"; // fall back to PATH (installed via winget)
}

function startTunnel({ port, resourcesDir, onUrl, onLog, onExit }) {
  const bin = findCloudflared(resourcesDir);
  const args = ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`];
  let child;
  try {
    child = spawn(bin, args, { windowsHide: true });
  } catch (e) {
    onLog && onLog("tunnel spawn failed: " + e.message);
    onExit && onExit(-1);
    return { stop: () => {}, pid: null };
  }
  let url = null;
  const scan = (buf) => {
    const s = buf.toString();
    onLog && onLog(s.trim());
    if (!url) {
      const m = s.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
      if (m) {
        url = m[0];
        onUrl && onUrl(url);
      }
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan); // cloudflared logs to stderr
  child.on("exit", (code) => onExit && onExit(code));
  return {
    pid: child.pid,
    url: () => url,
    stop: () => {
      try {
        // tree-kill cloudflared on Windows
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        try {
          child.kill();
        } catch {}
      }
    },
  };
}

module.exports = { startTunnel, findCloudflared };
