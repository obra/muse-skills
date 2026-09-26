/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Download activation is a fetch, unlike an ordinary navigation link. Private
// assets must use the existing Space tunnel before the browser saves the bytes.
export function installDownloadLinks(
  fetchAsset: typeof fetch,
  isExternalUrl: (url: string) => boolean,
  revokeDelayMs: number,
): void {
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const anchor = event.composedPath().find(
      (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
    );
    if (!anchor?.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || isExternalUrl(href)) return;

    event.preventDefault();
    const filename = anchor.download || resourceFilename(href);
    void (async () => {
      const response = await fetchAsset(href);
      if (!response.ok) {
        throw new Error(`Artifact download failed: HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Let the browser consume the download before releasing its object URL.
        setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
      }
    })().catch((error) => reportError(error));
  });
}

function resourceFilename(href: string): string {
  const path = new URL(href, document.baseURI).pathname;
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    // A literal or malformed percent escape is part of the resource's name.
    return name;
  }
}
