# Self-Hosting Your Own Pre-Built Index Server

`shiru-extensions` supports **two modes** in one extension:

1. **On-Device Mode (zero setup, slower ~2–5 s cold search):** Configure **Feed URLs** directly in Shiru's extension settings. All fetching and matching runs on demand inside Shiru's Web Worker.
2. **Self-Hosted Pre-Builder Mode (millisecond responses):** Run the included lightweight Node server (`server/local-index.mjs`) on your PC, home server, NAS, or VPS. It pre-builds ranked episode files ahead of time to local disk + RAM so Shiru opens episode lists in **< 5 ms**.

---

## Option A — Run Directly on Your PC (Node.js 22+, no Docker needed)

1. Clone this repository:
   ```bash
   git clone https://github.com/AitsukiNakuru67/shiru-extensions.git
   cd shiru-extensions
   ```
2. Start the local pre-builder server (pass your feed URL template(s) and optionally your AniList username so your Watching list is pre-built automatically):

   **PowerShell (Windows):**
   ```powershell
   $env:FEED_URLS = "https://your-feed.example/api?t=tvsearch&q={query}"
   $env:ANILIST_USER = "YourAniListName"   # optional: pre-builds your Watching list
   $env:PREBUILD_AIRING = "1"              # pre-builds top airing episodes every 15 min
   node server/local-index.mjs
   ```

   **Bash (Linux / macOS):**
   ```bash
   FEED_URLS="https://your-feed.example/api?t=tvsearch&q={query}" \
   ANILIST_USER="YourAniListName" \
   PREBUILD_AIRING=1 \
   node server/local-index.mjs
   ```

3. Verify it is running:
   ```bash
   curl http://127.0.0.1:8787/health.json
   ```

---

## Option B — Run with Docker Compose (NAS / Home Server / VPS)

```bash
git clone https://github.com/AitsukiNakuru67/shiru-extensions.git
cd shiru-extensions
FEED_URLS="https://your-feed.example/api?t=tvsearch&q={query}" \
ANILIST_USER="YourAniListName" \
docker compose up -d --build
```

If exposing over the internet on a VPS, put Caddy / Nginx / Cloudflare Tunnel in front for HTTPS (`https://your-domain.example`). On the same PC, plain `http://127.0.0.1:8787` works directly without HTTPS.

---

## Connect Shiru to Your Self-Hosted Server

You can connect either way:

- **Via the Extension (`gh:AitsukiNakuru67/shiru-extensions`):**
  1. Open **Settings → Extensions → Release Matcher → Gear Icon**.
  2. Set **Release Index URL** to `http://127.0.0.1:8787` (or your HTTPS server URL).
- **Via Shiru's Built-In Custom Release Source:**
  1. Open **Settings → Extensions → Custom release source**.
  2. Enter `http://127.0.0.1:8787` and click **Apply**.

---

## Environment Variables Reference

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` inside Docker) |
| `PORT` | `8787` | HTTP port |
| `DATA_DIR` | `./data/cache` | Directory storing pre-built gzipped `.rank.json.gz` files |
| `SOURCES_URL` | `https://pixeldrain.com/api/filesystem/qkW71xWE/sources.json` | Remote JSON manifest listing feed sources and trackers (set `off` to disable) |
| `FEED_URLS` | *(empty)* | Optional extra comma-separated RSS 2.0, Torznab 1.3, or JSON feed URL templates (`{query}`, `{nativeQuery}`, `{anilistId}`, `{malId}`, `{anidbId}`, `{anidbEid}`, `{episode}`) |
| `ANILIST_USER` | *(empty)* | Optional AniList username — pre-builds next episodes of shows in `CURRENT` / `REPEATING` |
| `WATCH_ANILIST_IDS` | *(empty)* | Optional comma-separated AniList IDs to always pre-build |
| `PREBUILD_AIRING` | `1` | Pre-build latest aired episode of currently airing popular shows |
| `PREBUILD_LIMIT` | `25` | Number of airing shows pre-built per sweep |
| `REFRESH_MINUTES` | `15` | Background pre-build sweep interval (`0` disables background sweeps; on-demand caching still works) |
| `SITE_NAME` | `Local Pre-Built Index` | Brand name returned in `GET /site.json` |
| `SITE_TRACKERS` | *(empty)* | Optional comma-separated BitTorrent tracker URLs advertised in `/site.json` |
