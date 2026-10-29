#!/usr/bin/env node
// ============================================================
//  ULTRON — GEMINI POOL worker (one task on one logged-in profile).
//
//  Runs a TEXT prompt through Gemini (3.1 Pro) in a logged-in AI-Profile
//  session, in the BACKGROUND (headless), and writes the answer out. The pool
//  manager (/api/ai/gemini) picks a random free profile and spawns this.
//
//  Big prompt + answer go through FILES (env paths), not argv/env, so the long
//  viral-clip prompt + transcript fit.
//
//  Env:
//    GEMINI_PROFILE   profile folder name (from AI Profiles)
//    PROFILES_BASE    ai-profiles base dir (browser/<name>/)
//    GEMINI_IN        path to a UTF-8 file with the prompt
//    GEMINI_OUT       path to write the result JSON {ok,text,model,error,reason}
//    GEMINI_MODEL     model label to select (default "3.1 Pro")
//    GEMINI_HEADLESS  "0" to show the window (default background/headless)
//
//  Exit: 0 ok · 4 needs_login · 3 no_chrome · 1 error. Never prints the prompt
//  or the answer to stdout (logs stay clean); only short diagnostics.
// ============================================================
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error("[X] playwright not available");
    process.exit(2);
  }
}
const fs = require("fs");
const path = require("path");

const PROFILE = (process.env.GEMINI_PROFILE || "").trim();
const BASE = process.env.PROFILES_BASE || path.join(process.cwd(), "ai-profiles");
const IN = process.env.GEMINI_IN || "";
const OUT = process.env.GEMINI_OUT || "";
const MODEL = (process.env.GEMINI_MODEL || "3.1 Pro").trim();
const HEADLESS = process.env.GEMINI_HEADLESS !== "0";

function out(obj) {
  try {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(obj));
  } catch {}
}
function log(...a) {
  console.log("[gpool]", ...a);
}

if (!PROFILE) {
  out({ ok: false, error: "no profile" });
  process.exit(1);
}
const PROFILE_DIR = path.join(BASE, "browser", PROFILE);
const prompt = (() => {
  try {
    return fs.readFileSync(IN, "utf8");
  } catch {
    return "";
  }
})();
if (!prompt) {
  out({ ok: false, error: "empty prompt" });
  process.exit(1);
}

const LAUNCH = {
  headless: HEADLESS, // playwright-core wants a boolean (not "new")
  channel: "chrome",
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ],
};

async function isSignedIn(page) {
  const url = page.url();
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) return false;
  if (!/gemini\.google\.com/i.test(url)) return false;
  const composer = await page
    .locator('rich-textarea, [contenteditable="true"], textarea')
    .first()
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  return composer;
}

