// Muse icon tool over the shipped icon source. Bundled into ts-runtime/dist/icons.js;
// reads spaces/icons/icons.json.gz and spaces/icons/aliases.json.
//
// The artifact build runs the first two; builders do not need them:
//   bun icons.js resolve --space=<dir>
//       Resolve the names a TypeScript artifact imports from "@space/icons" and
//       write client/.generated/icons.ts with only those glyphs.
//   bun icons.js fill --html=<file>
//       Replace <svg data-icon="name"> placeholders in a staged static page.
// Lookup for debugging:
//   bun icons.js search <query> [<query>...] [--limit=5]
//   bun icons.js svg <name> [<name>...] [--weight=400] [--size=24] [--label=<text>]
//
// A name resolves only to an exact icon or a reviewed alias (familiar Lucide,
// Material Symbols, or Heroicons names), so a rebuild picks the same icon. Logos
// and product marks resolve only with a Brand prefix. Anything else fails with
// the closest icons, which the builder fixes like a type error.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

import { renderIconSvg } from "../sdk/src/icons/static";
import type { IconGlyph, IconPath, IconSize, IconWeight } from "../sdk/src/icons/types";

type Variant = { paths: IconPath[] };
type SourceIcon = {
  name: string;
  module: string;
  component: string;
  description: string;
  keywords: string[];
  brand: boolean;
  variants: Partial<Record<string, Variant>>;
};
type Resolved = { icon: SourceIcon; via: "name" | "alias" };
type Lookup = Resolved | { error: string };
/** How a suggestion is spelled where the name was written. */
type Spell = (icon: SourceIcon) => string;

const ICONS_DIR = join(import.meta.dir, "..", "..", "icons");
const MODULE_SPECIFIER = "@space/icons";
const GENERATED = join("client", ".generated", "icons.ts");
const WEIGHTS: readonly IconWeight[] = [300, 400, 500, 600, 700];
const SIZES: readonly IconSize[] = [12, 16, 20, 24, 32, 40, 48];
const DEFAULT_WEIGHT: IconWeight = 400;
// <Brand?><Name><Wght300..700?><Icon|Glyph>
const IMPORT_NAME = /^(Brand)?([A-Z][A-Za-z0-9]*?)(?:Wght(300|400|500|600|700))?(Icon|Glyph)$/;

class IconSet {
  readonly icons: SourceIcon[];
  private readonly byKey = new Map<string, SourceIcon[]>();
  private readonly aliasByKey = new Map<string, string[]>();
  private readonly byModule = new Map<string, SourceIcon>();

  constructor() {
    const source = JSON.parse(gunzipSync(readFileSync(join(ICONS_DIR, "icons.json.gz"))).toString("utf8")) as {
      icons: SourceIcon[];
    };
    const aliases = (JSON.parse(readFileSync(join(ICONS_DIR, "aliases.json"), "utf8")) as {
      aliases: Record<string, string>;
    }).aliases;
    this.icons = source.icons;
    for (const icon of this.icons) {
      this.byModule.set(icon.module, icon);
      push(this.byKey, key(icon.module), icon);
    }
    for (const [alias, target] of Object.entries(aliases)) {
      const targets = this.aliasByKey.get(key(alias)) ?? [];
      if (!targets.includes(target)) targets.push(target);
      this.aliasByKey.set(key(alias), targets);
    }
  }

  /** Exact icon, then reviewed alias; never a ranked guess. */
  lookup(name: string, brand: boolean, spell: Spell): Lookup {
    const wanted = key(name);
    const exact = this.byKey.get(wanted) ?? [];
    const aliased = (this.aliasByKey.get(wanted) ?? []).map((module) => this.byModule.get(module)!);
    const matches = exact.length > 0 ? exact : aliased;
    if (matches.length === 1) {
      const icon = matches[0]!;
      if (icon.brand && !brand) {
        return { error: `"${icon.module}" is a logo; use ${spell({ ...icon, brand: true })} if you mean the logo.` };
      }
      if (!icon.brand && brand) return { error: `"${icon.module}" is not a logo; use ${spell(icon)}.` };
      return { icon, via: exact.length > 0 ? "name" : "alias" };
    }
    const candidates = matches.length > 1 ? matches : this.closest(name, brand, 3);
    const listed = candidates.map((icon) => `${spell(icon)} (${icon.description})`).join(", ");
    const what = matches.length > 1 ? "matches more than one icon" : "matches no icon";
    return { error: `"${name}" ${what}.${listed ? ` Closest: ${listed}.` : ""}` };
  }

