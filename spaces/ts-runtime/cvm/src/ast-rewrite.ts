// AST rewrite pass over a bundled JS string for the CVM (Confidential-VM)
// hermetic-bundle build. Returns rewritten code + per-category counters.
//
// Every URL-bearing browser API in the closed bundle is rewritten to route
// through the runtime `__tunnel` (see cvm/src/prelude.ts), so an
// opaque-origin sandboxed iframe can render the Space with every fetch /
// asset / DOM mutation tunneled over the parent's Noise websocket instead of
// terminating at the VM over plain HTTP.
//
// Key design decision: we rewrite ALL setAttribute / setAttributeNS calls
// regardless of whether the attribute name is a literal — because react-dom
// (and most frameworks) call setAttribute with a variable name. The runtime
// __tunnel.setAttr classifies the receiver before the name: non-DOM methods
// retain their arguments and return value; DOM calls tunnel URL attributes.
//
// The companion runtime is cvm/src/prelude.ts (the `__tunnel` implementation)
// these rewrites target.
//
// Cases rewritten (source → runtime; each match calls path.skip()). Covered by
// ast-rewrite.test.ts:
//   import.meta                      → __tunnel._importMeta            (MetaProperty)
//   fetch(...)                       → __tunnel.fetch(...)             (bare identifier only)
//   navigator.sendBeacon(...)        → __tunnel.sendBeacon(...)
//   x.setAttribute(name, val)        → __tunnel.setAttr(x, name, val)  (ANY name, var or literal)
//   x.setAttributeNS(ns, name, val)  → __tunnel.setAttrNS(x, ns, name, val)
//   x.style.setProperty(name, val)   → __tunnel.setStyle(x, name, val)
//   x.insertAdjacentHTML(pos, html)  → __tunnel.insertAdjacentHTML(x, pos, html)
//   new XMLHttpRequest(...)          → new __tunnel.XHR(...)
//   new WebSocket(...)               → new __tunnel.WebSocket(...)
//   new EventSource(...)             → new __tunnel.EventSource(...)
//   new Worker(...)                  → new __tunnel.Worker(...)
//   new Image(...)                   → __tunnel.Image(...)             (call, not `new`)
//   import(spec)                     → __tunnel.import(spec)           (dynamic import)
//   x.style[name] = val              → __tunnel.setStyle(x, name, val) (computed; react-dom hot path)
//   x.style.NAME = val               → __tunnel.setStyle(x, "NAME", val)
//   x.PROP = val                     → __tunnel.setUrlProp(x, "PROP", val) for PROP in
//                                       {src,srcset,href,poster,action,formAction,data,background,
//                                        cite,longdesc,usemap,manifest,xlinkHref}
//   x.innerHTML|outerHTML = val      → __tunnel.setInnerHTML(x, val, "innerHTML"|"outerHTML")
//   x.textContent|innerText = val    → __tunnel.setStyleText(x, val)   ONLY when x reads as a
//                                       <style>-like target (object name/prop matches /style/i),
//                                       to rewrite url() inside <style> text; other text is left as-is
//   read of x.style                  → __tunnel.getStyle(x)            (returns a Proxy that traps
//                                       later writes; NOT applied when x.style is itself a
//                                       write/update/call target or the head of an x.style.* chain,
//                                       nor on __tunnel.* internals)
//
// Deliberately NOT rewritten: member-expression fetch (e.g. window.fetch / a
// destructured/aliased fetch) — the prelude's global override covers those;
// non-URL attributes pass through at runtime (__tunnel.setAttr fast-paths them).
//
// Guards: a bundle carrying the prelude marker __HATCH_TUNNEL_SOURCE__ is
// returned untouched (never rewrite the tunnel itself); `eval(...)` always
// throws, because its source is knowable only at runtime. `Function(...)` and
// `new Function(...)` are judged identically — `new` has no bearing on what
// gets constructed — and throw UNLESS the code they would build is statically
// knowable AND inert (see isInertFunctionConstruction). That admits the
// `globalThis` shim bundlers emit (`Function("return this")()`) while still
// rejecting real dynamic codegen. Comments and string literals that merely
// mention any of them are safe.

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

const traverse: typeof _traverse =
  (_traverse as any).default ?? (_traverse as any);
const generate: typeof _generate =
  (_generate as any).default ?? (_generate as any);

