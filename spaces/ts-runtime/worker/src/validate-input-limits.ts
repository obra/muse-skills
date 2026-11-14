// Client build check: every form input that feeds a limited request field
// takes its limits from the request schema (`{...FIELDS.<action>.<field>}`
// from `@hatch/space-sdk/fields`) instead of hand-writing them. An input feeds a
// field when its value is sent as that field to that action; inputs whose value is
// never sent are not checked. It reads the client source with the Space's own
// TypeScript parser. Runs from `validate-client-cli.ts` for Spaces whose
// `platformVersion` has adopted schema-derived input limits.

import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TS from "typescript";
import { describeRequest, type FieldProps } from "../../sdk/src/client/field-props";

/** First `platformVersion` whose Spaces must read input limits from the request schema. */
export const SCHEMA_INPUT_LIMITS_VERSION = 29;

const MAX_REPORTED = 5;
const LIMIT_ATTRIBUTES = ["maxLength", "minLength", "min", "max"] as const;
const NON_TEXT_TYPES = new Set(["range", "date", "time", "datetime-local", "month", "week", "color", "checkbox", "radio", "file", "hidden"]);

type Described = FieldProps | { [field: string]: Described };
type LimitedField = { path: string; limits: string; numeric: boolean };

/** Request fields with a length or range limit, by leaf field name. */
export function limitedRequestFields(actions: Record<string, { request?: unknown }>): Map<string, LimitedField[]> {
  const byName = new Map<string, LimitedField[]>();
  const visit = (node: Described, path: string[]) => {
    if (typeof (node as FieldProps).name === "string") {
      const props = node as FieldProps;
      const limits = LIMIT_ATTRIBUTES.filter((attribute) => props[attribute] !== undefined)
        .map((attribute) => `${attribute} ${props[attribute]}`)
        .join(", ");
      if (limits.length > 0) {
        const leaf = path[path.length - 1]!;
        const list = byName.get(leaf) ?? [];
        list.push({ path: path.join("."), limits, numeric: props.min !== undefined || props.max !== undefined });
        byName.set(leaf, list);
      }
      return;
    }
    for (const [field, child] of Object.entries(node)) {
      visit(child as Described, [...path, field]);
    }
  };
  for (const [action, definition] of Object.entries(actions)) {
    visit(describeRequest(definition.request), [action]);
  }
  return byName;
}

/** The Space's `Actions`, or `null` when `server/src/actions.ts` can't load (the typecheck reports why). */
export function loadActions(spaceDir: string): Record<string, { request?: unknown }> | null {
  try {
    const loaded = createRequire(join(spaceDir, "package.json"))(join(spaceDir, "server", "src", "actions.ts")) as {
      Actions?: Record<string, { request?: unknown }>;
    };
    return loaded.Actions ?? null;
  } catch {
    return null;
  }
}

/** The Space's own `typescript` (every TypeScript Space installs it for its typecheck), or `null` when it can't load. */
export function loadTypeScript(spaceDir: string): typeof TS | null {
  try {
    return createRequire(join(spaceDir, "package.json"))("typescript") as typeof TS;
  } catch {
    return null;
  }
}

// A value is a key: a symbol's id (`7`), one property of it (`7.title`), the event value
// an input hands its own handlers (`input:3`), or a `FormData` entry (`form:title`).
type Arg = TS.Expression | { input: string } | undefined;
type Send = { origins: Set<string>; path: string };
type Input = { node: TS.JsxOpeningLikeElement; file: TS.SourceFile; token: string };

