// CSS url(...) rewriter for the CVM hermetic build. Replaces relative url(...)
// tokens with a real 1x1 transparent GIF data: URL whose fragment carries the
// rel path (`#hatch=<rel>`). The browser parses the placeholder silently (no
// network fetch); the runtime CSS observer (cvm/src/prelude.ts) later resolves
// each placeholder to a tunneled blob: URL. Covered by css-rewrite.test.ts.
//
// Why a real 1x1 GIF and not a fake scheme: a placeholder like
// `url(__hatch:foo)` makes the browser fire an immediate net::ERR_UNKNOWN_URL_
// SCHEME on rule application; a valid data: GIF "loads" with zero network, and
// the rel path rides the fragment for the runtime to pick up.
//
// Cases:
//   REWRITTEN (relative refs → placeholder, leading "./" and "/" stripped):
//     url(foo.png)        url('a/b.png')     url("../c.png")     url(/d.png)
//   LEFT ALONE (already loadable / not an asset ref):
//     url(data:...)  url(blob:...)  url(http://...)  url(https://...)
//     url(//host/...)   url(about:...)   url(#svg-fragment)
//
// Limitation: a url() value whose path itself contains an escaped ")" or quote
// is truncated by the token regex (the bundler does not emit such paths).

export interface CssStats {
  urlTokens: number;
  rewritten: number;
}

// 1x1 transparent GIF — the synchronous placeholder so the browser never fires
// an unresolvable fetch when it first parses the CSS. The per-URL path is
// encoded into the fragment (`#hatch=<rel>`).
const PIXEL_BASE =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
export const HATCH_FRAGMENT = "#hatch=";

export function rewriteCss(input: string): { code: string; stats: CssStats } {
  const stats: CssStats = { urlTokens: 0, rewritten: 0 };
  // Match url(...) with optional single/double quotes around the URL.
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const out = input.replace(re, (match, _quote, url) => {
    stats.urlTokens++;
    const u = String(url).trim();
    if (
      u.startsWith("data:") ||
      u.startsWith("blob:") ||
      u.startsWith("https://") ||
      u.startsWith("http://") ||
      u.startsWith("//") ||
      u.startsWith("about:")
    ) {
      return match;
    }
    if (u.startsWith("#")) {
      // SVG fragment reference — leave alone.
      return match;
    }
    // Strip leading "./" and "/"
    const rel = u.replace(/^\.?\/*/, "");
    stats.rewritten++;
    return `url("${PIXEL_BASE}${HATCH_FRAGMENT}${encodeURIComponent(rel)}")`;
  });
  return { code: out, stats };
}
