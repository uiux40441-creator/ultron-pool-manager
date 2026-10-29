"use strict";
// =====================================================================
// Ultron Pool Manager — Electron main process.
// One window app that runs the lease pool + Cloudflare tunnel in-process
// and manages Gemini/Muse profiles and member API keys from a GUI.
// Isolated: touches only its own userData + the shared ai-profiles dir.
// =====================================================================
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { startPool } = require("./pool-core");
const login = require("./login");
const { startTunnel } = require("./tunnel");
let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  autoUpdater = null;
}

const USERDATA = app.getPath("userData");
const SETTINGS_FILE = path.join(USERDATA, "settings.json");
const MEMBERS_FILE = path.join(USERDATA, "members.json");
const META_FILE = path.join(USERDATA, "profiles-meta.json");
const WORKER = path.join(__dirname, "ultron-gemini-pool.js");

function defaultProfilesBase() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Ultron", "pipeline", "ai-profiles", "browser")
    : path.join(USERDATA, "ai-profiles", "browser");
}

// --- tiny JSON store helpers ---------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) {
    log("WARN write " + path.basename(file) + ": " + e.message);
  }
}

let settings = Object.assign(
  {
    port: 8787,
    leaseMax: 6,
    leaseTtlMs: 10 * 60 * 1000,
    profilesBase: defaultProfilesBase(),
    tunnelEnabled: true,
    autoStart: false,
    museUrl: "",
    worker: { url: "", token: "", enabled: false },
  },
  readJson(SETTINGS_FILE, {})
);
let members = readJson(MEMBERS_FILE, []); // [{id,name,key,created,lastUse}]
let meta = readJson(META_FILE, {}); // { name: {service,proxy,lastStatus,lastCheck} }

function saveSettings() {
  writeJson(SETTINGS_FILE, settings);
}
function saveMembers() {
  writeJson(MEMBERS_FILE, members);
}
function saveMeta() {
  writeJson(META_FILE, meta);
}

// --- live log ring buffer -------------------------------------------------
const logBuf = [];
function log(line) {
  const entry = { t: Date.now(), line: String(line) };
  logBuf.push(entry);
  if (logBuf.length > 400) logBuf.shift();
  try {
    process.stdout.write("[pm] " + entry.line + "\n");
  } catch {}
  if (win && !win.isDestroyed()) win.webContents.send("log", entry);
}

// --- pool + tunnel state --------------------------------------------------
let pool = null;
let tunnel = null;
let tunnelUrl = null;

function metaFor(name) {
  return meta[name] || { service: "gemini", proxy: null };
}

function startPoolSrv() {
  if (pool) return { ok: true, already: true };
  try {
    pool = startPool({
      port: settings.port,
      profilesBase: settings.profilesBase,
      workerPath: WORKER,
      nodeBin: process.execPath, // electron.exe + ELECTRON_RUN_AS_NODE (set by pool-core)
      leaseMax: settings.leaseMax,
      leaseTtlMs: settings.leaseTtlMs,
      getKeys: () => members.map((m) => m.key),
      getMeta: (name) => metaFor(name),
      onEvent: (ev) => log(ev.line),
    });
    log("pool started on :" + settings.port);
    return { ok: true };
  } catch (e) {
    log("pool start failed: " + e.message);
    pool = null;
    return { ok: false, error: e.message };
  }
}
async function stopPoolSrv() {
  if (pool) {
    await pool.stop();
    pool = null;
    log("pool stopped");
  }
}

function startTun() {
  if (tunnel || !settings.tunnelEnabled) return;
  tunnelUrl = null;
  tunnel = startTunnel({
    port: settings.port,
    resourcesDir: process.resourcesPath,
    onLog: (s) => {
      /* keep tunnel logs quiet unless URL */
    },
    onUrl: (u) => {
      tunnelUrl = u;
      log("tunnel URL: " + u);
      if (win && !win.isDestroyed()) win.webContents.send("tunnel", { url: u });
      pushUrlToWorker(u);
    },
    onExit: (code) => {
      log("tunnel exited (" + code + ")");
      tunnel = null;
      tunnelUrl = null;
      if (win && !win.isDestroyed()) win.webContents.send("tunnel", { url: null });
    },
  });
  log("tunnel starting…");
}
function stopTun() {
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
    tunnelUrl = null;
  }
}