const PLAIN = /^\d+$/;
const UNIT_PRESERVING_FUNCTIONS = new Set(["Number", "String", "parseInt", "parseFloat"]);
const UNIT_PRESERVING_METHODS = new Set(["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "toString"]);

/**
 * Follows values through one Space's client files with TypeScript's own name binding, so two
 * handlers that each declare a `t` stay apart. A value reaches a request field when it is sent
 * to that action, through `api.<action>(…)`, a `useMutation` whose `mutationFn` calls one, or a
 * parent's `on…` prop (any action's field of that name), via object literals and spreads, local
 * copies, function and `mutationFn` parameters, `useState` setters, the event an input passes to
 * its handlers, and `FormData` reads. Arithmetic, `Math.*` and other calls can change a value's
 * units, so a converted value matches nothing; `Number()`, `String()` and `.trim()` keep them.
 */
function valueFlow(ts: typeof TS, files: TS.SourceFile[], fieldsByAction: Map<string, Set<string>>) {
  const host: TS.CompilerHost = {
    getSourceFile: (name) => files.find((file) => file.fileName === name),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    fileExists: (name) => files.some((file) => file.fileName === name),
    readFile: () => undefined,
  };
  const options = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve, types: [] };
  const checker = ts.createProgram(files.map((file) => file.fileName), options, host).getTypeChecker();
  const symbols: TS.Symbol[] = [];
  const ids = new Map<TS.Symbol, number>();
  const symbolOf = (name: TS.Node): TS.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(name.parent) && name.parent.name === name
      ? checker.getShorthandAssignmentValueSymbol(name.parent)
      : checker.getSymbolAtLocation(name);
  const key = (symbol: TS.Symbol, prop?: string): string => {
    let id = ids.get(symbol);
    if (id === undefined) ids.set(symbol, (id = symbols.push(symbol) - 1));
    return prop === undefined ? `${id}` : `${id}.${prop}`;
  };
  const allLeaves = new Set([...fieldsByAction.values()].flatMap((leaves) => [...leaves]));
  const leaves = (action: string) => (action === "*" ? allLeaves : fieldsByAction.get(action) ?? new Set<string>());
  const skip = (node: TS.Expression): TS.Expression =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
      ? skip(node.expression)
      : node;
  const calleeName = (node: TS.Expression) =>
    ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
  const functionInit = (node: TS.Expression): TS.SignatureDeclaration | undefined => {
    const init = skip(node);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    if (ts.isCallExpression(init) && calleeName(init.expression) === "useCallback" && init.arguments[0] !== undefined) return functionInit(init.arguments[0]);
    return undefined;
  };
  const isParameter = (symbol: TS.Symbol | undefined): boolean => {
    let node: TS.Node | undefined = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    while (node !== undefined && (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))) node = node.parent;
    return node !== undefined && ts.isParameter(node);
  };

  const functions = new Map<TS.Symbol, TS.SignatureDeclaration>();
  const mutationFns = new Map<TS.Symbol, TS.SignatureDeclaration>();
  const setterOf = new Map<TS.Symbol, TS.Symbol>();
  const setterCalls = new Map<TS.Symbol, TS.Expression[]>();
  const formData = new Set<TS.Symbol>();
  const callSites = new Map<TS.Node, Arg[][]>();
  const inputs: Input[] = [];
  const inputByNode = new Map<TS.Node, Input>();
  const walk = (node: TS.Node, visit: (node: TS.Node) => void) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };

  for (const file of files) {
    walk(file, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const symbol = symbolOf(node.name);
        if (symbol !== undefined) functions.set(symbol, node);
      } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const init = skip(node.initializer);
        if (ts.isIdentifier(node.name)) {
          const symbol = symbolOf(node.name);
          if (symbol === undefined) return;
          const fn = functionInit(init);
          if (fn !== undefined) functions.set(symbol, fn);
          if (ts.isCallExpression(init) && calleeName(init.expression) === "useMutation" && init.arguments[0] !== undefined && ts.isObjectLiteralExpression(init.arguments[0])) {
            const option = init.arguments[0].properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "mutationFn");
            const mutationFn = option !== undefined && ts.isPropertyAssignment(option) ? functionInit(option.initializer) : undefined;
            if (mutationFn !== undefined) mutationFns.set(symbol, mutationFn);
          }
          if (ts.isNewExpression(init) && calleeName(init.expression) === "FormData") formData.add(symbol);
        } else if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(init) && calleeName(init.expression) === "useState") {
          const [state, setter] = node.name.elements;
          const stateSymbol = state !== undefined && ts.isBindingElement(state) ? symbolOf(state.name) : undefined;
          const setterSymbol = setter !== undefined && ts.isBindingElement(setter) ? symbolOf(setter.name) : undefined;
          if (stateSymbol !== undefined && setterSymbol !== undefined) setterOf.set(setterSymbol, stateSymbol);
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (/^(?:input|textarea)$/.test(node.tagName.getText())) {
          const input = { node, file, token: `input:${inputs.length}` };
          inputs.push(input);
          inputByNode.set(node, input);
        }
      }
    });
  }

  // Keys a value is read from, or `null` when the expression may change its units or shape.
  const trace = (node: TS.Expression): string[] | null => {
    const expr = skip(node);
    if (ts.isIdentifier(expr)) {
      const symbol = symbolOf(expr);
      return symbol === undefined ? [] : [key(symbol)];
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const name = expr.name.text;
      const inner = skip(expr.expression);
      if (name === "value" && ts.isPropertyAccessExpression(inner) && /^(?:target|currentTarget)$/.test(inner.name.text) && ts.isIdentifier(skip(inner.expression))) {
        const symbol = symbolOf(skip(inner.expression));
        return symbol === undefined ? [] : [key(symbol, "#value")];
      }
      if (name === "length") return null;
      let root: TS.Expression = expr;
      while (ts.isPropertyAccessExpression(root) && !ts.isIdentifier(skip(root.expression))) root = skip(root.expression);
      if (!ts.isPropertyAccessExpression(root)) return null;
      const symbol = symbolOf(skip(root.expression));
      return symbol === undefined ? [] : [key(symbol, root.name.text)];
    }
    if (ts.isElementAccessExpression(expr)) return trace(expr.expression);
    if (ts.isCallExpression(expr)) {
      const callee = skip(expr.expression);
      if (ts.isIdentifier(callee) && UNIT_PRESERVING_FUNCTIONS.has(callee.text)) return expr.arguments[0] === undefined ? [] : trace(expr.arguments[0]);
      if (ts.isPropertyAccessExpression(callee) && UNIT_PRESERVING_METHODS.has(callee.name.text)) return trace(callee.expression);
      const arg = expr.arguments[0];
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "get" && ts.isIdentifier(skip(callee.expression)) && arg !== undefined && ts.isStringLiteralLike(arg)) {
        const symbol = symbolOf(skip(callee.expression));
        if (symbol !== undefined && formData.has(symbol)) return [`form:${arg.text}`];
      }
      return null;
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op !== ts.SyntaxKind.QuestionQuestionToken && op !== ts.SyntaxKind.BarBarToken && op !== ts.SyntaxKind.AmpersandAmpersandToken) return null;
      const [left, right] = [trace(expr.left), trace(expr.right)];
      // `title.trim() || "Untitled"`: whatever the fallback is, the left side is still sent as typed.
      if (op !== ts.SyntaxKind.AmpersandAmpersandToken && left !== null) return [...left, ...(right ?? [])];
      return left === null || right === null ? null : [...left, ...right];
    }
    if (ts.isConditionalExpression(expr)) {
      const [yes, no] = [trace(expr.whenTrue), trace(expr.whenFalse)];
      return yes === null || no === null ? null : [...yes, ...no];
    }
    if (ts.isPrefixUnaryExpression(expr)) return expr.operator === ts.SyntaxKind.PlusToken ? trace(expr.operand) : null;
    if (ts.isLiteralExpression(expr) || expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) return [];
    return null;
  };
  const withProp = (keys: string[], prop: string) => keys.filter((k) => PLAIN.test(k)).map((k) => `${k}.${prop}`);
  // What property `prop` of an expression holds: an object literal's entry or spread, or `<value>.<prop>`.
  const propOf = (node: TS.Expression, prop: string): string[] => {
    const expr = skip(node);
    if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) return propOf(expr.body, prop);
    if (!ts.isObjectLiteralExpression(expr)) return withProp(trace(expr) ?? [], prop);
    const named = expr.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === prop);
    if (named !== undefined && ts.isPropertyAssignment(named)) return trace(named.initializer) ?? [];
    if (named !== undefined && ts.isShorthandPropertyAssignment(named)) {
      const symbol = symbolOf(named.name);
      return symbol === undefined ? [] : [key(symbol)];
    }
    return expr.properties.flatMap((p) => (ts.isSpreadAssignment(p) ? withProp(trace(p.expression) ?? [], prop) : []));
  };
  const valueOf = (node: TS.Expression, prop: string | undefined): string[] => {
    const expr = skip(node);
    if (prop !== undefined) return propOf(expr, prop);
    return ts.isArrowFunction(expr) && !ts.isBlock(expr.body) ? trace(expr.body) ?? [] : trace(expr) ?? [];
  };

  const pendingSends: Array<[string[], string]> = [];
  const send = (action: string, payload: TS.Expression | undefined) => {
    if (payload !== undefined) for (const [field, keys] of entries(payload, leaves(action))) for (const k of keys) pendingSends.push([[k], `${action}.${field}`]);
  };
  // Each request field a payload fills, with the keys its value is read from.
  const entries = (node: TS.Expression, names: Set<string>): Array<[string, string[]]> => {
    const expr = skip(node);
    const built = ts.isIdentifier(expr) ? symbolOf(expr)?.valueDeclaration : undefined;
    if (built !== undefined && ts.isVariableDeclaration(built) && built.initializer !== undefined && ts.isObjectLiteralExpression(skip(built.initializer))) {
      return entries(built.initializer, names);
    }
    if (!ts.isObjectLiteralExpression(expr)) {
      const keys = trace(expr) ?? [];
      return [...names].map((name) => [name, withProp(keys, name)]);
    }
    const out: Array<[string, string[]]> = [];
    const explicit = new Set(expr.properties.filter((p) => !ts.isSpreadAssignment(p)).map((p) => p.name?.getText()));
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p)) {
        const value = skip(p.initializer);
        const mapped = listItem(value);
        if (ts.isObjectLiteralExpression(value)) out.push(...entries(value, names));
        else if (ts.isArrayLiteralExpression(value)) for (const el of value.elements) out.push(...(ts.isObjectLiteralExpression(el) ? entries(el, names) : []));
        else if (mapped !== undefined) out.push(...entries(mapped, names));
        else {
          const keys = trace(value);
          if (keys !== null) out.push([p.name.getText(), keys]);
        }
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const symbol = symbolOf(p.name);
        out.push([p.name.text, symbol === undefined ? [] : [key(symbol)]]);
      } else if (ts.isSpreadAssignment(p)) {
        const keys = trace(p.expression) ?? [];
        for (const name of names) if (!explicit.has(name)) out.push([name, withProp(keys, name)]);
      }
    }
    return out;
  };
  // The object each item of `rows.map((row) => ({ … }))` becomes.
  const listItem = (value: TS.Expression): TS.ObjectLiteralExpression | undefined => {
    if (!ts.isCallExpression(value) || calleeName(value.expression) !== "map" || value.arguments[0] === undefined) return undefined;
    const fn = functionInit(value.arguments[0]);
    const body = fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.body : undefined;
    const returned = body === undefined ? undefined : ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body;
    return returned !== undefined && ts.isObjectLiteralExpression(skip(returned)) ? (skip(returned) as TS.ObjectLiteralExpression) : undefined;
  };
  const addCall = (fn: TS.Node | undefined, args: Arg[]) => {
    if (fn === undefined) return;
    const list = callSites.get(fn) ?? [];
    list.push(args);
    callSites.set(fn, list);
  };

  for (const file of files) {
    walk(file, (node) => {
      if (ts.isCallExpression(node)) {
        const callee = skip(node.expression);
        const arg = node.arguments[0];
        if (ts.isIdentifier(callee)) {
          const symbol = symbolOf(callee);
          if (symbol === undefined) return;
          if (functions.has(symbol)) addCall(functions.get(symbol), [...node.arguments]);
          else if (setterOf.has(symbol)) {
            const state = setterOf.get(symbol)!;
            if (arg !== undefined) setterCalls.set(state, [...(setterCalls.get(state) ?? []), arg]);
          } else if (/^on[A-Z]/.test(callee.text) && isParameter(symbol)) send("*", arg);
        } else if (ts.isPropertyAccessExpression(callee)) {
          const name = callee.name.text;
          const base = skip(callee.expression);
          const baseSymbol = ts.isIdentifier(base) ? symbolOf(base) : undefined;
          if (/^mutate(?:Async)?$/.test(name) && baseSymbol !== undefined && mutationFns.has(baseSymbol)) addCall(mutationFns.get(baseSymbol), [...node.arguments]);
          else if (fieldsByAction.has(name)) send(name, arg);
          else if (/^on[A-Z]/.test(name) && isParameter(baseSymbol)) send("*", arg);
        }
      } else if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText())) {
        const input = inputByNode.get(node.parent.parent);
        const expr = node.initializer !== undefined && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        if (input === undefined || expr === undefined) return;
        const handler = skip(expr);
        if (ts.isIdentifier(handler)) {
          const symbol = symbolOf(handler);
          addCall(symbol === undefined ? undefined : functions.get(symbol), [{ input: input.token }]);
        } else if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) addCall(handler, [{ input: input.token }]);
      }
    });
  }

  // Every key a value may have come from, itself included.
  const memo = new Map<string, Set<string>>();
  const origins = (k: string): Set<string> => {
    const known = memo.get(k);
    if (known !== undefined) return known;
    const found = new Set([k]);
    memo.set(k, found);
    const [id, prop] = k.includes(".") ? [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)] : [k, undefined];
    const symbol = PLAIN.test(id) ? symbols[Number(id)] : undefined;
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (symbol === undefined || decl === undefined) return found;
    const expand = (keys: string[]) => keys.forEach((from) => origins(from).forEach((o) => found.add(o)));
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer !== undefined && !functions.has(symbol)) {
      expand(valueOf(decl.initializer, prop));
    } else if (ts.isBindingElement(decl) && ts.isArrayBindingPattern(decl.parent)) {
      for (const value of setterCalls.get(symbol) ?? []) expand(valueOf(value, prop));
    } else if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      const index = decl.parent.parameters.indexOf(decl);
      for (const args of callSites.get(decl.parent) ?? []) {
        const arg = args[index];
        if (arg === undefined) continue;
        if ("input" in arg) {
          if (prop === "#value") found.add(arg.input);
        } else expand(valueOf(arg, prop));
      }
    } else if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && prop === undefined) {
      const name = (decl.propertyName ?? decl.name).getText();
      const owner = decl.parent.parent;
      if (ts.isVariableDeclaration(owner) && owner.initializer !== undefined) expand(propOf(owner.initializer, name));
      else if (ts.isParameter(owner)) {
        const index = owner.parent.parameters.indexOf(owner);
        for (const args of callSites.get(owner.parent) ?? []) {
          const arg = args[index];
          if (arg !== undefined && !("input" in arg)) expand(propOf(arg, name));
        }
      }
    }
    return found;
  };
  const sends: Send[] = pendingSends.map(([keys, path]) => ({ origins: origins(keys[0]!), path }));

  /** The `<action>.<field>` paths (`*.<field>` for a parent's handler) an input's value is sent as. */
  const fedPaths = (input: Input, value: TS.Expression | undefined, name: string | undefined): Set<string> => {
    const bound = new Set([input.token, ...(value === undefined ? [] : trace(value) ?? [])]);
    if (name !== undefined) bound.add(`form:${name}`);
    return new Set(sends.filter((s) => [...bound].some((b) => s.origins.has(b))).map((s) => s.path));
  };
  return { inputs, fedPaths };
}

