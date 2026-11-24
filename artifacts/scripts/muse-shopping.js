/* Muse shopping: opens a product's details in the Muse app showing this page.
   Keep this file unchanged; /opt/muse/assets/artifacts/references/product-cards.md
   describes its API. Where no Muse app can open the details (a plain browser,
   a shared copy), product links open the merchant page. */
(function () {
  "use strict";
  if (window.museShopping) return;

  var MAX_PRODUCT_JSON_LENGTH = 16384;
  var webHostOpensProducts = false;
  var boundProducts = new WeakMap();

  // The web app announces what it handles once the page loads, so a page in
  // any other frame never posts a request nobody will answer.
  if (window.parent !== window) {
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data || data.type !== "hatch:space:capabilities" || data.version !== 1) return;
      webHostOpensProducts =
        Array.isArray(data.capabilities) && data.capabilities.indexOf("open_product") !== -1;
    });
  }

  function iosHandler() {
    var webkit = window.webkit;
    return (webkit && webkit.messageHandlers && webkit.messageHandlers.hatchSpacesShoppingKit) || null;
  }

  function androidBridge() {
    var bridge = window._fwaSpacesShoppingKit;
    return bridge && typeof bridge.openProduct === "function" ? bridge : null;
  }

  function canOpenProduct() {
    return iosHandler() !== null || androidBridge() !== null || webHostOpensProducts;
  }

  function productJson(product) {
    if (!product || typeof product !== "object") return null;
    if (typeof product.name !== "string" || typeof product.url !== "string") return null;
    if (!/^https?:\/\//i.test(product.url)) return null;
    // Clients decode the record as a widget card, which needs absolute links.
    if (product.image_url != null && product.image_url !== "" &&
        !(typeof product.image_url === "string" && /^https?:\/\//i.test(product.image_url))) {
      return null;
    }
    var json = JSON.stringify(product);
    return json.length <= MAX_PRODUCT_JSON_LENGTH ? json : null;
  }

  function openProduct(product) {
    var json = productJson(product);
    if (json === null) {
      return Promise.reject(new DOMException("Not a product card", "DataError"));
    }
    var handler = iosHandler();
    if (handler !== null) {
      return Promise.resolve(
        handler.postMessage({ action: "open_product", product: JSON.parse(json) })
      ).then(function () {});
    }
    var bridge = androidBridge();
    if (bridge !== null) {
      var result;
      try {
        result = bridge.openProduct(String(window.__fbAndroidBridgeAuthToken || ""), json);
      } catch (error) {
        result = null;
      }
      return result === "ok"
        ? Promise.resolve()
        : Promise.reject(new DOMException("Muse could not open the product", "AbortError"));
    }
    if (webHostOpensProducts) {
      window.parent.postMessage(
        { type: "hatch:space:open-product", version: 1, product: JSON.parse(json) },
        "*"
      );
      return Promise.resolve();
    }
    return Promise.reject(new DOMException("No Muse app can open products here", "NotSupportedError"));
  }

  function bindProduct(element, product) {
    boundProducts.set(element, product);
  }

  function boundProductFor(target) {
    for (var node = target; node && node !== document; node = node.parentNode) {
      if (boundProducts.has(node)) return { element: node, product: boundProducts.get(node) };
    }
    return null;
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var bound = boundProductFor(event.target);
    if (bound === null || !canOpenProduct()) return;
    event.preventDefault();
    openProduct(bound.product).catch(function () {
      window.open(bound.product.url, "_blank", "noopener");
    });
  });

  Object.defineProperty(window, "museShopping", {
    value: Object.freeze({
      get canOpenProduct() {
        return canOpenProduct();
      },
      openProduct: openProduct,
      bindProduct: bindProduct
    })
  });
})();
