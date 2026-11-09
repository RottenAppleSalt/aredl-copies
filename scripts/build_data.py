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

API = "https://api.aredl.net/v2/api/aredl"
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


def main():
    levels = get_json(f"{API}/levels")
    print(f"Fetched {len(levels)} levels", flush=True)

    failed = []

    def fetch_copies(level):
        try:
            return level["id"], get_json(f"{API}/levels/{level['id']}/custom-copies")
        except Exception as err:  # noqa: BLE001
            failed.append(level["name"])
            print(f"Failed {level['name']}: {err}", file=sys.stderr)
            return level["id"], None

    with ThreadPoolExecutor(CONCURRENCY) as pool:
        copies_by_level = dict(pool.map(fetch_copies, levels))

    # A partial snapshot would silently hide copies, so refuse to publish one.
    if len(failed) > len(levels) * 0.02:
        sys.exit(f"{len(failed)} levels failed; not writing data.json")

    def person(p):
        if isinstance(p, dict):
            return p.get("global_name") or p.get("username")
        return None

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "levels": [
            {
                "id": l["id"],
                "name": l["name"],
                "position": l["position"],
                "gdId": l["level_id"],
                "twoPlayer": l["two_player"],
                "legacy": l["status"] == "Legacy",
                "copies": [
                    {
                        "copyId": c["copy_id"],
                        "type": c["id_type"],
                        "status": c["status"],
                        "description": c.get("description"),
                        "addedBy": person(c.get("added_by")),
                        "createdAt": c["created_at"],
                    }
                    for c in (copies_by_level.get(l["id"]) or [])
                ],
            }
            for l in levels
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    total = sum(len(l["copies"]) for l in out["levels"])
    print(f"Wrote {total} copies across {len(levels)} levels ({len(failed)} failed)")


if __name__ == "__main__":
    main()