/** Violations across one Space's client files, with 1-based line numbers. */
export function checkInputLimits(
  ts: typeof TS,
  sources: Array<{ rel: string; content: string }>,
  limited: Map<string, LimitedField[]>,
): string[] {
  const fieldsByAction = new Map<string, Set<string>>();
  for (const field of [...limited.values()].flat()) {
    const parts = field.path.split(".");
    fieldsByAction.set(parts[0]!, (fieldsByAction.get(parts[0]!) ?? new Set()).add(parts[parts.length - 1]!));
  }
  if (fieldsByAction.size === 0) return [];
  const files = sources.map(({ rel, content }) =>
    ts.createSourceFile(`/client/src/${rel}`, content, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  );
  const { inputs, fedPaths } = valueFlow(ts, files, fieldsByAction);
  const leaf = (path: string) => path.slice(path.lastIndexOf(".") + 1);
  const violations: string[] = [];
  for (const input of inputs) {
    let type: string | undefined;
    let numeric = false;
    let value: TS.Expression | undefined;
    let name: string | undefined;
    let spreadPath: string | undefined;
    let spread = false;
    const handWritten: string[] = [];
    for (const attr of input.node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        const text = attr.expression.getText();
        if (/^FIELDS\b/.test(text)) {
          spread = true;
          spreadPath = /^FIELDS\.([\w$.]+)$/.exec(text)?.[1];
        }
        continue;
      }
      const attrName = attr.name.getText();
      const init = attr.initializer;
      const expr = init !== undefined && ts.isJsxExpression(init) ? init.expression : undefined;
      const text = init !== undefined && ts.isStringLiteral(init) ? init.text : expr !== undefined && ts.isStringLiteralLike(expr) ? expr.text : undefined;
      if ((LIMIT_ATTRIBUTES as readonly string[]).includes(attrName)) handWritten.push(attrName);
      if (attrName === "type") type = text;
      if ((attrName === "type" || attrName === "inputMode") && text !== undefined) numeric ||= ["number", "numeric", "decimal"].includes(text);
      if (attrName === "name") name = text;
      if ((attrName === "value" || attrName === "defaultValue") && expr !== undefined) value = expr;
    }
    if (type !== undefined && NON_TEXT_TYPES.has(type)) continue;
    const paths = fedPaths(input, value, name);
    const fed = [...limited.values()].flat().filter((field) => {
      const action = field.path.slice(0, field.path.indexOf("."));
      return paths.has(`${action}.${leaf(field.path)}`) || paths.has(`*.${leaf(field.path)}`);
    });
    const line = input.file.getLineAndCharacterOfPosition(input.node.getStart()).line + 1;
    const where = `${input.file.fileName.slice("/client/src/".length)}:${line}: <${input.node.tagName.getText()}>`;
    const listed = handWritten.map((a) => `\`${a}\``).join(", ");
    if (handWritten.length > 0 && spread) {
      violations.push(`${where} hand-writes ${listed} next to its FIELDS spread, overriding the request schema's limits. Remove the hand-written attributes.`);
    } else if (spread && spreadPath !== undefined && fed.length > 0 && !fed.some((field) => leaf(field.path) === leaf(spreadPath!))) {
      const fix = fed.map((field) => `\`{...FIELDS.${field.path}}\``).join(" or ");
      violations.push(`${where} spreads \`FIELDS.${spreadPath}\`, but its value is sent as ${fed.map((field) => `\`${field.path}\``).join(" or ")}. Spread ${fix}.`);
    } else if (fed.length > 0 && !spread) {
      const fix = fed.map((field) => `\`{...FIELDS.${field.path}}\` (${field.limits})`).join(" or ");
      violations.push(
        handWritten.length > 0
          ? `${where} hand-writes ${listed}. Limits come only from the request schema: remove them and spread ${fix}.`
          : `${where} edits a request field the schema limits but has no FIELDS spread. Spread ${fix}.`,
      );
    }
    if (violations.length >= MAX_REPORTED) break;
  }
  return violations;
}

