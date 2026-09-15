#!/usr/bin/env python3
"""Stamp the cache-busting queries in www/index.html with BUILD_ID.

BUILD_ID lives once, in www/game.js. The <link>/<script> tags in index.html
carry the same id as a ?v= query so a browser refetches instead of serving a
stale bundle. Stamping it by hand meant three copies of the same number, and
one of them always rotted -- the exact stale-cache failure the game already
fought once with its service worker.

Usage:
    python tools/sync_build.py            rewrite index.html if out of date
    python tools/sync_build.py --check    exit 1 if out of date, write nothing
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "www" / "game.js"
HTML = ROOT / "www" / "index.html"


def build_id():
    m = re.search(r"const BUILD_ID = '([^']+)'", GAME.read_text(encoding="utf-8"))
    if not m:
        sys.exit("FATAL: BUILD_ID not found in www/game.js")
    return m.group(1)


def main():
    check = "--check" in sys.argv
    bid = build_id()
    text = HTML.read_text(encoding="utf-8")

    # Only the two game-asset queries are stamped; nothing else carries ?v=.
    updated = re.sub(
        r"((?:style\.css|game\.js))\?v=[^\s\"']+",
        r"\g<1>?v=" + bid,
        text,
    )

    if updated == text:
        print("index.html already stamped with BUILD_ID " + bid)
        return
    if check:
        print("index.html is out of date with BUILD_ID " + bid)
        sys.exit(1)
    HTML.write_text(updated, encoding="utf-8")
    print("index.html cache-bust queries stamped with BUILD_ID " + bid)


if __name__ == "__main__":
    main()
