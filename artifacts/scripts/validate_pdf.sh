#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  echo "usage: validate_pdf.sh <pdf> <html> <out-dir>" >&2
  exit 2
fi

PDF="$1"
HTML="$2"
OUT="$3"

for cmd in python3 pdfinfo pdftoppm awk; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done
echo "OK: required commands found"

[ -f "$PDF" ] || fail "PDF missing: $PDF"
[ -f "$HTML" ] || fail "HTML missing: $HTML"
echo "OK: input files found"

if [ "$(basename "$OUT")" != "validate" ]; then
  fail "out-dir must end in /validate"
fi
if [ -e "$OUT" ] && [ ! -d "$OUT" ]; then
  fail "out-dir exists but is not a directory: $OUT"
fi
rm -rf "$OUT"
mkdir -p "$OUT"
echo "OK: prepared validation output directory: $OUT"

# Integrity
head -c 4 "$PDF" | grep -q '^%PDF' || fail "not a PDF"
SIZE=$(wc -c <"$PDF")
echo "size=$SIZE bytes"
PDFINFO=$(pdfinfo "$PDF") || fail "pdfinfo failed"
printf '%s\n' "$PDFINFO" | grep -E '^(Pages|Page size):' || true
LAST=$(printf '%s\n' "$PDFINFO" | awk '/^Pages:/ {print $2; exit}')
case "$LAST" in
  ''|*[!0-9]*) fail "could not parse page count from pdfinfo" ;;
esac
[ "$LAST" -gt 0 ] || fail "could not determine a positive page count"
echo "OK: PDF integrity and metadata look valid"

# Image embedding sanity (if HTML has images, PDF should be image-heavy).
# Use an HTML parser so valid markup with single quotes, uppercase tags,
# whitespace around "=", or line-broken attributes is handled correctly.
HTML_COUNTS=$(
  python3 - "$HTML" <<'PY'
import re
import sys
from html.parser import HTMLParser


CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.imgs = 0
        self.data_uris = 0
        self.style_attrs = []
        self.style_blocks = []
        self.in_style = False

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attr_map = {name.lower(): value or "" for name, value in attrs}
        if tag == "style":
            self.in_style = True
        if tag == "img":
            self.imgs += 1
            if attr_map.get("src", "").strip().lower().startswith("data:"):
                self.data_uris += 1
        if "style" in attr_map:
            self.style_attrs.append(attr_map["style"])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag.lower() == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.style_blocks.append(data)

    def css_counts(self):
        urls = []
        for css in self.style_blocks + self.style_attrs:
            for match in CSS_URL_RE.finditer(css):
                value = match.group(2).strip()
                if value and not value.startswith("#"):
                    urls.append(value)
        data_uris = sum(1 for value in urls if value.lower().startswith("data:"))
        return len(urls), data_uris


parser = AssetParser()
with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    parser.feed(f.read())
css_urls, css_data_uris = parser.css_counts()
print(parser.imgs, parser.data_uris, css_urls, css_data_uris)
PY
)
set -- $HTML_COUNTS
IMGS="$1"
DATA_URIS="$2"
CSS_URLS="$3"
CSS_DATA_URIS="$4"
echo "imgs=$IMGS data-uri-srcs=$DATA_URIS"
echo "css-urls=$CSS_URLS css-data-uris=$CSS_DATA_URIS"
[ "$IMGS" -eq 0 ] || [ "$DATA_URIS" -eq "$IMGS" ] ||
  fail "$((IMGS - DATA_URIS)) <img> tag(s) are not data URIs"
[ "$CSS_URLS" -eq 0 ] || [ "$CSS_DATA_URIS" -eq "$CSS_URLS" ] ||
  fail "$((CSS_URLS - CSS_DATA_URIS)) CSS url(...) reference(s) are not data URIs"
echo "OK: HTML image references are embedded"

# Render every PDF page for visual validation.
pdftoppm -png -f 1 -l "$LAST" "$PDF" "$OUT/page"

PNG_COUNT=0
for png in "$OUT"/*.png; do
  [ -f "$png" ] || continue
  PNG_COUNT=$((PNG_COUNT + 1))
  PNG_SIZE=$(wc -c <"$png")
  echo "$png $PNG_SIZE bytes"
  if [ "$PNG_SIZE" -lt 20000 ]; then
    echo "WARN: $png is below 20 KB; inspect for a blank page" >&2
  fi
done
[ "$PNG_COUNT" -eq "$LAST" ] ||
  fail "rendered $PNG_COUNT validation PNG(s), expected $LAST PDF page(s)"
echo "OK: rendered $PNG_COUNT validation PNG(s) from the PDF"
echo "PASS: mechanical PDF validation complete; inspect rendered PNGs before returning the artifact."