export const EVAL_DYNAMIC_CODE_ERROR =
  "Source contains eval(); closed-bundle assumption broken.";
export const FUNCTION_DYNAMIC_CODE_ERROR =
  "Source contains Function(); closed-bundle assumption broken.";
export const NEW_FUNCTION_DYNAMIC_CODE_ERROR =
  "Source contains new Function(); closed-bundle assumption broken.";

export interface RewriteStats {
  fetch: number;
  xhr: number;
  ws: number;
  eventSource: number;
  image: number;
  worker: number;
  importExpr: number;
  importMeta: number;
  sendBeacon: number;
  setAttribute: number;
  setAttributeNS: number;
  propAssignUrl: number;
  styleAssign: number;
  styleSetProperty: number;
  styleTextAssign: number;
  innerHtmlAssign: number;
  insertAdjacentHtml: number;
}

const URL_PROP_NAMES = new Set([
  "src",
  "srcset",
  "href",
  "poster",
  "action",
  "formAction",
  "formaction",
  "data",
  "background",
  "cite",
  "longdesc",
  "usemap",
  "manifest",
  "xlinkHref",
]);

function tunnelCall(method: string, args: t.Expression[]): t.CallExpression {
  return t.callExpression(
    t.memberExpression(t.identifier("__tunnel"), t.identifier(method)),
    args,
  );
}

function tunnelMember(name: string): t.MemberExpression {
  return t.memberExpression(t.identifier("__tunnel"), t.identifier(name));
}

// Names that, if the constructed body can reach them, would let dynamically
// built code escape the tunnel. Network egress is largely re-closed at runtime
// by the prelude's global overrides (fetch / XHR / WebSocket / EventSource /
// sendBeacon / URL); URL-bearing DOM mutation is NOT — those are rewritten
// per-call-site only, so a constructed body that touches them is unreachable
// for us and must be rejected.
const DYNAMIC_BODY_FORBIDDEN_NAMES = new Set([
  // Network egress.
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "Image",
  "Request",
  "Response",
  "importScripts",
  "sendBeacon",
  "navigator",
  // Further dynamic construction.
  "eval",
  "Function",
  "import",
  // URL-bearing DOM mutation — the gap the prelude's global overrides leave.
  "document",
  "setAttribute",
  "setAttributeNS",
  "insertAdjacentHTML",
  "innerHTML",
  "outerHTML",
  "src",
  "srcset",
  "href",
  "style",
]);

// Reflection primitives that hand back a constructor or walk the prototype
// chain. These are judged ONLY as non-computed member reads, never as bare
// references, and the split is deliberate: `({}).constructor.constructor` is
// the Function constructor and is exactly the escape this guard exists to
// close, while a free identifier spelled `constructor` reaches nothing, and
// `arguments` is the ordinary local every transpiled function body uses.
// Putting these in DYNAMIC_BODY_FORBIDDEN_NAMES would therefore re-create the
// false-positive build failures this change exists to remove.
const DYNAMIC_BODY_FORBIDDEN_MEMBERS = new Set([
  "constructor",
  "__proto__",
  "caller",
  "arguments",
]);

