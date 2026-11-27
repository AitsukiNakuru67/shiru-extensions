# Sanitized Release Index Seed Snapshot

Pre-populated, sanitized seed snapshot for self-hosting a fast release index without crawling from scratch. Hosted on Pixeldrain Filesystem with a **permanent public URL** (no API key required) that is updated in place whenever a newer snapshot is published.

## Download

| File | Permanent URL | Size | SHA-256 |
| --- | --- | --- | --- |
| **Seed Archive (`.tar.zst`)** | https://pixeldrain.com/api/filesystem/qkW71xWE/seed.tar.zst | 180.3 MB (`189,109,151` bytes) | `adca905ead7392852aaf14a1894e71293f9a61540946ffeb00d6abe7840294d4` |
| **Live Seed Metadata (`.json`)** | https://pixeldrain.com/api/filesystem/qkW71xWE/seed.json | — | Check `sha256` & `generatedAt` inside JSON for latest snapshot |

*Snapshot timestamp:* `2026-11-27T02:00:51Z`

## Quick Download & Extract

### Linux / macOS (with `zstd` + `tar`)
```bash
curl -fL "https://pixeldrain.com/api/filesystem/qkW71xWE/seed.tar.zst" -o seed.tar.zst
sha256sum seed.tar.zst
mkdir -p ./data
tar --zstd -xf seed.tar.zst -C ./data
```

### Windows / Cross-Platform (Node.js 22+, no `zstd` binary needed)
```powershell
curl.exe -fL "https://pixeldrain.com/api/filesystem/qkW71xWE/seed.tar.zst" -o seed.tar.zst
New-Item -ItemType Directory -Force -Path .\data | Out-Null
node -e "const fs=require('fs'),zlib=require('zlib'),{spawn}=require('child_process');const t=spawn('tar',['-xf','-','-C','./data'],{stdio:['pipe','inherit','inherit']});fs.createReadStream('seed.tar.zst').pipe(zlib.createZstdDecompress()).pipe(t.stdin);"
```

## What Is Included

Public, non-sensitive release metadata, verified episode answers, existence checks, and public tracker swarm counts:

- `live/serve/current.json`
- `live/serve/live/episode-answers.jsonl`
- `live/serve/live/releases.jsonl`
- `live/serve/live/existence.json`, `existence-sukebei.json`, `existence-dmhy.json`, `existence-mikan.json`
- `live/serve/live/airing.json`, `catalog-extra.json`, `one-number-copies.json`, `stale-carry.json`, `zero-copies.jsonl`
- `live/serve/live/meta/`, `live/serve/live/syoboi/`
- `cloud/swarm/state.json`, `cloud/swarm/journal.jsonl`
- `nyaa/listing.jsonl`
- `sukebei/listing.jsonl`, `sukebei/live-releases.jsonl`

## Stripped / Excluded (Sensitive & Operational State)

The following paths from private server backups are **never** included in the public seed:

- `usenet/` (private NZB caches, API ledgers, and queues)
- `cloud/egress-traffic.json` (proxy port/IP telemetry)
- `cloud/requests-queue.json`, `cloud/rejudge-state.json`, `cloud/server-written.json`, `cloud/poller-state.json`, `cloud/shared.json`
- `live/serve/events/`, `live/serve/scheduler/`, `live/serve/live/answer-detail/`
- `nyaa/crawl-schedule.json`
- All API keys, credentials, and environment variables
