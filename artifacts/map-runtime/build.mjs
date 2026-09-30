/**
 * Build the artifact map runtime into a single IIFE plus its stylesheet, and
 * the skill's map helpers into a second IIFE beside them.
 *
 * Output is vendored into the bundle at /opt/hatch/assets/maps/ and loaded by
 * generated web artifacts with plain tags — no bundler on the artifact
 * side. The control's two files are both required: MapLibre ships its
 * controls' layout in CSS, and loading the script alone stacks the tiles on
 * top of each other, which looks broken rather than missing.
 *
 * map_helpers.js is the classic-script form of ../scripts/map_helpers.mjs,
 * generated rather than hand-written so the two cannot drift. A generated
 * static page's own JavaScript has to be classic scripts, so a page that
 * imported the .mjs would be refused at build; the module stays for
 * map_urls.mjs and for TypeScript Spaces, which do have a bundler.
 */

import {spawnSync} from 'node:child_process';
import {mkdirSync, rmSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, 'src', 'index.tsx');
const OUT = join(DIST, 'hatch-maps.js');
const HELPERS_ENTRY = join(ROOT, '..', 'scripts', 'map_helpers.mjs');
const HELPERS_OUT = join(DIST, 'map_helpers.js');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {stdio: 'inherit', cwd: ROOT, ...options});
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (status ${result.status})`);
  }
}

function resolveBun() {
  for (const candidate of [
    process.env.SPACES_BUN_BINARY,
    '/opt/hatch-image/bin/bun',
    '/opt/hatch/bin/bun',
    'bun',
  ].filter(Boolean)) {
    if (spawnSync(candidate, ['--version'], {stdio: 'ignore'}).status === 0) {
      return candidate;
    }
  }
  throw new Error(
    'bun not found (tried SPACES_BUN_BINARY, /opt/hatch-image/bin/bun, ' +
      '/opt/hatch/bin/bun, $PATH)',
  );
}

const bun = resolveBun();

rmSync(DIST, {recursive: true, force: true});
mkdirSync(DIST, {recursive: true});

// @meta/maps resolves from Metaccio; see .npmrc and bunfig.toml, which both
// scope only @meta so jarvis's other JS deps keep resolving from public npm.
// --frozen-lockfile: the bundle build is meant to be reproducible across
// builder architectures, and @meta/maps is a caret range, so an install
// free to re-resolve could ship a version the lockfile never recorded.
run(bun, ['install', '--frozen-lockfile']);

// esbuild rather than `bun build`: the barrel emits a stylesheet alongside the
// script, and esbuild's outfile/outdir handling for that pair is what the
// vendored layout depends on.
run(bun, [
  'x',
  'esbuild',
  ENTRY,
  '--bundle',
  '--format=iife',
  '--global-name=HatchMaps',
  '--platform=browser',
  '--target=es2020',
  // Automatic runtime, not esbuild's classic default: the classic transform
  // emits React.createElement and this bundle has no React global, so every
  // JSX node in src/ throws "React is not defined" at mount time. The failure
  // is runtime-only — the build succeeds and the bundle looks correct.
  '--jsx=automatic',
  '--minify',
  '--define:process.env.NODE_ENV="production"',
  `--outfile=${OUT}`,
]);

// The helpers are plain browser JavaScript with no dependency of their own, so
// this pass only changes the module's calling convention: the seven exports
// become properties of a MapHelpers global. Not minified — a builder reads
// this copy when a mount misbehaves, and it is a few kilobytes either way.
run(bun, [
  'x',
  'esbuild',
  HELPERS_ENTRY,
  '--bundle',
  '--format=iife',
  '--global-name=MapHelpers',
  '--platform=browser',
  '--target=es2020',
  `--outfile=${HELPERS_OUT}`,
]);

for (const required of [OUT, join(DIST, 'hatch-maps.css'), HELPERS_OUT]) {
  if (!existsSync(required)) {
    throw new Error(`expected build output missing: ${required}`);
  }
}

console.log('artifact map runtime built into', DIST);
