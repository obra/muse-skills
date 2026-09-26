import { test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { rewriteAst } from "./ast-rewrite";

// One case per distinct tunnel-escape vector. Syntax-shape siblings
// (literal vs variable args, static vs computed keys, NS variants) are
// deliberately not enumerated.

function rw(src: string) {
  return rewriteAst(src);
}

test("fetch(...) → __tunnel.fetch(...)", () => {
  const { code, stats } = rw(`fetch("/data");`);
  assert.match(code, /__tunnel\.fetch\(/);
  assert.equal(stats.fetch, 1);
});

test("navigator.sendBeacon(...) → __tunnel.sendBeacon(...)", () => {
  const { code, stats } = rw(`navigator.sendBeacon("/log", body);`);
  assert.match(code, /__tunnel\.sendBeacon\(/);
  assert.equal(stats.sendBeacon, 1);
});

test("new XMLHttpRequest / WebSocket / EventSource / Worker → new __tunnel.<Class>", () => {
  const x = rw(`new XMLHttpRequest();`);
  assert.match(x.code, /new __tunnel\.XHR\(\)/);
  assert.equal(x.stats.xhr, 1);

  const w = rw(`new WebSocket("/ws");`);
  assert.match(w.code, /new __tunnel\.WebSocket\(/);
  assert.equal(w.stats.ws, 1);

  const e = rw(`new EventSource("/stream");`);
  assert.match(e.code, /new __tunnel\.EventSource\(/);
  assert.equal(e.stats.eventSource, 1);

  const k = rw(`new Worker("./w.js");`);
  assert.match(k.code, /new __tunnel\.Worker\(/);
  assert.equal(k.stats.worker, 1);
});

test("dynamic import(spec) → __tunnel.import(spec)", () => {
  const { code, stats } = rw(`const m = await import("./mod.js");`);
  assert.match(code, /__tunnel\.import\("\.\/mod\.js"\)/);
  assert.equal(stats.importExpr, 1);
});

test("el.style.NAME = v → __tunnel.setStyle(el, 'NAME', v)", () => {
  const { code, stats } = rw(`node.style.backgroundImage = v;`);
  assert.match(code, /__tunnel\.setStyle\(node, "backgroundImage", v\)/);
  assert.equal(stats.styleAssign, 1);
});

test("attribute rewrites preserve library objects while DOM assets wait for the tunnel", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./prelude.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  assert.equal(build.success, true);

  // The document stays loading and the parent port is deliberately absent:
  // no local asset URL may reach the DOM while the tunnel is unavailable.
  class Element {
    attributes = new Map<string, string>();
    constructor(public tagName: string) {}
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    setAttributeNS(_ns: string, name: string, value: string) {
      this.setAttribute(name, value);
    }
  }
  const sandbox = {
    Element,
    EventTarget,
    URL: class extends URL {},
    location: { href: "https://space.invalid/index.html" },
    document: { readyState: "loading", addEventListener() {} },
    window: { addEventListener() {} },
    assert,
    foreignImage: runInNewContext(`
      class Element {
        tagName = "IMG";
        ownerDocument = { defaultView: { Element } };
        setAttribute(name, value) { this[name] = value; }
      }
      new Element();
    `),
  };
  const source = String.raw`
    class Geometry {
      attributes = new Map();
      setAttribute(name, value, extra) {
        this.attributes.set(name, value);
        this.extra = extra;
        return this;
      }
      setAttributeNS(ns, name, value, extra) {
        this.namespace = ns;
        return this.setAttribute(name, value, extra);
      }
      rotateX() {
        this.attributes.get("position").applyMatrix4();
        return this;
      }
    }
    const position = {
      rotations: 0,
      applyMatrix4() { this.rotations++; },
      toString() { throw new Error("geometry attribute was coerced"); }
    };
    const geometry = new Geometry();
    const extra = {};
    const result = geometry.setAttribute("position", position, ...[extra]);
    assert.equal(result, geometry);
    geometry.rotateX();
    assert.equal(position.rotations, 1);
    assert.equal(geometry.extra, extra);
    assert.equal(geometry.setAttribute("position", null), geometry);
    assert.equal(geometry.attributes.get("position"), null);
    const name = {};
    assert.equal(geometry.setAttributeNS(extra, name, position, extra), geometry);
    assert.equal(geometry.attributes.get(name), position);
    assert.equal(geometry.namespace, extra);
    assert.equal(geometry.extra, extra);
    assert.equal(geometry.data = position, position);
    assert.equal(geometry.data, position);
    assert.equal(geometry.formAction = null, null);
    assert.equal(geometry.formAction, null);
    assert.equal(Object.hasOwn(geometry, "formaction"), false);
    assert.throws(() => ({}).setAttribute("position", position), TypeError);

    const img = new Element("IMG");
    const attr = "src";
    img.setAttribute(attr, "./terrain.png");
    assert.match(img.attributes.get("src"), /^data:image\//);
    const button = new Element("BUTTON");
    assert.equal(button.formAction = "./submit", "./submit");
    assert.equal(button.attributes.has("formaction"), false);
    const svg = new Element("use");
    svg.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "./sprite.svg#tree");
    assert.equal(svg.attributes.has("xlink:href"), false);
    foreignImage.setAttribute(attr, "./leaves.png");
    assert.match(foreignImage.src, /^data:image\//);
    assert.equal(__tunnel._state.blobCacheSize, 4);
  `;
  runInNewContext(await build.outputs[0].text() + "\n" + rw(source).code, sandbox);
});

test("el.innerHTML / outerHTML = v → __tunnel.setInnerHTML(el, v, kind)", () => {
  const a = rw(`el.innerHTML = html;`);
  assert.match(a.code, /__tunnel\.setInnerHTML\(el, html, "innerHTML"\)/);
  assert.equal(a.stats.innerHtmlAssign, 1);

  const b = rw(`el.outerHTML = html;`);
  assert.match(b.code, /__tunnel\.setInnerHTML\(el, html, "outerHTML"\)/);
  assert.equal(b.stats.innerHtmlAssign, 1);
});

test("read of el.style → __tunnel.getStyle(el)", () => {
  const { code } = rw(`var s = el.style;`);
  assert.match(code, /__tunnel\.getStyle\(el\)/);
});

test("guard: bundle carrying the tunnel marker is returned untouched", () => {
  const src = `/* __HATCH_TUNNEL_SOURCE__ */ fetch("/x");`;
  const { code, skipped } = rw(src);
  assert.equal(skipped, true);
  assert.equal(code, src);
});

test("guard: eval( always throws — its source is unknowable at build time", () => {
  assert.throws(() => rw(`eval("1+1");`), /eval/);
  assert.throws(() => rw(`window.eval("1+1");`), /eval/);
});

test("guard: Function( admits only a statically knowable, inert body", () => {
  // The globalThis shim UMD wrappers, core-js and regenerator emit. Bare call
  // and constructor forms are judged identically.
  assert.doesNotThrow(() => rw(`var g = Function("return this")();`));
  assert.doesNotThrow(() => rw(`var g = new Function("return this")();`));

  // A constructed body that could reach the network or mutate a URL-bearing
  // DOM attribute is still rejected on both forms.
  assert.throws(() => rw(`Function("return fetch(u)");`), /Function/);
  assert.throws(() => rw(`new Function("document.body.innerHTML = x");`), /Function/);

  // Fails closed on anything it cannot read: a non-literal argument, or a
  // computed member access that hides the property name.
  assert.throws(() => rw(`Function(buildSource());`), /Function/);
  assert.throws(() => rw(`Function("return this['fet' + 'ch']");`), /Function/);

  // A forbidden name only matters where it is a *reference*. Property keys and
  // binding positions merely spell the word and cannot reach the global, so
  // rejecting them would re-create the false-positive build failures this
  // guard exists to remove.
  assert.doesNotThrow(() => rw(`Function("return {style:1}");`));
  assert.doesNotThrow(() => rw(`Function("var href=0;return this");`));
  assert.doesNotThrow(() => rw(`Function("fetch","return 1");`));

  // But a shorthand property is a real reference, not a key, and it hands the
  // live global back to the caller.
  assert.throws(() => rw(`Function("return {fetch}");`), /Function/);
  assert.throws(() => rw(`Function("return fetch");`), /Function/);
  // A non-computed member property is still judged by name.
  assert.throws(() => rw(`Function("return a.href");`), /Function/);

  // A write through a member never reaches `__tunnel.setAttr`, so the URL
  // would be assigned raw and never resolve in the opaque-origin iframe.
  // Judged by shape, not by property name: `poster` and the rest of
  // URL_PROP_NAMES are not in DYNAMIC_BODY_FORBIDDEN_NAMES, and URL-bearing
  // CSS property names are open-ended.
  assert.throws(() => rw(`Function("el","u","el.poster = u");`), /Function/);
  assert.throws(() => rw(`new Function("el","u","el.poster = u");`), /Function/);
  assert.throws(() => rw(`Function("f","u","f.action = u");`), /Function/);
  assert.throws(
    () => rw(`Function("a","u","var s = a.style; s.backgroundImage = u");`),
    /Function/,
  );

  // `a?.style` is a distinct node type from `a.style` and must be judged the
  // same way; the reference-position narrowing above exempts its property.
  assert.throws(() => rw(`Function("a","u","var h = a?.href; return h");`), /Function/);
  assert.throws(
    () => rw(`Function("a","u","var s = a?.style; s.backgroundImage = u");`),
    /Function/,
  );

  // A write target nests through destructuring and loop heads, so the check
  // recurses. Judged by shape: none of these property names is on the
  // forbidden-name list, so a top-level-only check admits every one.
  assert.throws(() => rw(`Function("el","u","[el.poster] = [u]");`), /Function/);
  assert.throws(
    () => rw(`Function("el","u","({p: el.poster} = {p: u})");`),
    /Function/,
  );
  assert.throws(() => rw(`Function("el","us","for (el.poster of us) {}");`), /Function/);
  assert.throws(() => rw(`Function("el","o","for (el.poster in o) {}");`), /Function/);
  assert.throws(() => rw(`Function("el","u","[el.poster = 1] = []");`), /Function/);
  assert.throws(() => rw(`Function("el","el.poster++");`), /Function/);
  // A loop head that declares its own binding reaches no existing object.
  assert.doesNotThrow(() => rw(`Function("us","for (var x of us) {}");`));

  // `with` rebinds bare identifiers to an arbitrary object at runtime, so a
  // URL-bearing write has neither a member for the shape check nor a
  // referenced identifier for the name check. Judged closed as a construct:
  // the first two were admitted before, and only the third ever rejected,
  // and then only because `style` happens to be a forbidden name.
  assert.throws(() => rw(`Function("u","with(location){href=u}");`), /Function/);
  assert.throws(() => rw(`Function("el","u","with(el){src=u}");`), /Function/);
  assert.throws(
    () => rw(`Function("el","u","with(el.style){backgroundImage=u}");`),
    /Function/,
  );

  // A non-computed read of a construction or reflection primitive hands back
  // a constructor or walks the prototype chain: `({}).constructor.constructor`
  // is the Function constructor, which is the escape this guard exists to
  // close. Judged only as member reads -- a free identifier spelled
  // `constructor` reaches nothing, and `arguments` is the ordinary local
  // every transpiled body uses, so neither is on the reference name list.
  assert.throws(() => rw(`Function("return ({}).constructor");`), /Function/);
  assert.throws(() => rw(`Function("x","return x.__proto__");`), /Function/);
  assert.throws(() => rw(`Function("f","return f.caller");`), /Function/);
  assert.throws(() => rw(`Function("f","return f.arguments");`), /Function/);
  assert.doesNotThrow(() => rw(`Function("return arguments.length");`));
  assert.doesNotThrow(() => rw(`Function("return {constructor: 1}");`));
});

test("guard: Function( is judged only when it resolves to the global", () => {
  // A bundle that declares its own `Function` is not calling the constructor,
  // and failing that build would be a name collision, not a hazard.
  assert.doesNotThrow(() => rw(`function Function(v){return v} Function(someVar);`));
  assert.doesNotThrow(() => rw(`{ const Function = (v)=>v; Function(someVar); }`));
  assert.doesNotThrow(() =>
    rw(`function Function(v){this.v=v} new Function(someVar);`),
  );

  // Unbound `Function` is the global and is still judged on both forms.
  assert.throws(() => rw(`Function(someVar);`), /Function/);
  assert.throws(() => rw(`new Function(someVar);`), /Function/);
});

test("guard ignores eval and Function text in comments and strings", () => {
  assert.doesNotThrow(() =>
    rw(`
      // Do not use eval() here.
      const evalWarning = "eval() is unsafe";
      const functionWarning = "new Function() is unsafe";
    `),
  );
});
