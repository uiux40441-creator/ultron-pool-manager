"use strict";
// =====================================================================
// Ultron Pool Manager — PROFILE LOGIN / CHECK helper.
// Opens the system Chrome for a profile so the user can sign in by hand
// (add a new account, or re-login an expired one), and a headless check
// that reports whether a profile's session is still alive.
//
// Launch config matches Ultron's production ai-login worker: it drops
// Playwright's automation flags so the normal human sign-in page works.
// The user always signs in themselves; no credentials are handled here.
// =====================================================================
const fs = require("fs");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  try {
    ({ chromium } = require("playwright"));
  } catch {
    chromium = null;
  }
}

const LAUNCH = {
  channel: "chrome",
  viewport: null,
  acceptDownloads: true,
  ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
  args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
};

function chromeExes() {
  return [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

async function launchCtx(dir, headless) {
  if (!chromium) throw new Error("playwright-core not installed");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
  const opts = { ...LAUNCH, headless: !!headless, args: [...LAUNCH.args, ...(headless ? [] : ["--start-maximized"])] };
  try {
    return await chromium.launchPersistentContext(dir, opts);
  } catch (e) {
    for (const exe of chromeExes()) {
      try {
        return await chromium.launchPersistentContext(dir, { ...opts, channel: undefined, executablePath: exe });
      } catch {}
    }
    throw new Error("Could not open Chrome (install Google Chrome). " + e.message);
  }
}

// Service config: where to send the user to sign in, and how to tell "logged in".
function serviceCfg(service, museUrl) {
  if (service === "muse") {
    return {
      url: museUrl || "https://www.muse.ai",
      loggedIn: async (page) => {
        const u = page.url();
        // generic: not on a login/signin path and page has typical app chrome
        return !/sign[-_ ]?in|login|auth/i.test(u);
      },
    };
  }
  // gemini (default)
  return {
    url: "https://accounts.google.com/ServiceLogin?continue=" + encodeURIComponent("https://gemini.google.com/app"),
    loggedIn: async (page) => {
      const u = page.url();
      if (/accounts\.google\.com|ServiceLogin|signin/i.test(u)) return false;
      if (!/gemini\.google\.com/i.test(u)) return false;
      const hasComposer = await page
        .locator('rich-textarea, [contenteditable="true"], textarea')
        .first()
        .count()
        .then((c) => c > 0)
        .catch(() => false);
      const body = (await page.innerText("body").catch(() => "")) || "";
      return hasComposer && !/Sign in to|Sign in\b/i.test(body.slice(0, 600));
    },
  };
}

// Read the signed-in Google account email from a Gemini page (best-effort).
async function extractEmail(page) {
  try {
    return await page.evaluate(() => {
      const rx = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
      // 1) the account switcher button usually has it in aria-label / alt
      for (const sel of ['a[aria-label*="@"]', '[aria-label*="Account"]', 'img[alt*="@"]', 'a[href*="accounts.google.com/SignOutOptions"]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent || "");
          const m = t.match(rx);
          if (m) return m[0];
        }
      }
      // 2) fallback: scan the DOM text
      const m2 = (document.body.innerText || "").match(rx);
      return m2 ? m2[0] : "";
    });
  } catch {
    return "";
  }
}

// Open a visible Chrome for the user to sign in; resolves when they close it.
// onState(status) is called with "logged_in" once the session looks good.
async function interactiveLogin({ dir, service, museUrl, onState }) {
  const ctx = await launchCtx(dir, false);
  const cfg = serviceCfg(service, museUrl);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  let marked = false;
  let email = "";
  const timer = setInterval(async () => {
    try {
      if (!marked && (await cfg.loggedIn(page))) {
        marked = true;
        if (service !== "muse") email = await extractEmail(page);
        onState && onState("logged_in");
      }
    } catch {}
  }, 4000);
  const killAt = Date.now() + 20 * 60 * 1000; // 20-min safety
  const guard = setInterval(() => {
    if (Date.now() > killAt) ctx.close().catch(() => {});
  }, 15000);
  await new Promise((res) => ctx.on("close", res));
  clearInterval(timer);
  clearInterval(guard);
  let finalOk = marked;
  try {
    if (!finalOk) finalOk = await cfg.loggedIn(page).catch(() => false);
    if (finalOk && !email && service !== "muse") email = await extractEmail(page).catch(() => "");
  } catch {}
  return { ok: true, loggedIn: finalOk, email };
}

// Headless probe: is this profile still signed in? (~a few seconds)
async function checkLoggedIn({ dir, service, museUrl, proxy }) {
  if (!fs.existsSync(path.join(dir, "Default"))) return { ok: true, loggedIn: false, reason: "no profile" };
  let ctx;
  try {
    const base = { ...LAUNCH, headless: true };
    if (proxy) base.proxy = { server: proxy };
    ctx = await chromium.launchPersistentContext(dir, base).catch(async () => {
      for (const exe of chromeExes()) {
        try {
          return await chromium.launchPersistentContext(dir, { ...base, channel: undefined, executablePath: exe });
        } catch {}
      }
      return null;
    });
    if (!ctx) return { ok: false, loggedIn: false, reason: "no chrome" };
    const cfg = serviceCfg(service, museUrl);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(cfg.url.replace(/^https:\/\/accounts\.google\.com.*continue=/, "").startsWith("http")
      ? decodeURIComponent(cfg.url.split("continue=")[1] || cfg.url)
      : cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const li = await cfg.loggedIn(page).catch(() => false);
    let email = "";
    if (li && service !== "muse") email = await extractEmail(page).catch(() => "");
    return { ok: true, loggedIn: li, email };
  } catch (e) {
    return { ok: false, loggedIn: false, reason: e.message };
  } finally {
    try {
      ctx && (await ctx.close());
    } catch {}
  }
}

module.exports = { interactiveLogin, checkLoggedIn, hasPlaywright: () => !!chromium };
