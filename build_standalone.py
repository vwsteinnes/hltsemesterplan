"""Inline site/{style.css,data.js,app.js} into one portable HTML file.

Usage: python3 build_standalone.py
Output: HLT-Semesterplan-H26.html  (open by double-clicking, no server needed)
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = HERE
OUT = os.path.join(HERE, "HLT-Semesterplan-H26.html")


def read(name):
    # Tags carry a ?v=<hash> cache-buster; the file on disk has no query.
    path = os.path.join(SITE, name.split("?", 1)[0])
    if not os.path.exists(path):
        sys.exit("Missing " + path)
    with open(path, encoding="utf-8") as f:
        return f.read()


def guard(js):
    """A literal </script> inside inlined JS would close the tag early."""
    return js.replace("</script", "<\\/script")


html = read("index.html")
css = read("style.css")

# A plain replacement string would have its backslashes eaten by re.subn,
# corrupting every regex literal in the JS; a function replacement is literal.
def literal(text):
    return lambda _match: text


# <link rel="stylesheet" href="style.css">  ->  inline <style>
html, n = re.subn(
    r'[ \t]*<link[^>]*href="style\.css(?:\?[^"]*)?"[^>]*>\s*',
    literal("  <style>\n" + css + "\n  </style>\n"),
    html,
)
if n != 1:
    sys.exit(f"Expected exactly 1 style.css link, replaced {n}")

# Inline every local <script src="...">, in the order the page loads them.
script_srcs = re.findall(r'<script src="([^"]+)"></script>', html)
if not script_srcs:
    sys.exit("Found no local script tags to inline")
for src in script_srcs:
    html, n = re.subn(
        r'[ \t]*<script src="' + re.escape(src) + r'"></script>\s*',
        literal("  <script>\n" + guard(read(src)) + "\n  </script>\n"),
        html,
    )
    if n != 1:
        sys.exit(f"Expected exactly 1 script tag for {src}, replaced {n}")

# Nothing external may remain, or the file is not portable.
leftover = re.findall(r'(?:src|href)="(?!#)([^"]+)"', html)
if leftover:
    sys.exit("Still references external files: " + ", ".join(leftover))

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

# A copy ready for GitHub Pages, which serves docs/index.html as the site root.
PAGES_DIR = os.path.join(HERE, "docs")
os.makedirs(PAGES_DIR, exist_ok=True)
with open(os.path.join(PAGES_DIR, "index.html"), "w", encoding="utf-8") as f:
    f.write(html)
# Stops Jekyll touching the file at all.
open(os.path.join(PAGES_DIR, ".nojekyll"), "a").close()

print("Wrote:", OUT)
print("Wrote:", os.path.join(PAGES_DIR, "index.html"))
print("Size: {:.0f} KB".format(os.path.getsize(OUT) / 1024))