  /** Lenient lookup for the debugging commands: brands allowed, ranked fallback. */
  find(name: string): SourceIcon | undefined {
    const strict = this.lookup(name, false, (icon) => icon.module);
    if ("icon" in strict) return strict.icon;
    return this.byKey.get(key(name))?.[0] ?? this.byModule.get(name);
  }

  /** Icons matching every word, else any word, best first. */
  closest(query: string, brand: boolean, limit: number): SourceIcon[] {
    const all = this.ranked(query, brand, true);
    return (all.length > 0 ? all : this.ranked(query, brand, false)).slice(0, limit);
  }

  private ranked(query: string, brand: boolean, everyWord: boolean): SourceIcon[] {
    const words = words_(query);
    return this.icons
      .filter((icon) => icon.brand === brand)
      .map((icon) => {
        const tokens = icon.module.split("-");
        const haystack = [icon.module, icon.description, ...icon.keywords].join(" ").toLowerCase();
        const score = words.reduce(
          (total, word) => total + (tokens.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0),
          0,
        );
        return { icon, score };
      })
      .filter(({ score }) => score > 0 && (!everyWord || score >= words.length))
      .sort((a, b) => b.score - a.score || a.icon.module.length - b.icon.module.length || a.icon.module.localeCompare(b.icon.module))
      .map(({ icon }) => icon);
  }
}

function push<V>(map: Map<string, V[]>, k: string, value: V): void {
  const list = map.get(k) ?? [];
  list.push(value);
  map.set(k, list);
}

