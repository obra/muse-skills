---
description: Show remembered products in a fullstack Space with the SDK's saved-products action.
builders: web
---

# Product cards

## Build the page

- Read `~/memory/products/INDEX.md` and pick the lists the request names. A Space supports 20 declared lists and a read supports 500 products. When the request exceeds those limits or no list fits, report `status: "failure"` as your Completion section describes so your parent agent can narrow or split the request.

- Set `space.json.savedProductLists` to the exact list names in page order. This declaration is the selection the page reads and follows on list changes.

- Run `/opt/hatch/bin/product-lists link-page --list "<list name>" --space <slug>` for each selected list.

- Export `getProducts: savedProductsAction({ messages: "en" })` for an English page, importing `savedProductsAction` from `@hatch/space-sdk`. For another language, supply `messages` with all six page-language strings: `currentPrice`, `lastCheckedPrice`, `savedPrice`, `snapshotNotice`, `unavailableNotice` and `ownerSharedCopyNotice`. Call the action from `useQuery` with the scaffold's `spaceQueryClient`; keep visible cards during a refetch. The helper owns the cache and cross-client updates, so add no cache handler, refresh task, timer or rebuild for list changes.

- Render each returned item's `product` fields, `image` and `priceLabel`. Use `<a href={product.url} target="_blank" rel="noopener">` cards and pass the untouched product to `window.museShopping.bindProduct` in the ref callback. Omit absent fields and render an honest gap when `image` is null; keep remote `product.image_url` only in the product object passed to Muse, not as the displayed photo.

## Enable product details

- Copy `/opt/muse/assets/artifacts/scripts/muse-shopping.js` to `client/src/muse-shopping.js` and import `"./muse-shopping.js"` from the client entry for its side effects. This helper is opt-in for product pages; keep one client bundle and leave other Spaces unchanged. Supported owner clients open Muse details; other clients and shared copies keep the merchant link.

## Verify and edit

- Render the action's `notice` and `snapshotAt` when present. An owner who opens the shared link sees `ownerSharedCopyNotice` whether or not the shared copy has saved products to show, so write that notice to hold in both cases. Tell the owner they are looking at their shared copy and that the original Space in Muse shows their live saved products. That is all the notice needs to say, because the shared copy may be empty. Signing in on the shared link does not enable live reads. Shared, published and viewerless build contexts use a saved snapshot or an unavailable state. Verify the available state during the build and report the owner's live path as unverified when it cannot run. A refusal is not permission to invent owner identity or switch access routes.

- Show a gone-list note for `missing: true` and an empty-list message for no items. The returned cards do not provide stock status or price history; disclose that gap instead of adding stock filters or price watches.

- Preserve the design on edits unless the request changes it. Add or remove names in `savedProductLists`, link added lists, and run `product-lists unlink-page` for removed lists that still exist. A deleted list needs no unlink command.
