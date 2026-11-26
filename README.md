# shiru-extensions

Standalone structured-list extension repository for [Shiru](https://github.com/RockinChaos/Shiru), kept cleanly separate from the core app.

## Install in Shiru

1. Open **Settings → Extensions** in Shiru.
2. Add the repository:
   ```text
   gh:AitsukiNakuru67/shiru-extensions
   ```
3. Enable **Release Matcher** and open its settings (gear icon) to configure either:
   - **Feed URLs (On-Device):** Comma-separated RSS 2.0, Torznab 1.3, or JSON feed URLs (supports `{query}`, `{anilistId}`, `{malId}`, `{anidbId}`, `{episode}` placeholders). Runs Shiru's full episode matcher, verifier, and ranker locally inside the extension Web Worker.
   - **Release Index URL (Remote):** Base URL of a compatible release index server (HTTPS or `http://localhost:...`) serving `.list.json` v2.

## Building & Syncing Matcher Rules

```bash
pnpm install
pnpm run sync   # pulls pure-JS matcher core + tables from ../anime-release-index/src/shiru
pnpm run build  # bundles src/extension.js -> sources/release-index.js (single Worker ESM file)
pnpm test       # runs end-to-end tests against the built bundle
```
