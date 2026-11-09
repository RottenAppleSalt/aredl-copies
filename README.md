# AREDL Copies

A public, read-only list of every custom copy (Published, Allowed and Banned) for every level on the
All Rated Extreme Demons List, including copies that aren't shown on aredl.net.

## How it works

- `scripts/build_data.py` calls the public AREDL API (`GET /levels`, then `GET /levels/{id}/custom-copies`
  for each level) and writes `site/data.json`. It only makes GET requests.
- `.github/workflows/deploy.yml` runs that script every hour and publishes `site/` to GitHub Pages.
- The page (`site/`) loads `data.json` once, caches it in the browser, and searches it locally, so search is instant.
  - Auto-refreshes the cached data after an hour.
  - Refresh button with a 30 second cooldown (kept across page reloads).
  - When a search narrows to 3 levels or fewer, those levels are re-checked live against the AREDL API,
    so a level you look up is always current (marked "● live").
- Copies whose description mentions `sp`, `startpos`, `start pos`, etc. get a blue **StartPos** tag.

There's no way to add or edit copies here: no forms, no backend, no write requests, and a Content Security
Policy that only allows requests to this site and `api.aredl.net`. The only way the data changes is
AREDL staff changing it on AREDL.

## Deploy (GitHub Pages, free)

1. Create a **public** repository on GitHub and push this folder to its `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to **Actions → Update data and deploy → Run workflow** (or just push). The first run takes ~6 minutes.
4. The site appears at `https://<your-username>.github.io/<repo-name>/`.

GitHub pauses scheduled workflows in a repo that has had no commits for 60 days (it emails you first).
If that happens, open the Actions tab and click **Enable workflow**, or push any small commit.

## Run locally

```
python scripts/build_data.py
python -m http.server 8765 --directory site
```

Then open http://localhost:8765.
