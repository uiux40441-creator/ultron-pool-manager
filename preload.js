"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pm", {
  status: () => ipcRenderer.invoke("status"),
  poolStart: () => ipcRenderer.invoke("pool:start"),
  poolStop: () => ipcRenderer.invoke("pool:stop"),
  logGet: () => ipcRenderer.invoke("log:get"),

  membersList: () => ipcRenderer.invoke("members:list"),
  memberAdd: (name) => ipcRenderer.invoke("members:add", name),
  memberRenew: (id) => ipcRenderer.invoke("members:renew", id),
  memberDelete: (id) => ipcRenderer.invoke("members:delete", id),

  profilesList: () => ipcRenderer.invoke("profiles:list"),
  profileAdd: (service) => ipcRenderer.invoke("profiles:add", { service }),
  profileRelogin: (name) => ipcRenderer.invoke("profiles:relogin", name),
  profileDelete: (name) => ipcRenderer.invoke("profiles:delete", name),
  profileCheck: (name) => ipcRenderer.invoke("profiles:check", name),

  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (patch) => ipcRenderer.invoke("settings:set", patch),

  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),

  onLog: (cb) => ipcRenderer.on("log", (e, entry) => cb(entry)),
  onTunnel: (cb) => ipcRenderer.on("tunnel", (e, data) => cb(data)),
  onUpdate: (cb) => ipcRenderer.on("update", (e, data) => cb(data)),
});
