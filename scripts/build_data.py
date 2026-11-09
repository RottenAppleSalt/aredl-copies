"""Builds site/data.json from the public AREDL API (read-only GET requests only).

Run: python scripts/build_data.py
The GitHub Actions workflow runs this every hour. Nothing is ever written back to AREDL,
and the site has no way to add or edit copies: it only displays what this script fetched.
"""

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

API_ROOT = "https://api.aredl.net/v2/api"
LISTS = ("aredl", "arepl")  # classic and platformer
CONCURRENCY = 2  # AREDL rate-limits bursts; 2 at a time stays well under it
OUT = Path(__file__).resolve().parent.parent / "site" / "data.json"


def get_json(url, tries=6):
    for attempt in range(tries):
        wait = 2 ** attempt
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": "aredl-copies-site (static mirror)",
            })
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code != 429 and err.code < 500:
                raise
            if attempt == tries - 1:
                raise
            if err.code == 429:
                retry_after = err.headers.get("Retry-After", "")
                wait = int(retry_after) if retry_after.isdigit() else 15 * (attempt + 1)
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
        time.sleep(wait)


def build_list(list_key):
    base = f"{API_ROOT}/{list_key}"
    # exclude_pending=false so pending levels are included too (the API hides them by default).
    levels = get_json(f"{base}/levels?exclude_pending=false")
    print(f"[{list_key}] fetched {len(levels)} levels", flush=True)

    failed = []

    def fetch_copies(level):
        try:
            return level["id"], get_json(f"{base}/levels/{level['id']}/custom-copies")
        except Exception as err:  # noqa: BLE001
            failed.append(level["name"])
            print(f"[{list_key}] failed {level['name']}: {err}", file=sys.stderr)
            return level["id"], None

    with ThreadPoolExecutor(CONCURRENCY) as pool:
        copies_by_level = dict(pool.map(fetch_copies, levels))

    # A partial snapshot would silently hide copies, so refuse to publish one.
    if len(failed) > len(levels) * 0.02:
        sys.exit(f"[{list_key}] {len(failed)} levels failed; not writing data.json")

    out = [
        {
            "id": l["id"],
            "name": l["name"],
            "position": l["position"],
            "gdId": l["level_id"],
            "twoPlayer": l["two_player"],
            "status": l["status"],  # MainList, Legacy or Pending
            "copies": [
                {
                    "copyId": c["copy_id"],
                    "type": c["id_type"],
                    "status": c["status"],
                    "description": c.get("description"),
                    "createdAt": c["created_at"],
                }
                for c in (copies_by_level.get(l["id"]) or [])
            ],
        }
        for l in levels
        if l["status"] != "Removed"
    ]
    total = sum(len(l["copies"]) for l in out)
    print(f"[{list_key}] {total} copies across {len(out)} levels ({len(failed)} failed)", flush=True)
    return out


def main():
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lists": {key: build_list(key) for key in LISTS},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
