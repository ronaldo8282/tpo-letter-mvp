# TPO Letter Hourglass — GitHub Pages snapshot

Static export of the Flask MVP (single-pin highlights + prior features).
Loads `data/profiles.json` (no backend).

## Local check
Serve this folder (Pages needs HTTP, not `file://` for fetch):

```bash
cd pages-dist && python3 -m http.server 8787
```

Open: http://127.0.0.1:8787/?v=single-pin-1

## Deploy (parent / GitHub MCP)
Push contents of this folder to a repo Pages root (or `/docs`), e.g.:

- Repo suggestion: `ronaldo8282/tpo-letter-mvp` (or branch `gh-pages`)
- Public URL shape: `https://ronaldo8282.github.io/tpo-letter-mvp/`
- Existing Pages site `rs-us-daily` can host under a subpath if preferred.

Include: `index.html`, `app.js`, `data/profiles.json`, `sample.csv` (optional).

Snapshot: HSIF TV profiles, ~half-year sessions, points=5, HK alphabet, session 0930→0300.
