"use strict";
const $ = (id) => document.getElementById(id);
const api = window.pm;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}
function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- tabs ----
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "profiles") loadProfiles();
    if (t.dataset.tab === "members") loadMembers();
    if (t.dataset.tab === "settings") loadSettings();
  };
});

// ---- dashboard status ----
let running = false;
async function refreshStatus() {
  const s = await api.status();
  running = s.poolRunning;
  $("poolDot").className = "dot " + (running ? "on" : "off");
  $("poolText").textContent = running ? "running on :" + s.port : "stopped";
  $("togglePool").textContent = running ? "Stop" : "Start";
  const p = s.pool || {};
  $("cTotal").textContent = p.total ?? "–";
  $("cFree").textContent = p.free ?? "–";
  $("cLeased").textContent = p.leased ?? "–";
  $("cBusy").textContent = p.busy ?? "–";
  $("cLeases").textContent = p.activeLeases ?? "–";
  if (s.tunnelUrl) {
    $("urlField").value = s.tunnelUrl;
    $("urlHint").textContent = "Members ye URL + apni key use karte hain. (Restart par badal sakta hai.)";
  } else {
    $("urlField").value = "";
    $("urlField").placeholder = s.tunnelEnabled ? "tunnel starting…" : "tunnel off (Settings se on karo)";
  }
  if (!s.playwright) $("pwWarn").style.display = "block";
}

$("togglePool").onclick = async () => {
  $("togglePool").disabled = true;
  if (running) await api.poolStop();
  else await api.poolStart();
  await refreshStatus();
  $("togglePool").disabled = false;
};
$("copyUrl").onclick = () => {
  const v = $("urlField").value;
  if (v) {
    navigator.clipboard.writeText(v);
    toast("URL copied");
  }
};
$("openUrl").onclick = () => {
  const v = $("urlField").value;
  if (v) api.openExternal(v + "/pool/status");
};