/// Decide whether a `Function(...)` / `new Function(...)` call is safe to leave
/// in a closed bundle.
///
/// Admitted only when BOTH hold: every argument is a string literal (so the
/// constructed source is knowable at build time), and the body it would build
/// invokes nothing and names nothing in DYNAMIC_BODY_FORBIDDEN_NAMES. The
/// canonical `Function("return this")` globalThis shim that UMD wrappers,
/// core-js and regenerator emit passes; `Function("return fetch(u)")` does not.
///
/// Fails closed on every uncertainty: a computed argument, an unparseable body,
/// a computed member access (which hides the property name being read), or a
/// `with` block (which hides what a bare identifier resolves to) all return
/// false.
function isInertFunctionConstruction(args: readonly t.Node[]): boolean {
  const literals: string[] = [];
  for (const arg of args) {
    if (!t.isStringLiteral(arg)) return false;
    literals.push(arg.value);
  }
  // `Function()` builds an empty function body.
  if (literals.length === 0) return true;

  const body = literals[literals.length - 1];
  const params = literals.slice(0, -1).join(",");
  let parsed;
  try {
    parsed = parse(`(function anonymous(${params}){\n${body}\n})`, {
      sourceType: "script",
    });
  } catch {
    return false;
  }

  let inert = true;
  const reject = () => {
    inert = false;
  };
  // A write target nests arbitrarily deep through destructuring, so this has
  // to recurse rather than look at the top node: `[el.poster] = [u]` and
  // `({p: el.poster} = o)` reach a member the top-level check never sees.
  const writesThroughMember = (node: t.Node | null | undefined): boolean => {
    if (!node) return false;
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      return true;
    }
    if (t.isArrayPattern(node)) {
      // Holes (`[, el.poster] = xs`) are null elements.
      return node.elements.some(writesThroughMember);
    }
    if (t.isObjectPattern(node)) {
      return node.properties.some((property) =>
        t.isRestElement(property)
          ? writesThroughMember(property.argument)
          : writesThroughMember(property.value),
      );
    }
    if (t.isRestElement(node)) return writesThroughMember(node.argument);
    // `[el.poster = 1] = []` — the default's target is on the left.
    if (t.isAssignmentPattern(node)) return writesThroughMember(node.left);
    return false;
  };

  // `a.style` and `a?.style` are distinct node types but the same hazard, so
  // both arms below share one judgement.
  const inspectMember = (path: {
    node: t.MemberExpression | t.OptionalMemberExpression;
  }) => {
    if (path.node.computed) return reject();
    if (
      t.isIdentifier(path.node.property) &&
      (DYNAMIC_BODY_FORBIDDEN_NAMES.has(path.node.property.name) ||
        DYNAMIC_BODY_FORBIDDEN_MEMBERS.has(path.node.property.name))
    ) {
      reject();
    }
  };

  traverse(parsed, {
    CallExpression: reject,
    OptionalCallExpression: reject,
    NewExpression: reject,
    TaggedTemplateExpression: reject,
    Import: reject,
    // `with (o) { href = u }` resolves bare identifiers against `o` at
    // runtime, so a URL-bearing write becomes a plain assignment to an
    // Identifier: it writes through no member for the shape check to catch,
    // and the assignment target is not a referenced identifier for the name
    // check to catch. The scope object is arbitrary, so nothing static can
    // say what the body reaches. Fail closed on the whole construct.
    WithStatement: reject,
    // No write through a member, whatever it is named. The rewriter can only
    // route a URL-bearing write such as `el.poster = u` through
    // `__tunnel.setAttr` when it can see the assignment in the bundle, and a
    // body built from a string literal is invisible to it — so the URL would
    // be assigned raw and never resolve inside the opaque-origin iframe.
    // Deliberately NOT a name check: the set of URL-bearing names is not
    // fixed. `URL_PROP_NAMES` already drifted out of sync with
    // DYNAMIC_BODY_FORBIDDEN_NAMES below (which carried only 4 of its 14),
    // and URL-bearing CSS properties (`backgroundImage`, `maskImage`,
    // `cursor`, ...) are open-ended. An inert body has no reason to write
    // through a member at all, so none is admitted and the two lists can
    // never drift apart again.
    AssignmentExpression(path) {
      if (writesThroughMember(path.node.left)) reject();
    },
    // `for (el.poster of urls)` and `for (el.poster in obj)` write through a
    // member without ever being an AssignmentExpression. A `VariableDeclaration`
    // head declares a fresh binding and cannot reach an existing object.
    ForOfStatement(path) {
      if (writesThroughMember(path.node.left)) reject();
    },
    ForInStatement(path) {
      if (writesThroughMember(path.node.left)) reject();
    },
    // `el.poster++` / `--el.poster` are writes too.
    UpdateExpression(path) {
      if (writesThroughMember(path.node.argument)) reject();
    },
    MemberExpression: inspectMember,
    OptionalMemberExpression: inspectMember,
    Identifier(path) {
      // Only a *reference* to a forbidden name can reach the global it names.
      // Babel also visits non-computed property keys (`{style: 1}`),
      // non-computed member property names (`x.href`) and binding positions
      // (`var href = 0`, a parameter) as plain Identifiers; rejecting those
      // would re-create the false-positive build failures this guard exists
      // to remove. A shorthand property (`{fetch}`) IS a reference and
      // `isReferencedIdentifier` reports it as one, so it stays rejected.
      // `x.href` is still judged — by the MemberExpression arm above, which
      // reads the property name directly.
      if (!path.isReferencedIdentifier()) return;
      if (DYNAMIC_BODY_FORBIDDEN_NAMES.has(path.node.name)) reject();
    },
  });
  return inert;
}

