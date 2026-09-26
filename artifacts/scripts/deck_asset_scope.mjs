// Which local files a deck's own document may load, for the two scripts that open
// a deck in a browser (assemble_deck.mjs and render_audit.mjs).
//
// Both open the deck as a live `file://` page, and render_audit screenshots each
// slide into `.src/validate/page-N.png`, which the client can read back over
// `/fs/read`. So a slide that can name a local path is a file-read primitive with a
// screenshot attached. The markup checks in assemble_deck.mjs refuse that shape at
// authoring time, in the spelling the author used. This is the backstop underneath
// them: Chromium hands a route handler an absolute, normalized URL, so by the time a
// request arrives every spelling trick (`%2e%2e`, a backslash, a symlink) has been
// folded away, and one path comparison answers the question for good.
//
// Measured on a Hatch VM, because the answer decides whether this file is worth
// having: a `file:` subresource request DOES reach a Playwright route handler, and
// `route.abort()` leaves the image unloaded (`naturalWidth: 0`). Chromium's
// `--disable-file-access-from-file-urls` does NOT stop it: a `file://` page loaded
// `file:///tmp/target.png` into a screenshot identically with and without the flag.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/// The deck directories a document may read from, as real paths. A directory that
/// does not exist contributes nothing rather than throwing: `.src/media` is absent
/// on a deck with no images.
export function realRootsFor(directories) {
  const roots = [];
  for (const directory of directories) {
    try {
      roots.push(realpathSync(directory));
    } catch {
      /* absent, so nothing inside it can be requested */
    }
  }
  return roots;
}

/// Whether a `file:` URL lands inside one of those roots.
///
/// Chromium normalizes a URL before a route handler sees it, so the path carries no
/// dot segment in any spelling by the time it arrives. Symlinks are the part the URL
/// parser cannot fold, so follow them when the file is really there. When it is not,
/// judge the path as written: a deck that names a missing `media/hero.png` should get
/// an ordinary 404, not a refusal that reads like an attack.
export function fileUrlWithinRoots(url, realRoots) {
  let path;
  try {
    path = fileURLToPath(url);
  } catch {
    return false;
  }
  let target;
  try {
    target = realpathSync(path);
  } catch {
    target = resolve(path);
  }
  return realRoots.some((root) => target === root || target.startsWith(root + sep));
}