// Optional: publish the current URL to the Ultron CF worker for discovery.
function pushUrlToWorker(url) {
  const w = settings.worker || {};
  if (!w.enabled || !w.url || !w.token) return;
  try {
    const u = new URL(w.url.replace(/\/$/, "") + "/pool-url");
    const data = JSON.stringify({ url });
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      u,
      { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": w.token, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        log("worker /pool-url <- " + res.statusCode);
        res.resume();
      }
    );
    req.on("error", (e) => log("worker push failed: " + e.message));
    req.write(data);
    req.end();
  } catch (e) {
    log("worker push error: " + e.message);
  }
}

// --- profiles -------------------------------------------------------------
function scanProfileDirs() {
  const base = settings.profilesBase;
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, "Default")))
      .map((d) => d.name);
  } catch {}
  return dirs;
}
function listProfiles() {
  const names = scanProfileDirs();
  const st = pool ? pool.status() : null;
  const stateOf = (n) => {
    if (!st) return "stopped";
    const p = (st.profiles || []).find((x) => x.name === n);
    return p ? p.state : "free";
  };
  return names.map((n) => {
    const m = metaFor(n);
    return {
      name: n,
      service: m.service || "gemini",
      proxy: m.proxy || null,
      state: stateOf(n),
      lastStatus: m.lastStatus || "unknown",
      lastCheck: m.lastCheck || 0,
    };
  });
}