// Try to switch to the requested model (e.g. "3.1 Pro"). Best-effort: logs the
// switcher candidates + menu options it sees (so selectors can be refined from
// the diagnostics), clicks the closest match, never throws.
async function selectModel(page) {
  try {
    // Give the top bar a moment to render, then DUMP it so we can see the real
    // model-switcher structure in the logs and craft the exact selector.
    await page.waitForTimeout(1500);
    const diag = await page
      .evaluate(() => {
        const btns = [];
        const els = document.querySelectorAll('button,[role="button"],[aria-haspopup]');
        for (let i = 0; i < els.length && btns.length < 30; i++) {
          const b = els[i];
          const text = (b.innerText || b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
          const aria = (b.getAttribute("aria-label") || "").slice(0, 30);
          if (text || aria) btns.push((text || "·") + (aria ? " @" + aria : ""));
        }
        // anything on the page that looks like a model name
        const modelish = [];
        for (const el of document.querySelectorAll("button,span,div,[role]")) {
          const t = (el.innerText || "").trim().replace(/\s+/g, " ");
          if (t && t.length < 30 && /flash|\bpro\b|2\.\d|3\.\d|advanced|thinking/i.test(t))
            modelish.push(t);
          if (modelish.length >= 12) break;
        }
        return { url: location.href, title: document.title, btns, modelish: [...new Set(modelish)] };
      })
      .catch((e) => ({ err: e.message }));
    log("PAGE:", diag.url, "|", diag.title);
    log("BTNS:", JSON.stringify(diag.btns || []).slice(0, 700));
    log("MODELISH:", JSON.stringify(diag.modelish || []).slice(0, 400));

    // Accounts show one of two UIs:
    //  (A) a MODEL dropdown in the composer ("Flash"/"Fast"/"Thinking"/named
    //      model) → pick the Pro model.
    //  (B) a "mode picker" (Gemini 3: Auto/Low/Medium/High) → pick High (best
    //      quality). Try (A) first, then (B).
    // The model/mode switcher sits in the composer. On most accounts it is the
    // button labelled "Open mode picker, currently <model>"; some show a bare
    // model-name button. Match broadly (aria first, then model-name texts) and
    // WAIT for it to render — the composer loads async, which is why it was
    // sometimes missed and we fell back to the default model.
    const kind = "mode";
    const trigSel = [
      'button[aria-label*="mode picker" i]',
      'button[aria-label*="currently" i]',
      'button:has-text("Gemini Auto")',
      'button:has-text("Flash")',
      'button:has-text("Thinking")',
      'button:has-text("2.5 Pro")',
      'button:has-text("3 Pro")',
      'button:has-text("3.1 Pro")',
      'button:has-text("4 Argon")',
    ].join(", ");
    let trig = page.locator(trigSel).first();
    try {
      await trig.waitFor({ state: "visible", timeout: 9000 });
    } catch {}
    if (!(await trig.count().catch(() => 0))) {
      // one more settle + retry before giving up
      await page.waitForTimeout(2500);
      trig = page.locator(trigSel).first();
      if (!(await trig.count().catch(() => 0))) {
        log("no model/mode switcher found — using default");
        return "default";
      }
    }
    // Prefer the "3.1 Pro" model, then any non-Flash Pro, then High thinking.
    const want = [
      (t) => /3\.?\d*\s*pro/i.test(t) && !/flash/i.test(t),
      (t) => /\bpro\b/i.test(t) && !/flash/i.test(t),
      (t) => /\bhigh\b/i.test(t) || /extra thorough/i.test(t),
    ];

    // The menu can be slow to render, so open→read→match is retried once with a
    // longer wait before giving up on the default model.
    let clicked = "";
    for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
      await trig.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(attempt === 0 ? 1300 : 2400);

      const opts = page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]');
      const n = Math.min(await opts.count().catch(() => 0), 25);
      const labels = [];
      for (let i = 0; i < n; i++) {
        labels.push((await opts.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 40));
      }
      log(`MENU(${kind}) try${attempt}:`, JSON.stringify(labels).slice(0, 500));

      for (const match of want) {
        for (let i = 0; i < n; i++) {
          if (labels[i] && match(labels[i])) {
            await opts.nth(i).click({ timeout: 2500 }).catch(() => {});
            clicked = labels[i].slice(0, 30);
            break;
          }
        }
        if (clicked) break;
      }
      if (!clicked) await page.keyboard.press("Escape").catch(() => {}); // close, retry
    }
    await page.keyboard.press("Escape").catch(() => {});
    log(`${kind} selected:`, clicked || "(none matched — default)");
    return clicked || "default";
  } catch (e) {
    log("selectModel error:", e.message);
    return "error";
  }
}

async function sendPrompt(page) {
  const input = page.locator('rich-textarea [contenteditable="true"], [contenteditable="true"], textarea').first();
  await input.waitFor({ state: "visible", timeout: 20000 });
  await input.click({ timeout: 5000 }).catch(() => {});
  // contenteditable: use insertText so huge prompts go in at once
  await page.evaluate(() => {
    const el = document.querySelector('[contenteditable="true"], textarea');
    if (el && el.focus) el.focus();
  });
  await page.keyboard.insertText(prompt).catch(async () => {
    await input.fill(prompt).catch(() => {});
  });
  await page.waitForTimeout(400);
  // submit: send button, else Enter
  const sendBtn = page.locator('button[aria-label*="Send" i], button[aria-label*="Submit" i], button[mattooltip*="Send" i]').first();
  if (await sendBtn.count().catch(() => 0)) {
    await sendBtn.click({ timeout: 3000 }).catch(() => page.keyboard.press("Enter"));
  } else {
    await page.keyboard.press("Enter");
  }
}

