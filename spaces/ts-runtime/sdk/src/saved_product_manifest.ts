// The saved-product lists a Space's `space.json` declares, read the way the
// daemon reads them before a live read. The VM worker and the Cloudflare
// build both load this file, so it imports nothing.

export const MAX_SPACE_MANIFEST_BYTES = 64 * 1024;
const MAX_LISTS = 20;
const MAX_LIST_NAME_BYTES = 256;

/**
 * `space.json.savedProductLists` from a parsed `space.json`, or undefined
 * when the manifest declares no valid selection: not a stateful Space, not an
 * array of at most 20 distinct names of 1 to 256 UTF-8 bytes.
 */
export function declaredSavedProductLists(manifest: unknown): readonly string[] | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const { runtime, savedProductLists: declared } = manifest as Record<string, unknown>;
  if (runtime !== "typescript" || !Array.isArray(declared) || declared.length > MAX_LISTS) {
    return undefined;
  }
  const encoder = new TextEncoder();
  const names: string[] = [];
  for (const name of declared) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      encoder.encode(name).length > MAX_LIST_NAME_BYTES ||
      names.includes(name)
    ) {
      return undefined;
    }
    names.push(name);
  }
  return Object.freeze(names);
}