/// Is this `Function` identifier the global constructor, rather than something
/// the bundle declared itself?
///
/// Babel's `getBinding` walks the scope chain and returns nothing for a free
/// identifier, so an unbound `Function` is the global. A bundle that declares
/// its own `function Function(...)`, or imports one, is calling its own thing,
/// and rejecting that fails a build over a name collision.
///
/// This is not an escape hatch that weakens the guard: an alias under a
/// different name (`const F = Function; F(src)`) already bypasses the arms
/// entirely, because they match on the identifier's spelling. Requiring the
/// spelling to actually resolve to the global therefore removes false
/// positives without widening what a determined bundle can reach; the
/// prelude's runtime overrides remain the containment that does not depend on
/// static naming.
function isGlobalFunctionRef(path: { scope: { getBinding(name: string): unknown } }): boolean {
  return path.scope.getBinding("Function") === undefined;
}

export function rewriteAst(code: string): {
  code: string;
  stats: RewriteStats;
  skipped: boolean;
} {
  const stats: RewriteStats = {
    fetch: 0,
    xhr: 0,
    ws: 0,
    eventSource: 0,
    image: 0,
    worker: 0,
    importExpr: 0,
    importMeta: 0,
    sendBeacon: 0,
    setAttribute: 0,
    setAttributeNS: 0,
    propAssignUrl: 0,
    styleAssign: 0,
    styleSetProperty: 0,
    styleTextAssign: 0,
    innerHtmlAssign: 0,
    insertAdjacentHtml: 0,
  };

  // Never rewrite the tunnel prelude itself (it is concatenated into the same
  // bundle and references the native fetch / setAttribute it shims).
  if (code.includes("__HATCH_TUNNEL_SOURCE__")) {
    return { code, stats, skipped: true };
  }

  const ast = parse(code, {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "typescript",
      "jsx",
      "classProperties",
      "optionalChaining",
      "nullishCoalescingOperator",
      "topLevelAwait",
      "dynamicImport",
      "objectRestSpread",
    ],
  });

  traverse(ast, {
    // Emit HTML comment openers safely when this code is placed in a script tag.
    StringLiteral(path) {
      if (path.node.value.includes("<!--")) path.node.extra = undefined;
    },
    DirectiveLiteral(path) {
      if (!path.node.value.includes("<!--")) return;
      path.node.extra = {
        raw: JSON.stringify(path.node.value).replace(/<!--/g, "\\x3C!--"),
        rawValue: path.node.value,
      };
    },
    // `import.meta` is a syntax error in the classic inlined bundle script, and
    // its `.url` (used by bundlers to resolve imported asset URLs, e.g.
    // `new URL("./photo.webp", import.meta.url).href`) must resolve under the
    // served `assets/` dir so the tunnel fetches the right path. Rewrite the
    // whole `import.meta` meta-property to the prelude-provided shim
    // `__tunnel._importMeta`, whose `.url` is a self-origin URL inside assets/.
    MetaProperty(path) {
      const node = path.node;
      if (
        t.isIdentifier(node.meta, { name: "import" }) &&
        t.isIdentifier(node.property, { name: "meta" })
      ) {
        path.replaceWith(
          t.memberExpression(t.identifier("__tunnel"), t.identifier("_importMeta")),
        );
        stats.importMeta++;
        path.skip();
      }
    },
    CallExpression(path) {
      const node = path.node;
      const callee = node.callee;

      if (
        t.isIdentifier(callee, { name: "eval" }) ||
        (t.isMemberExpression(callee) &&
          !callee.computed &&
          t.isIdentifier(callee.property, { name: "eval" }))
      ) {
        throw new Error(EVAL_DYNAMIC_CODE_ERROR);
      }
      if (
        t.isIdentifier(callee, { name: "Function" }) &&
        isGlobalFunctionRef(path) &&
        !isInertFunctionConstruction(node.arguments)
      ) {
        throw new Error(FUNCTION_DYNAMIC_CODE_ERROR);
      }

      // Bare fetch(...)
      if (t.isIdentifier(callee, { name: "fetch" })) {
        path.replaceWith(tunnelCall("fetch", node.arguments as any));
        stats.fetch++;
        path.skip();
        return;
      }

      // navigator.sendBeacon(...)
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.object, { name: "navigator" }) &&
        t.isIdentifier(callee.property, { name: "sendBeacon" })
      ) {
        path.replaceWith(tunnelCall("sendBeacon", node.arguments as any));
        stats.sendBeacon++;
        path.skip();
        return;
      }

      // el.setAttribute(name, value) — rewrite UNCONDITIONALLY (react-dom
      // calls this with a variable attr name).
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name: "setAttribute" }) &&
        node.arguments.length >= 2 &&
        !t.isSpreadElement(node.arguments[0]) &&
        !t.isSpreadElement(node.arguments[1])
      ) {
        path.replaceWith(
          tunnelCall("setAttr", [
            callee.object as t.Expression,
            ...node.arguments as t.Expression[],
          ]),
        );
        stats.setAttribute++;
        path.skip();
        return;
      }

      // el.setAttributeNS(ns, name, value)
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name: "setAttributeNS" }) &&
        node.arguments.length >= 3 &&
        !t.isSpreadElement(node.arguments[0]) &&
        !t.isSpreadElement(node.arguments[1]) &&
        !t.isSpreadElement(node.arguments[2])
      ) {
        path.replaceWith(
          tunnelCall("setAttrNS", [
            callee.object as t.Expression,
            ...node.arguments as t.Expression[],
          ]),
        );
        stats.setAttributeNS++;
        path.skip();
        return;
      }

      // el.style.setProperty(name, value)
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name: "setProperty" }) &&
        t.isMemberExpression(callee.object) &&
        !callee.object.computed &&
        t.isIdentifier(callee.object.property, { name: "style" })
      ) {
        path.replaceWith(
          tunnelCall("setStyle", [
            callee.object.object as t.Expression,
            node.arguments[0] as t.Expression,
            (node.arguments[1] ?? t.stringLiteral("")) as t.Expression,
          ]),
        );
        stats.styleSetProperty++;
        path.skip();
        return;
      }

      // el.insertAdjacentHTML(position, html)
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name: "insertAdjacentHTML" }) &&
        node.arguments.length >= 2
      ) {
        path.replaceWith(
          tunnelCall("insertAdjacentHTML", [
            callee.object as t.Expression,
            node.arguments[0] as t.Expression,
            node.arguments[1] as t.Expression,
          ]),
        );
        stats.insertAdjacentHtml++;
        path.skip();
        return;
      }
    },

    NewExpression(path) {
      const node = path.node;
      const callee = node.callee;
      if (
        t.isIdentifier(callee, { name: "Function" }) &&
        isGlobalFunctionRef(path) &&
        !isInertFunctionConstruction(node.arguments)
      ) {
        throw new Error(NEW_FUNCTION_DYNAMIC_CODE_ERROR);
      }
      if (t.isIdentifier(callee, { name: "XMLHttpRequest" })) {
        path.replaceWith(t.newExpression(tunnelMember("XHR"), node.arguments));
        stats.xhr++;
        path.skip();
        return;
      }
      if (t.isIdentifier(callee, { name: "WebSocket" })) {
        path.replaceWith(
          t.newExpression(tunnelMember("WebSocket"), node.arguments),
        );
        stats.ws++;
        path.skip();
        return;
      }
      if (t.isIdentifier(callee, { name: "EventSource" })) {
        path.replaceWith(
          t.newExpression(tunnelMember("EventSource"), node.arguments),
        );
        stats.eventSource++;
        path.skip();
        return;
      }
      if (t.isIdentifier(callee, { name: "Image" })) {
        path.replaceWith(tunnelCall("Image", node.arguments as any));
        stats.image++;
        path.skip();
        return;
      }
      if (t.isIdentifier(callee, { name: "Worker" })) {
        path.replaceWith(
          t.newExpression(tunnelMember("Worker"), node.arguments),
        );
        stats.worker++;
        path.skip();
        return;
      }
    },

    AssignmentExpression(path) {
      const node = path.node;
      if (node.operator !== "=") return;
      const left = node.left;
      if (!t.isMemberExpression(left)) return;

      // el.style[name] = value (computed) — react-dom's setValueForStyles
      // hot path. Wrap as setStyle(el, name, value).
      if (
        left.computed &&
        t.isMemberExpression(left.object) &&
        !left.object.computed &&
        t.isIdentifier(left.object.property, { name: "style" })
      ) {
        path.replaceWith(
          tunnelCall("setStyle", [
            left.object.object as t.Expression,
            left.property as t.Expression,
            node.right as t.Expression,
          ]),
        );
        stats.styleAssign++;
        path.skip();
        return;
      }

      if (left.computed) return;
      if (!t.isIdentifier(left.property)) return;
      const propName = left.property.name;

      // el.style.X = y (non-computed)
      if (
        t.isMemberExpression(left.object) &&
        !left.object.computed &&
        t.isIdentifier(left.object.property, { name: "style" })
      ) {
        path.replaceWith(
          tunnelCall("setStyle", [
            left.object.object as t.Expression,
            t.stringLiteral(propName),
            node.right as t.Expression,
          ]),
        );
        stats.styleAssign++;
        path.skip();
        return;
      }

      // el.src = x / el.href = x / ...
      if (URL_PROP_NAMES.has(propName)) {
        path.replaceWith(
          tunnelCall("setUrlProp", [
            left.object as t.Expression,
            t.stringLiteral(propName),
            node.right as t.Expression,
          ]),
        );
        stats.propAssignUrl++;
        path.skip();
        return;
      }

      // el.innerHTML = x / el.outerHTML = x
      if (propName === "innerHTML" || propName === "outerHTML") {
        path.replaceWith(
          tunnelCall("setInnerHTML", [
            left.object as t.Expression,
            node.right as t.Expression,
            t.stringLiteral(propName),
          ]),
        );
        stats.innerHtmlAssign++;
        path.skip();
        return;
      }

      // el.textContent / el.innerText — when target hint says style
      if (propName === "textContent" || propName === "innerText") {
        let nameHint = false;
        if (t.isIdentifier(left.object) && /style/i.test(left.object.name))
          nameHint = true;
        if (
          t.isMemberExpression(left.object) &&
          !left.object.computed &&
          t.isIdentifier(left.object.property) &&
          /style/i.test(left.object.property.name)
        ) {
          nameHint = true;
        }
        if (nameHint) {
          path.replaceWith(
            tunnelCall("setStyleText", [
              left.object as t.Expression,
              node.right as t.Expression,
            ]),
          );
          stats.styleTextAssign++;
          path.skip();
          return;
        }
      }
    },

    Import(path) {
      const parent = path.parent;
      if (t.isCallExpression(parent) && parent.callee === path.node) {
        const call = parent;
        const replacement = tunnelCall("import", call.arguments as any);
        path.parentPath.replaceWith(replacement);
        stats.importExpr++;
      }
    },

    // Read-position `.style` access. `var s = el.style;` →
    // `var s = __tunnel.getStyle(el);`. The runtime returns a Proxy that traps
    // sets and routes through setStyle (react-dom aliases node.style locally).
    MemberExpression(path) {
      const node = path.node;
      if (node.computed) return;
      if (!t.isIdentifier(node.property, { name: "style" })) return;
      const parent = path.parent;
      // Skip if parent is a MemberExpression with this as the object — direct
      // chain like `el.style.X` is captured by the assignment rules.
      if (t.isMemberExpression(parent) && parent.object === node) return;
      if (t.isOptionalMemberExpression(parent) && parent.object === node) return;
      if (t.isAssignmentExpression(parent) && parent.left === node) return;
      if (t.isUpdateExpression(parent) && parent.argument === node) return;
      if (t.isCallExpression(parent) && parent.callee === node) return;
      // Skip if the object is __tunnel itself (don't recurse into our prelude).
      if (
        t.isIdentifier(node.object, { name: "__tunnel" }) ||
        (t.isMemberExpression(node.object) &&
          t.isIdentifier(node.object.object, { name: "__tunnel" }))
      )
        return;
      path.replaceWith(tunnelCall("getStyle", [node.object as t.Expression]));
      path.skip();
    },
  });

  const out = generate(ast, {
    compact: false,
    comments: false,
    jsescOption: { isScriptContext: true },
  });

  return { code: out.code, stats, skipped: false };
}
