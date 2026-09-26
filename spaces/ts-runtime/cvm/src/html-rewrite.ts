// HTML rewriter for the entry index.html — swap URL-bearing attrs to
// data-hatch-* placeholders, run inline <style> through the CSS rewriter,
// and run inline style="..." through the CSS rewriter. The runtime
// (cvm/src/prelude.ts) later resolves each data-hatch-* placeholder over the
// tunnel. Covered by html-rewrite.test.ts.
//
// Cases:
//   <style>…</style> body            → CSS-rewritten in place (see css-rewrite)
//   URL attrs on img/image/video/audio/source/script/link/iframe/embed/object/
//     track/input/form/button/use (src/srcset/poster/href/data/action/formaction)
//                                     → data-hatch-<attr>="<value>"  (relative only)
//   style="…url(…)…" on any element  → data-hatch-style="<CSS-rewritten value>"
//   LEFT ALONE:
//     <a href> / <area href> / <base href>  (navigation/metadata, not a fetch)
//     any attr whose value is external (data:/blob:/http(s)://, //, about:, #)
//     elements/attrs not in the URL-attr table
//
// Why placeholders, not direct rewrites: an unresolved real URL on a parsed
// <img src>/<link href> would make the browser fire a doomed fetch; moving it
// to data-hatch-* keeps it inert until the runtime tunnels it.
//
// Limitations (acceptable — bundler entry HTML is simple/controlled): regex
// attribute matching is substring-anchored on \b<attr>, so a contrived attr
// name containing another (e.g. data-src vs src) could match loosely; values
// spanning newlines or with embedded quotes are not handled.

import { rewriteCss } from "./css-rewrite";

const HTML_TAG_ATTRS: Record<string, string[]> = {
  img: ["src", "srcset", "poster"],
  image: ["href"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcset"],
  script: ["src"],
  link: ["href"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  track: ["src"],
  input: ["src"],
  form: ["action"],
  button: ["formaction"],
  use: ["href"],
};

export interface HtmlStats {
  attrsRewritten: number;
  inlineStyleBlocks: number;
  styleAttrs: number;
  cssUrlTokens: number;
}

function isExternalUrl(u: string): boolean {
  return (
    u.startsWith("data:") ||
    u.startsWith("blob:") ||
    u.startsWith("https://") ||
    u.startsWith("http://") ||
    u.startsWith("//") ||
    u.startsWith("about:") ||
    u.startsWith("#")
  );
}

export function rewriteHtml(input: string): { code: string; stats: HtmlStats } {
  const stats: HtmlStats = {
    attrsRewritten: 0,
    inlineStyleBlocks: 0,
    styleAttrs: 0,
    cssUrlTokens: 0,
  };

  let out = input;

  // 1) <style>...</style> blocks
  out = out.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_m, attrs, body) => {
      stats.inlineStyleBlocks++;
      const r = rewriteCss(body);
      stats.cssUrlTokens += r.stats.rewritten;
      return `<style${attrs}>${r.code}</style>`;
    }
  );

  // 2) Tag attrs
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m, tag, attrs) => {
    const lc = String(tag).toLowerCase();
    if (lc === "a" || lc === "area" || lc === "base") return m; // metadata href
    if (lc === "style") return m; // <style>...</style> handled above
    const candidates = HTML_TAG_ATTRS[lc];

    let modifiedAttrs = attrs as string;

    if (candidates) {
      for (const a of candidates) {
        const re = new RegExp(
          `\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
          "i"
        );
        const matched = modifiedAttrs.match(re);
        if (!matched) continue;
        const value = matched[2] ?? matched[3] ?? matched[4] ?? "";
        if (isExternalUrl(value)) continue;
        modifiedAttrs = modifiedAttrs.replace(
          re,
          `data-hatch-${a}="${value.replace(/"/g, "&quot;")}"`
        );
        stats.attrsRewritten++;
      }
    }

    // Inline style="..." with url(...)
    const styleRe = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i;
    const sm = modifiedAttrs.match(styleRe);
    if (sm) {
      const value = sm[2] ?? sm[3] ?? "";
      if (value.includes("url(")) {
        const r = rewriteCss(value);
        stats.styleAttrs++;
        stats.cssUrlTokens += r.stats.rewritten;
        // Swap to data-hatch-style for runtime resolution
        modifiedAttrs = modifiedAttrs.replace(
          styleRe,
          `data-hatch-style="${r.code.replace(/"/g, "&quot;")}"`
        );
      }
    }

    return `<${tag}${modifiedAttrs}>`;
  });

  return { code: out, stats };
}
