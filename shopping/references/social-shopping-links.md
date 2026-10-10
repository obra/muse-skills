# Shopping Links from Instagram and Facebook

Load this file for shopping requests that include an Instagram link or a `facebook.com/reel/` link.

## Instagram links

1. Use `instagram-cli post` and `instagram-cli media-understanding` to fetch the shopping context for the provided Instagram link.
2. If the shopping context contains multiple products and the user has not already selected one or more of them, ask which product or products they want.
3. If the shopping context contains product IDs:
   - Inspect the complete `instagram-cli media-understanding` response at `media[].shopping_context.tagged_products[]`. Build `selected_tagged_products` from the complete tagged-product objects for every item the user chose, preserving the user's selection order. Do not reduce multiple chosen items to one.
   - For each `selected_tagged_product`, set its `tagged_product_item_id` from `selected_tagged_product.product_item_id`. Verify that this exact ID occurs in `media[].shopping_context.tagged_products[]`, and set `matched_tagged_record=true` for that item only after verification passes. If any selected item does not pass, stop and resolve that mismatch; do not fall back for it.
   - For each verified item, persist the exact `creator_offsite_url` value from that same tagged-product object, including its missing or blank state.
   - For each verified item, call `shopping product-details --product-id <tagged_product_item_id>`. Store the returned `product.id` separately as that item's `canonical_product_id`. These IDs may differ; never overwrite a `tagged_product_item_id` with a `canonical_product_id`.
   - Write one temporary `{"products": [...]}` JSON file with one entry per selected item, in the user's selection order. Each entry must set `product_id` to that item's `canonical_product_id` and copy `product.name`, `product.price`, and `product.images[0].url` from that item's product-details response into `name`, `price`, and `image_url`. Set each entry's `url` according to the next step. Copy no field the product-details response does not contain, and never take canonical product metadata from the Instagram response.
   - For each entry, if the user requested a direct or non-affiliate merchant URL, use that item's `product.url`. Otherwise, use the persisted nonblank `creator_offsite_url` from that item's exact `selected_tagged_product`. Use `product.url` as fallback only when `matched_tagged_record=true` for that item and that exact record has an absent or blank `creator_offsite_url`. Never copy one tagged product's URL onto another product. Preserve every `creator_offsite_url` verbatim: do not open it, dereference it, follow its redirects, or canonicalize it before writing it.
   - Pass the completed file in `result_paths` and every selected item's `canonical_product_id` in `selected_ids`, in the user's selection order, to `shopping.resolve_results`. Do not run product search for an item when its tagged product ID is available.
4. If the shopping context contains no product IDs, execute the product discovery workflow using the available shopping context.
5. Surface the selected products in the shopping-results widget and mention them using product markers.

## Facebook Reel links

Do not open the Reel in the browser. `shoppable_products` describes detected products; `featured_products` contains similar products, not confirmed identifications.

Before routing, collect only constraints whose applicability is already established. Resolve category-dependent requirements after the first Reel read, using the Shopping Skill's preference and required-attribute rules. Include relevant saved hard requirements even when not repeated in this request; explicit current instructions override conflicting saved requirements. Soft preferences alone do not trigger fresh discovery or change the default featured IDs or their order.

Choose the first matching path:

1. **Choose from shown results:** If the user explicitly limits their request to products already shown, filter only those results using verified attributes. Missing or unclear attributes are not matches. If none match, say so; do not start a new search.
2. **Specific shopping request:** Otherwise, if the user names a product or category, or there are applicable constraints, use `facebook-cli post read --url '<link>'` without `--out` for Reel context. Run fresh searches through the standard Product discovery workflow for the requested targets, or otherwise the products in `shoppable_products`, with all applicable constraints—even if featured candidates match. If neither provides a target, ask what the user wants to shop for. Do not substitute filtering featured products for fresh discovery.
3. **General Reel shopping:** Otherwise, use `facebook-cli post read --url '<link>' --out <file>` to fetch the shopping context and a set of similar products. If a hard requirement applies after reading, reuse this context for fresh standard Product discovery with all applicable constraints. Search the products in `shoppable_products`, or ask which product if there are none. Do not filter featured products or repeat `post read`. Only if no hard requirement applies, use the CLI status, not file existence:
   - `featured_products_status=available`: `<file>` is a resolver-ready catalog. Pass it and every ID in `ordered_featured_product_ids`, unchanged and in order, to `shopping.resolve_results`. Do not drop or rerank IDs or run extra discovery. The CLI summary is sufficient; you do not need to read `<file>`.
   - `featured_products_status=unavailable`: no resolver catalog was written and `ordered_featured_product_ids` is empty. Never pass `<file>` to the resolver. Use the standard Product discovery workflow for the products in `shoppable_products`; if there are none, ask which product the user wants.

For both search paths, honor an explicit catalog-only request: use only catalog search and skip browser product search. Otherwise, follow the Shopping Skill's standard Product discovery tool selection, including browser product search. Finish all required searches before one shopping-results presentation, passing all usable result files and selected IDs together to `shopping.resolve_results`.

Surface the resolved products in the shopping-results widget and mention them via product markers in the text response.