// Read the latest response by polling until the text stops growing (bounded).
// Proven approach — the stop-button method could block for minutes in some UIs.
async function readAnswer(page) {
  const sel = ".response-container .markdown, .response-container, message-content, .model-response-text, .markdown";
  const getLast = () =>
    page
      .evaluate((s) => {
        const nodes = document.querySelectorAll(s);
        if (!nodes.length) return "";
        let t = (nodes[nodes.length - 1].innerText || "").trim();
        return t.replace(/Gemini is AI and can make mistakes\.?/gi, "").trim();
      }, sel)
      .catch(() => "");

  // Gemini keeps a <pending-response> element while generating. Done = that
  // element is gone AND the response has text. (These accounts can be slow —
  // up to a couple of minutes — so the cap is generous.)
  const t0 = Date.now();
  const cap = 240 * 1000;
  let txt = "";
  let prev = "";
  let stable = 0;
  let sawText = false;
  // Done requires BOTH: the <pending-response> element gone AND the text
  // unchanged for 2 consecutive polls — otherwise a long streaming answer
  // (e.g. a 15-clip JSON) gets read truncated the instant pending clears.
  while (Date.now() - t0 < cap) {
    await page.waitForTimeout(2000);
    const pending = await page.locator("pending-response").count().catch(() => 0);
    txt = await getLast();
    if (txt) sawText = true;
    const settled = !pending && sawText && txt.length > 0 && txt === prev;
    if (settled) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    prev = txt;
    if ((Date.now() - t0) % 16000 < 2000)
      log(`  waiting ${Math.round((Date.now() - t0) / 1000)}s pending=${pending} len=${txt.length}`);
  }
  log("answer in", Math.round((Date.now() - t0) / 1000) + "s, len", txt.length);
  return txt;
}

(async () => {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"])
    fs.rmSync(path.join(PROFILE_DIR, f), { force: true });

  // channel:"chrome" uses the system Google Chrome. If it isn't found (not
  // installed, or a non-standard path), retry with an explicit executablePath at
  // the common install locations, then give a CLEAR actionable error.
  const chromeExes = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter((p) => { try { return p && fs.existsSync(p); } catch { return false; } });

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH);
  } catch (e) {
    let launched = false;
    for (const exe of chromeExes) {
      try {
        ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...LAUNCH, channel: undefined, executablePath: exe });
        launched = true;
        log("launched Chrome via explicit path:", exe);
        break;
      } catch (e2) {
        log("chrome path retry failed:", exe, e2.message);
      }
    }
    if (!launched) {
      const reason = chromeExes.length
        ? e.message
        : "Google Chrome is not installed on this PC. Install it from https://www.google.com/chrome and restart Ultron (the AI-profile pool needs Chrome).";
      log("chrome launch failed:", reason);
      out({ ok: false, error: "no_chrome", reason });
      process.exit(3);
    }
  }

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);

    if (!(await isSignedIn(page))) {
      log("not signed in (profile needs re-login)");
      out({ ok: false, error: "needs_login", reason: "profile not signed in to Gemini" });
      await ctx.close().catch(() => {});
      process.exit(4);
    }

    const model = await selectModel(page);
    await page.waitForTimeout(800);

    log("sending prompt (", prompt.length, "chars )");
    await sendPrompt(page);
    const text = await readAnswer(page);
    log("answer length:", text.length);

    // Gemini sometimes returns a short soft-error instead of an answer when the
    // account is throttled / rate-limited. Treat it as a failure so the pool
    // rotates to another profile.
    const SOFT_ERR =
      /seem to be encountering an error|something went wrong|I'm not able to help|unable to (?:complete|process|generate)|try again later|high demand/i;
    if (!text) {
      out({ ok: false, error: "empty answer", model });
      await ctx.close().catch(() => {});
      process.exit(1);
    }
    if (text.length < 220 && SOFT_ERR.test(text)) {
      log("soft-error response (account likely throttled):", text.slice(0, 80));
      out({ ok: false, error: "soft_error", reason: text.slice(0, 180), model });
      await ctx.close().catch(() => {});
      process.exit(1);
    }
    out({ ok: true, text, model });
    await ctx.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    log("error:", e.message);
    out({ ok: false, error: e.message });
    try {
      await ctx.close();
    } catch {}
    process.exit(1);
  }
})();