// A save skipped on blank text with no message: `if (title.trim()) add.mutate(...)` with no
// `else` that shows why, `title.trim() && add.mutate(...)`, or `if (!title.trim()) return;`
// before a save. A field holding only spaces passes the input's `required`, so the save
// silently does nothing. A guard behind a control that is already disabled while the field is
// blank (`disabled={!title.trim()}`) is fine: nothing can be dropped there.
const REASON_CALL = /\b(?:set\w*(?:err|msg|message|status|notice|hint|warn|problem|feedback)\w*|on\w*(?:error|invalid)\w*|toast|alert|setCustomValidity|reportValidity)\s*\(([^)]*)\)/gi;

/** Whether `text` shows a reason: a reason setter called with something other than an empty value. */
function showsReason(text: string): boolean {
  return /\breportValidity\s*\(/.test(text) || [...text.matchAll(REASON_CALL)].some((call) => !/^\s*(?:""|''|``|null|undefined|false)?\s*$/.test(call[1]!));
}

type BlankTest = { subject: TS.Expression; blankWhenTrue: boolean };

/** Saves skipped on blank text with no message, across one Space's client files. */
export function checkBlankInputDrops(
  ts: typeof TS,
  sources: Array<{ rel: string; content: string }>,
  actions: ReadonlySet<string>,
): string[] {
  const skip = (node: TS.Expression): TS.Expression => (ts.isParenthesizedExpression(node) ? skip(node.expression) : node);
  // `x.trim()` or `x.trim().length`: the trimmed text of `x`.
  const trimmed = (node: TS.Expression): TS.Expression | undefined => {
    let expr = skip(node);
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length") expr = skip(expr.expression);
    return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "trim"
      ? expr.expression.expression
      : undefined;
  };
  const blankTest = (node: TS.Expression): BlankTest | undefined => {
    const expr = skip(node);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = blankTest(expr.operand);
      return inner && { subject: inner.subject, blankWhenTrue: !inner.blankWhenTrue };
    }
    const subject = trimmed(expr);
    if (subject !== undefined) return { subject, blankWhenTrue: false };
    if (!ts.isBinaryExpression(expr)) return undefined;
    const op = expr.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.BarBarToken || op === K.AmpersandAmpersandToken) {
      // `!a.trim() || !b.trim()` is blank when either is; `a.trim() && b.trim()` is filled when both are.
      const [left, right] = [blankTest(expr.left), blankTest(expr.right)];
      const want = op === K.BarBarToken;
      if (left?.blankWhenTrue === want) return left;
      if (right?.blankWhenTrue === want) return right;
      return undefined;
    }
    const left = trimmed(expr.left);
    if (left === undefined) return undefined;
    const value = skip(expr.right);
    const empty = (ts.isStringLiteral(value) && value.text === "") || (ts.isNumericLiteral(value) && value.text === "0");
    const one = ts.isNumericLiteral(value) && value.text === "1";
    if ((op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken) && empty) return { subject: left, blankWhenTrue: true };
    if ((op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken) && empty) return { subject: left, blankWhenTrue: false };
    if ((op === K.LessThanToken && one) || (op === K.LessThanEqualsToken && empty)) return { subject: left, blankWhenTrue: true };
    if ((op === K.GreaterThanToken && empty) || (op === K.GreaterThanEqualsToken && one)) return { subject: left, blankWhenTrue: false };
    return undefined;
  };
  const saves = (node: TS.Node | undefined): boolean => {
    let found = false;
    const visit = (child: TS.Node): void => {
      if (found) return;
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
        const name = child.expression.name.text;
        if (name === "mutate" || name === "mutateAsync" || actions.has(name)) found = true;
      }
      ts.forEachChild(child, visit);
    };
    if (node !== undefined) visit(node);
    return found;
  };
  const exits = (node: TS.Statement): boolean =>
    ts.isReturnStatement(node) || (ts.isBlock(node) && node.statements.length > 0 && ts.isReturnStatement(node.statements[node.statements.length - 1]!));
  // A save in the statements after `node` in its block.
  const savesAfter = (node: TS.Statement): boolean => {
    const parent = node.parent;
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
    const statements = [...parent.statements];
    return statements.slice(statements.indexOf(node) + 1).some((statement) => saves(statement));
  };

  const violations: string[] = [];
  for (const { rel, content } of sources) {
    const file = ts.createSourceFile(`/client/src/${rel}`, content, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const disabledWhenBlank: string[] = [];
    const found: Array<[TS.Node, TS.Expression]> = [];
    const visit = (node: TS.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === "disabled" && node.initializer !== undefined && ts.isJsxExpression(node.initializer)) {
        disabledWhenBlank.push(node.initializer.expression?.getText() ?? "");
      } else if (ts.isIfStatement(node)) {
        const test = blankTest(node.expression);
        if (test !== undefined) {
          const blankBranch = test.blankWhenTrue ? node.thenStatement : node.elseStatement;
          const silent = test.blankWhenTrue
            ? exits(node.thenStatement) && savesAfter(node)
            : saves(node.thenStatement);
          if (silent && !(blankBranch !== undefined && showsReason(blankBranch.getText()))) found.push([node, test.subject]);
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !ts.isJsxExpression(node.parent)) {
        const test = blankTest(node.left);
        if (test !== undefined && !test.blankWhenTrue && saves(node.right)) found.push([node, test.subject]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const [node, subject] of found) {
      const name = subject.getText().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (disabledWhenBlank.some((guard) => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(guard))) continue;
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const shown = ts.isIfStatement(node) ? `if (${node.expression.getText()})` : node.getText().split("\n")[0]!.slice(0, 80);
      violations.push(
        `${rel}:${line}: \`${shown}\` skips the save on blank text without telling the person. Show the reason next to the field instead: \`if (!title.trim()) { setTitleError(<correction>); return; }\` before the save.`,
      );
      if (violations.length >= MAX_REPORTED) return violations;
    }
  }
  return violations;
}

export const INPUT_LIMITS_GUIDANCE =
  'Give every form input the server\'s own limits: `const FIELDS = actionFields<typeof Actions>();` with ' +
  '`import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" }`, then spread the request field it feeds ' +
  "onto the input. Put any limit an input needs into the action's request schema.";
