# Ultron Pool Manager

A standalone desktop app (Electron) that runs a **central Gemini/Muse profile‑lease pool** with a GUI:

- **Dashboard** — start/stop the pool, live status, the public URL (built‑in Cloudflare tunnel), live log.
- **Profiles** — add / delete / re‑login Gemini (and Muse) browser profiles, with a live status light.
- **Members** — issue, renew and revoke per‑member API keys; see which member has which key.
- **Settings** — port, lease size/timeout, tunnel, start‑with‑Windows, optional stable‑URL push to the Ultron worker.

Auto‑updates from this repo's releases (electron‑updater).

Isolated from the main Ultron app — it only reads the shared `ai-profiles` folder and its own data.

## Run (dev)
```
npm install
npm start
```

## Build installer
```
npm run dist
```
