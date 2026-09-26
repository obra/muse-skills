import { test } from "bun:test";
import assert from "node:assert/strict";
import { rewriteHtml } from "./html-rewrite";

test("relative URL attrs → data-hatch-<attr>", () => {
  const { code, stats } = rewriteHtml(`<img src="photo.png">`);
  assert.match(code, /data-hatch-src="photo\.png"/);
  assert.doesNotMatch(code, /\ssrc=/);
  assert.equal(stats.attrsRewritten, 1);
});

test("external attr values are left as-is", () => {
  const { code, stats } = rewriteHtml(`<img src="https://cdn.example/x.png">`);
  assert.match(code, /\ssrc="https:\/\/cdn\.example\/x\.png"/);
  assert.doesNotMatch(code, /data-hatch-src/);
  assert.equal(stats.attrsRewritten, 0);
});

test("<style> body is run through the CSS rewriter", () => {
  const { code, stats } = rewriteHtml(
    `<style>.a{background:url(bg.png)}</style>`,
  );
  assert.match(code, /data:image\/gif;base64,/);
  assert.match(code, /#hatch=bg\.png/);
  assert.equal(stats.inlineStyleBlocks, 1);
  assert.equal(stats.cssUrlTokens, 1);
});

test("inline style='...url(...)' → data-hatch-style with rewritten CSS", () => {
  const { code, stats } = rewriteHtml(
    `<div style="background:url(hero.png)"></div>`,
  );
  assert.match(code, /data-hatch-style=/);
  assert.match(code, /#hatch=hero\.png/);
  assert.doesNotMatch(code, /\sstyle=/);
  assert.equal(stats.styleAttrs, 1);
});