// --- window ---------------------------------------------------------------
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    title: "Ultron Pool Manager",
    backgroundColor: "#0b0f17",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on("console-message", (e, level, message, lineNo, src) => {
    try {
      process.stdout.write(`[renderer:${lineNo}] ${message}\n`);
    } catch {}
  });
  win.webContents.on("preload-error", (e, pth, err) => {
    try {
      process.stdout.write(`[preload-error] ${pth} :: ${err && err.message}\n`);
    } catch {}
  });
  win.webContents.on("render-process-gone", (e, d) => {
    try {
      process.stdout.write(`[render-gone] ${JSON.stringify(d)}\n`);
    } catch {}
  });
  win.webContents.on("did-fail-load", (e, code, desc, url) => {
    try {
      process.stdout.write(`[did-fail-load] ${code} ${desc} ${url}\n`);
    } catch {}
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// --- auto-update (electron-updater against the GitHub release feed) -------
let updateInfo = null;
function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) {
    log("auto-update: " + (autoUpdater ? "dev mode (skipped)" : "updater not available"));
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => log("update: checking…"));
  autoUpdater.on("update-available", (i) => log("update available: v" + i.version + " (downloading…)"));
  autoUpdater.on("update-not-available", () => log("update: already latest"));
  autoUpdater.on("error", (e) => log("update error: " + (e && e.message)));
  autoUpdater.on("download-progress", (p) => {
    if (win && !win.isDestroyed()) win.webContents.send("update", { stage: "progress", percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (i) => {
    updateInfo = i;
    log("update downloaded: v" + i.version + " — Restart to apply");
    if (win && !win.isDestroyed()) win.webContents.send("update", { stage: "ready", version: i.version });
  });
  const check = () => autoUpdater.checkForUpdates().catch((e) => log("update check failed: " + (e && e.message)));
  check();
  setInterval(check, 6 * 60 * 60 * 1000); // every 6h
}

app.whenReady().then(() => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
  } catch {}
  createWindow();
  // auto-start pool + tunnel on launch
  startPoolSrv();
  startTun();
  setupAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await stopPoolSrv();
  stopTun();
  app.quit();
});

// ======================= IPC =======================
ipcMain.handle("status", () => ({
  poolRunning: !!pool,
  tunnelUrl,
  tunnelEnabled: !!settings.tunnelEnabled,
  port: settings.port,
  pool: pool ? pool.status() : { total: scanProfileDirs().length, free: 0, leased: 0, busy: 0, activeLeases: 0, profiles: [] },
  playwright: login.hasPlaywright(),
}));

ipcMain.handle("pool:start", () => {
  const r = startPoolSrv();
  startTun();
  return r;
});
ipcMain.handle("pool:stop", async () => {
  await stopPoolSrv();
  stopTun();
  return { ok: true };
});

ipcMain.handle("log:get", () => logBuf.slice(-200));

// members
ipcMain.handle("members:list", () => members);
ipcMain.handle("members:add", (e, name) => {
  const m = { id: crypto.randomBytes(5).toString("hex"), name: String(name || "member").slice(0, 60), key: "key-" + crypto.randomBytes(16).toString("hex"), created: Date.now(), lastUse: 0 };
  members.push(m);
  saveMembers();
  log("member added: " + m.name);
  return m;
});
ipcMain.handle("members:renew", (e, id) => {
  const m = members.find((x) => x.id === id);
  if (m) {
    m.key = "key-" + crypto.randomBytes(16).toString("hex");
    saveMembers();
    log("member key renewed: " + m.name);
  }
  return m || null;
});
ipcMain.handle("members:delete", (e, id) => {
  const i = members.findIndex((x) => x.id === id);
  if (i >= 0) {
    log("member deleted: " + members[i].name);
    members.splice(i, 1);
    saveMembers();
  }
  return { ok: true };
});

// profiles
ipcMain.handle("profiles:list", () => listProfiles());
ipcMain.handle("profiles:add", async (e, { service }) => {
  const svc = service === "muse" ? "muse" : "gemini";
  // pick next free name: gemini1.. / muse1..
  const existing = new Set(scanProfileDirs());
  let n = 1;
  while (existing.has(svc + n)) n++;
  const name = svc + n;
  const dir = path.join(settings.profilesBase, name);
  meta[name] = { service: svc, proxy: svc === "muse" ? settings.museProxy || null : null, lastStatus: "unknown", lastCheck: 0 };
  saveMeta();
  log("add profile: " + name + " (" + svc + ") — Chrome khul raha hai, sign in karein…");
  try {
    const r = await login.interactiveLogin({ dir, service: svc, museUrl: settings.museUrl, onState: () => {} });
    meta[name].lastStatus = r.loggedIn ? "logged_in" : "needs_login";
    meta[name].lastCheck = Date.now();
    saveMeta();
    if (pool) pool.rescan();
    log("profile " + name + ": " + (r.loggedIn ? "logged in ✓" : "not confirmed (re-login if needed)"));
    return { ok: true, name, loggedIn: r.loggedIn };
  } catch (err) {
    log("profile add failed: " + err.message);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("profiles:relogin", async (e, name) => {
  const m = metaFor(name);
  const dir = path.join(settings.profilesBase, name);
  const st = pool ? pool.status() : null;
  const pst = st && (st.profiles || []).find((x) => x.name === name);
  if (pst && (pst.state === "busy" || pst.state === "leased")) return { ok: false, error: "profile busy — abhi istemal mein hai, baad mein" };
  log("re-login: " + name + " — Chrome khul raha hai…");
  try {
    const r = await login.interactiveLogin({ dir, service: m.service, museUrl: settings.museUrl, onState: () => {} });
    meta[name] = Object.assign(metaFor(name), { lastStatus: r.loggedIn ? "logged_in" : "needs_login", lastCheck: Date.now() });
    saveMeta();
    if (pool) pool.rescan();
    return { ok: true, loggedIn: r.loggedIn };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("profiles:delete", async (e, name) => {
  const st = pool ? pool.status() : null;
  const pst = st && (st.profiles || []).find((x) => x.name === name);
  if (pst && (pst.state === "busy" || pst.state === "leased")) return { ok: false, error: "profile busy — pehle release hone do" };
  try {
    fs.rmSync(path.join(settings.profilesBase, name), { recursive: true, force: true });
    delete meta[name];
    saveMeta();
    if (pool) pool.rescan();
    log("profile deleted: " + name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("profiles:check", async (e, name) => {
  const m = metaFor(name);
  const dir = path.join(settings.profilesBase, name);
  const r = await login.checkLoggedIn({ dir, service: m.service, museUrl: settings.museUrl, proxy: m.proxy });
  meta[name] = Object.assign(metaFor(name), { lastStatus: r.loggedIn ? "logged_in" : "needs_login", lastCheck: Date.now() });
  saveMeta();
  return r;
});

// settings
ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:set", async (e, patch) => {
  const portChanged = patch.port && patch.port !== settings.port;
  settings = Object.assign(settings, patch);
  if (patch.worker) settings.worker = Object.assign({ url: "", token: "", enabled: false }, patch.worker);
  saveSettings();
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
  } catch {}
  if (portChanged && pool) {
    await stopPoolSrv();
    stopTun();
    startPoolSrv();
    startTun();
  }
  return settings;
});

ipcMain.handle("open-external", (e, url) => {
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("update:check", () => {
  if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch((e) => log("update check: " + e.message));
  return { ok: true, ready: !!updateInfo, version: updateInfo ? updateInfo.version : null };
});
ipcMain.handle("update:install", () => {
  if (autoUpdater && updateInfo) {
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  }
  return { ok: false, error: "no update ready" };
});
