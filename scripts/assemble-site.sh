#!/usr/bin/env bash
# Assembles the website into one folder: the pages from site/ plus the
# screenshots from docs/listing/ (kept in one place, used by README and site).
# No build step beyond copying and filling in the site address.
#
# Usage: scripts/assemble-site.sh [output-dir]   (default: _site)
set -euo pipefail

# The site's public address, with a trailing slash. The custom domain itself is
# set in the repository's Pages settings (no CNAME file: Pages ignores it when
# deploying from a workflow); the old github.io address redirects to it.
SITE_URL="${SITE_URL:-https://keyhole.dbraendle.com/}"

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-_site}"

case "$SITE_URL" in
	https://*/) ;;
	*) echo "SITE_URL must start with https:// and end with /: $SITE_URL" >&2; exit 1 ;;
esac

rm -rf "$out"
mkdir -p "$out/listing"
cp -R "$root/site/." "$out/"
cp "$root"/docs/listing/*.png "$out/listing/"

# Absolute URLs (canonical, Open Graph, sitemap) need the address; everything
# else on the site uses relative paths.
find "$out" -type f \( -name '*.html' -o -name '*.xml' -o -name '*.txt' \) -print0 |
	while IFS= read -r -d '' f; do
		sed "s|{{SITE_URL}}|${SITE_URL}|g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
	done

if grep -rl '{{' "$out" --include='*.html' --include='*.xml' --include='*.txt'; then
	echo "Unfilled placeholders left in the files above." >&2
	exit 1
fi

echo "Site assembled in $out for $SITE_URL"
