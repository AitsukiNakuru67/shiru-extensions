# shiru-extensions

Standalone extension repository for [Shiru](https://github.com/RockinChaos/Shiru), kept cleanly separate from the core app.

## Install in Shiru

1. Open **Settings → Extensions** in Shiru.
2. Add the repository:
   ```text
   gh:AitsukiNakuru67/shiru-extensions
   ```
3. Enable **Release Index** and open its extension settings (gear icon) to set your **Release Index URL** (HTTPS or `http://localhost:...`).

## Included Extension

- **`sources/release-index.js`** (`id: "release-index"`):
  - Implements Shiru's structured `list(query, { fresh })` contract, returning `.list.json` v2 (with fallback to `.rank.json` / `POST /rank`) so Shiru handles local ordering, sections, crowns, resolution switching, native tracker scraping, and AutoGrab directly on the user's device.
  - Also implements `single()` / `batch()` / `movie()` for backwards compatibility.
  - Can be replaced or extended with a fully on-device matcher running inside Shiru's extension Web Worker (`sources/abstract.js` + `index.d.ts`).
