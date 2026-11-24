"""Stamp a content hash onto every local asset in index.html.

Without this, a browser that has already visited the site keeps serving its
cached data.js long after a new plan is deployed — the page looks updated
because index.html changed, while the data behind it is stale. Giving each file
a URL that changes when its contents change makes that impossible.

Idempotent: run it after any build. Usage: python3 stamp_assets.py
"""
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = HERE
INDEX = os.path.join(SITE, "index.html")

TAG_RE = re.compile(r'(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"]+)(")')


def main():
    html = open(INDEX, encoding="utf-8").read()
    stamped = []

    def replace(m):
        head, url, tail = m.groups()
        if "//" in url or url.startswith(("#", "data:", "mailto:")):
            return m.group(0)
        base = url.split("?", 1)[0]
        path = os.path.join(SITE, base)
        if not os.path.exists(path):
            sys.exit(f"index.html references {base}, which does not exist")
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()[:8]
        stamped.append((base, digest))
        return f"{head}{base}?v={digest}{tail}"

    out = TAG_RE.sub(replace, html)
    if out != html:
        open(INDEX, "w", encoding="utf-8").write(out)

    print("Stamped", len(stamped), "assets in index.html")
    for base, digest in stamped:
        print(f"  {base:<16} v={digest}")


if __name__ == "__main__":
    main()
