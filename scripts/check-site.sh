#!/usr/bin/env bash
# Checks an assembled site (see assemble-site.sh):
#   - HTML and CSS with the Nu HTML Checker (vnu), errors and warnings
#   - sitemap.xml is well-formed XML
#   - nothing is loaded from another origin (the site promises no third-party requests)
# Links and image paths are checked separately with lychee (see the workflows).
#
# Needs Java 11+ and python3. Usage: scripts/check-site.sh [site-dir]   (default: _site)
set -euo pipefail

site="${1:-_site}"
[ -f "$site/index.html" ] || { echo "No assembled site in $site; run scripts/assemble-site.sh first." >&2; exit 1; }

# vnu from the npm package vnu-jar, pinned and verified (sha512 from the registry).
VNU_VERSION="26.11.4"
VNU_SHA512="APphsztZwu5x+DCFEfHo64ORn+aRgZXMTat+FZWaYdFAeHCgK8bgxup0wCIfak0xllsnlaXHycmg91sIgtKIXw=="
cache="${VNU_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vnu-$VNU_VERSION}"
jar="$cache/package/build/dist/vnu.jar"
if [ ! -f "$jar" ]; then
	mkdir -p "$cache"
	curl -fsSL "https://registry.npmjs.org/vnu-jar/-/vnu-jar-$VNU_VERSION.tgz" -o "$cache/vnu.tgz"
	actual="$(openssl dgst -sha512 -binary "$cache/vnu.tgz" | openssl base64 -A)"
	if [ "$actual" != "$VNU_SHA512" ]; then
		echo "vnu-jar $VNU_VERSION checksum mismatch" >&2
		rm -f "$cache/vnu.tgz"
		exit 1
	fi
	tar -xzf "$cache/vnu.tgz" -C "$cache"
fi

echo "== HTML and CSS (vnu $VNU_VERSION)"
find "$site" -type f \( -name '*.html' -o -name '*.css' \) -print0 |
	xargs -0 java -jar "$jar" --Werror --also-check-css
echo "ok"

echo "== sitemap.xml"
python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$site/sitemap.xml"
echo "ok"

echo "== No third-party requests"
# Anything the browser fetches on its own: src, srcset, poster, stylesheets,
# preloads, icons, CSS url() and @import. Plain links (<a href>) are fine.
if grep -rnEi '(src|srcset|poster)="(https?:)?//|<link[^>]+href="(https?:)?//' "$site" --include='*.html' |
	grep -viE 'rel="(canonical|alternate)"'; then
	echo "The lines above load something from another origin." >&2
	exit 1
fi
if grep -rnEi 'url\((["'\'']?)(https?:)?//|@import' "$site" --include='*.css'; then
	echo "The CSS above loads something from another origin." >&2
	exit 1
fi
echo "ok"
