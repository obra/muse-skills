import { test } from "bun:test";
import assert from "node:assert/strict";
import { rewriteCss, HATCH_FRAGMENT } from "./css-rewrite";

test("relative url(...) → data: pixel placeholder carrying the rel path", () => {
  const { code, stats } = rewriteCss(`.a{background:url(foo.png)}`);
  assert.match(code, /url\("data:image\/gif;base64,/);
  assert.match(code, new RegExp(`${HATCH_FRAGMENT}foo\\.png`));
  assert.equal(stats.urlTokens, 1);
  assert.equal(stats.rewritten, 1);
});

test("external / non-asset url() values are left untouched (counted, not rewritten)", () => {
  for (const ext of [
    "url(data:image/png;base64,AAAA)",
    "url(blob:abc)",
    "url(https://cdn.example/x.png)",
    "url(http://cdn.example/x.png)",
    "url(//cdn.example/x.png)",
    "url(about:blank)",
    "url(#svg-frag)",
  ]) {
    const { code, stats } = rewriteCss(`.a{background:${ext}}`);
    assert.equal(code, `.a{background:${ext}}`, ext);
    assert.equal(stats.urlTokens, 1, ext);
    assert.equal(stats.rewritten, 0, ext);
  }
});
