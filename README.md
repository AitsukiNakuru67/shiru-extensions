# shiru-extensions

Standalone structured-list extension repository and optional self-hosted pre-builder server for [Shiru](https://github.com/RockinChaos/Shiru), kept cleanly separate from the core app.

## Two Modes in One Extension

| Mode | Speed | Setup | Best For |
| --- | --- | --- | --- |
| **1. On-Device Live Mode** (`Sources Manifest URL` / `Feed URLs`) | ~2–6 s cold search | Works out of the box via the permanent Sources Manifest — no server needed | General users who want zero hosting |
| **2. Self-Hosted Pre-Builder Mode** (`Release Index URL`) | **< 5 ms** (pre-built ahead of time) | Run `node server/local-index.mjs` or `docker compose up -d` | Instant episode loading on your PC, NAS, or VPS |

## Sanitized Seed Snapshot

A stripped, public-only seed archive (`seed.tar.zst`, ~180 MB) with verified episode answers, listings, and tracker counts — with all private/Usenet/proxy/server state removed — is available at a permanent download link. See **[SEED.md](SEED.md)** for the direct link, SHA-256 checksum, and extraction commands.

## Install in Shiru

1. Open **Settings → Extensions** in Shiru.
2. Add the repository:
   ```text
   gh:AitsukiNakuru67/shiru-extensions
   ```
3. Enable **Release Matcher** and click its settings gear icon:
   - For **On-Device Mode**: enter your **Feed URLs** (comma-separated RSS 2.0, Torznab 1.3, or JSON templates with `{query}`, `{anilistId}`, `{malId}`, `{anidbId}`, `{episode}`).
   - For **Self-Hosted Mode**: enter your **Release Index URL** (e.g. `http://127.0.0.1:8787` or your HTTPS server URL).

## Self-Hosting Your Own Fast Pre-Built Server

See the complete guide in [docs/self-hosting.md](docs/self-hosting.md) — quick start with Node 22+:

```bash
git clone https://github.com/AitsukiNakuru67/shiru-extensions.git
cd shiru-extensions
FEED_URLS="https://your-feed.example/api?t=tvsearch&q={query}" node server/local-index.mjs
```

Or with Docker Compose:

```bash
FEED_URLS="https://your-feed.example/api?t=tvsearch&q={query}" docker compose up -d --build
```

## Syncing Matcher Rules & Testing

```bash
pnpm install
pnpm run sync   # pulls pure-JS matcher core + tables from ../anime-release-index/src/shiru
pnpm run build  # bundles src/extension.js -> sources/release-index.js (single Worker ESM file)
pnpm test       # runs extension + local pre-builder server tests
```