// ---- live log ----
function appendLog(entry) {
  const el = $("log");
  const ts = new Date(entry.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  el.textContent += `${ts}  ${entry.line}\n`;
  el.scrollTop = el.scrollHeight;
}
api.onLog(appendLog);
api.onTunnel(() => refreshStatus());

// ---- auto-update banner ----
api.onUpdate((d) => {
  if (d.stage === "ready") {
    let bar = $("updateBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "updateBar";
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;background:#1f6feb;color:#fff;padding:9px 16px;display:flex;align-items:center;justify-content:center;gap:12px;z-index:50;font-size:13px";
      document.body.appendChild(bar);
    }
    bar.innerHTML = `Update v${d.version} ready. <button id="doUpdate" class="btn" style="background:#fff;color:#1f6feb;font-weight:600">Restart & update</button>`;
    $("doUpdate").onclick = () => api.updateInstall();
  } else if (d.stage === "progress") {
    toast("Updating… " + d.percent + "%");
  }
});

// ---- profiles ----
function badge(status, state) {
  if (state === "busy" || state === "leased") return `<span class="badge amber">🟡 ${state}</span>`;
  if (status === "logged_in") return `<span class="badge green">🟢 logged in</span>`;
  if (status === "needs_login") return `<span class="badge red">🔴 needs re-login</span>`;
  return `<span class="badge gray">⚪ unknown</span>`;
}
async function loadProfiles() {
  const rows = await api.profilesList();
  const tb = $("profRows");
  tb.innerHTML = "";
  $("profEmpty").style.display = rows.length ? "none" : "block";
  for (const p of rows) {
    const busy = p.state === "busy" || p.state === "leased";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${p.name}</b></td>
      <td>${p.service}</td>
      <td>${badge(p.lastStatus, p.state)}</td>
      <td>${busy ? p.state : "—"}</td>
      <td><div class="rowact">
        <button class="btn" data-act="relogin" data-n="${p.name}" ${busy ? "disabled" : ""}>Re-login</button>
        <button class="btn" data-act="check" data-n="${p.name}">Check</button>
        <button class="btn btn-danger" data-act="del" data-n="${p.name}" ${busy ? "disabled" : ""}>Delete</button>
      </div></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("button[data-act]").forEach((b) => {
    b.onclick = () => profileAction(b.dataset.act, b.dataset.n, b);
  });
}
async function profileAction(act, name, btn) {
  if (act === "del") {
    if (!confirm(`Delete profile "${name}"? (dubara login karna padega)`)) return;
    const r = await api.profileDelete(name);
    toast(r.ok ? "deleted" : r.error);
    loadProfiles();
  } else if (act === "relogin") {
    toast("Chrome khul raha hai — sign in karein…");
    const r = await api.profileRelogin(name);
    toast(r.ok ? (r.loggedIn ? "logged in ✓" : "band ho gaya — check karo") : r.error);
    loadProfiles();
  } else if (act === "check") {
    btn.disabled = true;
    btn.textContent = "…";
    await api.profileCheck(name);
    btn.disabled = false;
    btn.textContent = "Check";
    loadProfiles();
  }
}
$("addGemini").onclick = async () => {
  toast("Chrome khul raha hai — Gemini me sign in karein…");
  const r = await api.profileAdd("gemini");
  toast(r.ok ? "profile added: " + r.name : r.error);
  loadProfiles();
  refreshStatus();
};
$("addMuse").onclick = async () => {
  toast("Chrome khul raha hai — Muse me sign in karein…");
  const r = await api.profileAdd("muse");
  toast(r.ok ? "profile added: " + r.name : r.error);
  loadProfiles();
  refreshStatus();
};
$("checkAll").onclick = async () => {
  const rows = await api.profilesList();
  toast("Checking " + rows.length + " profiles…");
  for (const p of rows) await api.profileCheck(p.name);
  loadProfiles();
  toast("status updated");
};

// ---- members ----
async function loadMembers() {
  const rows = await api.membersList();
  const tb = $("memRows");
  tb.innerHTML = "";
  $("memEmpty").style.display = rows.length ? "none" : "block";
  for (const m of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${m.name}</b></td>
      <td><code>${m.key}</code></td>
      <td>${fmtDate(m.created)}</td>
      <td><div class="rowact">
        <button class="btn" data-act="copy" data-id="${m.id}">Copy key</button>
        <button class="btn" data-act="renew" data-id="${m.id}">Renew</button>
        <button class="btn btn-danger" data-act="del" data-id="${m.id}">Delete</button>
      </div></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("button[data-act]").forEach((b) => {
    b.onclick = () => memberAction(b.dataset.act, b.dataset.id);
  });
}
async function memberAction(act, id) {
  const rows = await api.membersList();
  const m = rows.find((x) => x.id === id);
  if (act === "copy") {
    if (m) {
      navigator.clipboard.writeText(m.key);
      toast("key copied: " + m.name);
    }
  } else if (act === "renew") {
    if (!confirm(`Renew ${m ? m.name : ""}? Purani key band ho jayegi.`)) return;
    await api.memberRenew(id);
    toast("key renewed");
    loadMembers();
  } else if (act === "del") {
    if (!confirm(`Delete member ${m ? m.name : ""}? Uski key band ho jayegi.`)) return;
    await api.memberDelete(id);
    toast("deleted");
    loadMembers();
  }
}
$("addMember").onclick = async () => {
  const name = $("memberName").value.trim() || "member";
  await api.memberAdd(name);
  $("memberName").value = "";
  loadMembers();
  toast("member added");
};

// ---- settings ----
async function loadSettings() {
  const s = await api.settingsGet();
  $("sPort").value = s.port;
  $("sLease").value = s.leaseMax;
  $("sTtl").value = Math.round(s.leaseTtlMs / 60000);
  $("sMuseUrl").value = s.museUrl || "";
  $("sMuseProxy").value = s.museProxy || "";
  $("sTunnel").checked = !!s.tunnelEnabled;
  $("sAutoStart").checked = !!s.autoStart;
  const w = s.worker || {};
  $("sWorkerEnabled").checked = !!w.enabled;
  $("sWorkerUrl").value = w.url || "";
  $("sWorkerToken").value = w.token || "";
}
$("saveSettings").onclick = async () => {
  const patch = {
    port: Number($("sPort").value) || 8787,
    leaseMax: Number($("sLease").value) || 6,
    leaseTtlMs: (Number($("sTtl").value) || 10) * 60000,
    museUrl: $("sMuseUrl").value.trim(),
    museProxy: $("sMuseProxy").value.trim(),
    tunnelEnabled: $("sTunnel").checked,
    autoStart: $("sAutoStart").checked,
    worker: { enabled: $("sWorkerEnabled").checked, url: $("sWorkerUrl").value.trim(), token: $("sWorkerToken").value.trim() },
  };
  await api.settingsSet(patch);
  $("saveMsg").textContent = "saved ✓ (port change par pool restart)";
  toast("settings saved");
  refreshStatus();
};

// ---- boot ----
(async function () {
  console.log("PM renderer booted ok; api=" + (api ? "present" : "MISSING"));
  (await api.logGet()).forEach(appendLog);
  await refreshStatus();
  setInterval(refreshStatus, 3000);
})();