/** Case- and separator-insensitive: ChevronDown, chevron-down and chevron_down agree. */
function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words_(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function pascal(module: string): string {
  return module
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function weightsOf(icon: SourceIcon): number[] {
  return Object.keys(icon.variants).map(Number).sort();
}

function glyphOf(icon: SourceIcon, weight: IconWeight): IconGlyph | undefined {
  const variant = icon.variants[String(weight)];
  return variant == null ? undefined : { name: icon.name, weight, viewBox: "0 0 24 24", paths: variant.paths };
}

// ---- resolve: TypeScript artifacts -------------------------------------------------

type Request = { name: string; file: string };

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every name a client source file imports or re-exports from "@space/icons". */
function scanRequests(space: string, errors: string[]): Request[] {
  const requests: Request[] = [];
  const statement = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s+from\s+["']@space\/icons["']/g;
  for (const path of sourceFiles(join(space, "client", "src"))) {
    const file = relative(space, path);
    const text = stripComments(readFileSync(path, "utf8"));
    for (const match of text.matchAll(statement)) {
      const clause = match[1]!.trim();
      const braces = /^\{([\s\S]*)\}$/.exec(clause);
      if (braces == null) {
        errors.push(`${file}: import icons by name, e.g. import { HomeIcon } from "${MODULE_SPECIFIER}".`);
        continue;
      }
      for (const raw of braces[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name) requests.push({ name, file });
      }
    }
  }
  return requests;
}

function generatedModule(set: IconSet, requests: Request[], errors: string[]): string {
  const glyphs = new Map<string, { icon: SourceIcon; weight: IconWeight }>();
  const exports: string[] = [];
  const seen = new Set<string>();
  for (const { name, file } of requests) {
    if (seen.has(name)) continue;
    seen.add(name);
    const parts = IMPORT_NAME.exec(name);
    if (parts == null) {
      const hint = name === "Icon" || name === "createIcon" ? ` Import ${name} from "@hatch/space-sdk/icons".` : "";
      errors.push(`${file}: ${name} is not an icon name (expected e.g. HomeIcon, HomeWght600Icon, HomeGlyph).${hint}`);
      continue;
    }
    const [, brand, core, weightText, kind] = parts;
    const suffix = `${weightText == null ? "" : `Wght${weightText}`}${kind}`;
    const found = set.lookup(core!, brand != null, (icon) => `${icon.brand ? "Brand" : ""}${pascal(icon.module)}${suffix}`);
    if ("error" in found) {
      errors.push(`${file}: ${name}: ${found.error}`);
      continue;
    }
    const weight = (weightText == null ? DEFAULT_WEIGHT : Number(weightText)) as IconWeight;
    if (glyphOf(found.icon, weight) == null) {
      errors.push(`${file}: ${name}: "${found.icon.module}" has weights ${weightsOf(found.icon).join(", ")}.`);
      continue;
    }
    const id = `${found.icon.module.replaceAll("-", "_")}_${weight}`;
    glyphs.set(id, { icon: found.icon, weight });
    exports.push(
      kind === "Glyph"
        ? `export const ${name} = ${id};\n`
        : `export function ${name}(props: IconAppearance & IconAccessibility): ReactElement {\n  return Icon({ ...props, glyph: ${id} });\n}\n`,
    );
  }
  const header = [
    "/** Generated by the artifact build from this artifact's \"@space/icons\" imports. */\n",
    "// Do not edit: import icons by name from \"@space/icons\" and rebuild.\n",
  ];
  if (exports.length === 0) return `${header.join("")}export {};\n`;
  const components = exports.some((line) => line.startsWith("export function"));
  const lines = [
    ...header,
    ...(components
      ? [
          'import type { ReactElement } from "react";\n',
          'import { Icon, type IconAccessibility, type IconAppearance, type IconGlyph } from "@hatch/space-sdk/icons";\n\n',
        ]
      : ['import type { IconGlyph } from "@hatch/space-sdk/icons";\n\n']),
  ];
  for (const [id, { icon, weight }] of glyphs) {
    lines.push(`const ${id}: IconGlyph<${JSON.stringify(icon.name)}, ${weight}> = ${JSON.stringify(glyphOf(icon, weight))};\n`);
  }
  lines.push("\n", ...exports);
  return lines.join("");
}

function resolve(args: string[]): void {
  const space = flag(args, "space");
  if (space == null) throw new Error("resolve needs --space=<artifact dir>");
  const out = join(space, GENERATED);
  const errors: string[] = [];
  const requests = scanRequests(space, errors);
  const source = requests.length === 0 && errors.length === 0
    ? "/** Generated by the artifact build. This artifact imports no icons. */\nexport {};\n"
    : generatedModule(new IconSet(), requests, errors);
  if (errors.length > 0) {
    rmSync(out, { force: true });
    throw new Error(
      `icons: ${errors.length} import${errors.length === 1 ? "" : "s"} from "${MODULE_SPECIFIER}" did not resolve:\n` +
        errors.map((error) => `- ${error}`).join("\n") +
        "\nImport one of the closest names, or describe the icon differently.",
    );
  }
  mkdirSync(join(space, "client", ".generated"), { recursive: true });
  writeFileSync(out, source);
  process.stdout.write(`icons: resolved ${new Set(requests.map((r) => r.name)).size} icon import(s)\n`);
}

// ---- fill: static pages -----------------------------------------------------------

function attributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of text.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs.set(match[1]!.toLowerCase(), match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function fill(args: string[]): void {
  const html = flag(args, "html");
  if (html == null) throw new Error("fill needs --html=<file>");
  const text = readFileSync(html, "utf8");
  const placeholder = /<svg\b([^>]*\bdata-icon\s*=[^>]*?)\s*(?:\/>|>\s*<\/svg>)/gi;
  if (!/\bdata-icon\s*=/i.test(text)) return;
  const set = new IconSet();
  const errors: string[] = [];
  let count = 0;
  const filled = text.replace(placeholder, (whole, attrText: string) => {
    const attrs = attributes(attrText);
    const raw = attrs.get("data-icon") ?? "";
    const brand = /^brand[-_:\s]/i.test(raw);
    const name = brand ? raw.replace(/^brand[-_:\s]+/i, "") : raw;
    const found = set.lookup(name, brand, (icon) => `data-icon="${icon.brand ? "brand-" : ""}${icon.module}"`);
    if ("error" in found) {
      errors.push(`data-icon="${raw}": ${found.error}`);
      return whole;
    }
    const weight = Number(attrs.get("data-weight") ?? DEFAULT_WEIGHT) as IconWeight;
    const glyph = WEIGHTS.includes(weight) ? glyphOf(found.icon, weight) : undefined;
    if (glyph == null) {
      errors.push(`data-icon="${raw}": weight ${attrs.get("data-weight")} is not available (${weightsOf(found.icon).join(", ")}).`);
      return whole;
    }
    const size = Number(attrs.get("width") ?? attrs.get("height") ?? 24) as IconSize;
    if (!SIZES.includes(size)) {
      errors.push(`data-icon="${raw}": size ${size} is not one of ${SIZES.join(", ")}.`);
      return whole;
    }
    const label = attrs.get("aria-label")?.trim();
    const className = attrs.get("class");
    const svg = label
      ? renderIconSvg({ glyph, size, label, ...(className ? { className } : {}) })
      : renderIconSvg({ glyph, size, decorative: true, ...(className ? { className } : {}) });
    const kept = ["id", "style"]
      .filter((attr) => attrs.has(attr))
      .map((attr) => ` ${attr}="${escapeAttr(attrs.get(attr)!)}"`)
      .join("");
    count += 1;
    return svg.replace("<svg ", `<svg data-icon="${escapeAttr(raw)}"${kept} `);
  });
  if (errors.length > 0) {
    throw new Error(
      `icons: ${errors.length} icon placeholder${errors.length === 1 ? "" : "s"} did not resolve:\n` +
        errors.map((error) => `- ${error}`).join("\n") +
        "\nUse one of the closest names, or describe the icon differently.",
    );
  }
  writeFileSync(html, filled);
  process.stdout.write(`icons: filled ${count} icon placeholder(s)\n`);
}

// ---- search / svg: debugging ------------------------------------------------------

function line(icon: SourceIcon, via?: string): string {
  const from = via == null ? "" : ` (alias ${via})`;
  const brand = icon.brand ? " [logo]" : "";
  return `  ${pascal(icon.module)}Icon${from}${brand}\t[${weightsOf(icon).join(",")}]\t${icon.description}\n`;
}

function search(args: string[]): void {
  const queries = args.filter((arg) => !arg.startsWith("--"));
  const limit = Number(flag(args, "limit") ?? 5);
  if (queries.length === 0) throw new Error("search needs at least one query");
  const set = new IconSet();
  for (const query of queries) {
    process.stdout.write(`${query}:\n`);
    const spell = (icon: SourceIcon) => icon.module;
    const direct = set.lookup(query, false, spell);
    const brandDirect = "icon" in direct ? undefined : set.lookup(query, true, spell);
    const hit = "icon" in direct ? direct : brandDirect != null && "icon" in brandDirect ? brandDirect : undefined;
    if (hit != null) process.stdout.write(line(hit.icon, hit.via === "alias" ? query : undefined));
    const rest = set.closest(query, false, limit).filter((icon) => icon !== hit?.icon);
    for (const icon of rest.slice(0, hit == null ? limit : limit - 1)) process.stdout.write(line(icon));
    if (hit == null && rest.length === 0) process.stdout.write("  no matching icons\n");
  }
}

function svg(args: string[]): void {
  const wanted = args.filter((arg) => !arg.startsWith("--"));
  if (wanted.length === 0) throw new Error("svg needs an icon name");
  const label = flag(args, "label");
  if (label != null && wanted.length > 1) throw new Error("--label applies to a single icon");
  const set = new IconSet();
  const weight = Number(flag(args, "weight") ?? DEFAULT_WEIGHT) as IconWeight;
  const size = Number(flag(args, "size") ?? 24) as IconSize;
  const unknown: string[] = [];
  for (const name of wanted) {
    const icon = set.find(name);
    if (icon == null) {
      unknown.push(name);
      continue;
    }
    const glyph = glyphOf(icon, weight);
    if (glyph == null) throw new Error(`${icon.module} has weights ${weightsOf(icon).join(", ")}`);
    const markup = label == null ? renderIconSvg({ glyph, size, decorative: true }) : renderIconSvg({ glyph, size, label });
    process.stdout.write(wanted.length > 1 ? `<!-- ${name} -->\n${markup}\n` : `${markup}\n`);
  }
  if (unknown.length > 0) throw new Error(`unknown icon(s): ${unknown.join(", ")}; run search with these names`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "resolve") resolve(rest);
  else if (command === "fill") fill(rest);
  else if (command === "search") search(rest);
  else if (command === "svg") svg(rest);
  else {
    throw new Error(
      "usage: icons.js resolve --space=<dir> | fill --html=<file> | search <query>... | svg <name>... [--weight=400] [--size=24] [--label=<text>]",
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
