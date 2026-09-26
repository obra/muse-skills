/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Opaque blob navigation rejects fragment URLs. The History API can update the
// current document's fragment without loading another blob or changing origin.
export function installFragmentLinks(): void {
  if (!location.href.startsWith("blob:null/")) return;

  // Capture these before the tunnel wraps URL and drops authored history URLs.
  const NativeURL = URL;
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);

  window.addEventListener("click", (event) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const anchor = event.composedPath().find(
      (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
    );
    if (!anchor || anchor.hasAttribute("download")) return;
    const targetName = anchor.getAttribute("target") ??
      document.querySelector("base[target]")?.getAttribute("target") ?? "";
    if (targetName !== "" && targetName.toLowerCase() !== "_self") return;
    const href = anchor.getAttribute("href");
    if (!href?.startsWith("#")) return;

    const oldURL = location.href;
    const nextURL = new NativeURL(href, oldURL);
    event.preventDefault();
    const changed = nextURL.href !== oldURL;
    if (changed) {
      pushState(null, "", nextURL.href);
    } else {
      replaceState(null, "", nextURL.href);
    }
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));

    const target = fragmentTarget(nextURL.hash);
    if (target) {
      target.scrollIntoView();
      // Keep keyboard navigation at the destination, including section titles.
      if (
        target !== document.documentElement &&
        (target instanceof HTMLElement || target instanceof SVGElement)
      ) {
        const hadTabIndex = target.hasAttribute("tabindex");
        if (!hadTabIndex) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        if (!hadTabIndex) target.removeAttribute("tabindex");
      }
    }
    if (changed) {
      queueMicrotask(() => window.dispatchEvent(new HashChangeEvent("hashchange", {
        oldURL,
        newURL: nextURL.href,
      })));
    }
  });
}

function fragmentTarget(hash: string): Element | null {
  // URL fragments use percent decoding followed by UTF-8 replacement decoding,
  // so a literal percent sign remains valid and malformed UTF-8 does not throw.
  const bytes = hash.slice(1).replace(/%([0-9a-f]{2})/gi, (_match: string, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  const fragment = new TextDecoder().decode(
    Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)),
  );
  if (fragment === "") return document.documentElement;
  const idTarget = document.getElementById(fragment);
  if (idTarget) return idTarget;
  const namedTarget = Array.from(document.getElementsByName(fragment)).find(
    (node) => node instanceof HTMLAnchorElement,
  );
  return namedTarget ??
    (fragment.toLowerCase() === "top" ? document.documentElement : null);
}
