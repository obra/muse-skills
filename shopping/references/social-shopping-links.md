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

1. Use `facebook-cli post read --url '<link>'` to fetch the shopping context for the provided `facebook.com/reel/` link. Do not open the link in the browser. Its `shoppable_products` are the products Facebook identified in the reel.
2. If the user named a product, shop for that product. Otherwise, shop for the products in `shoppable_products`. If there are none, ask the user which product they want.
3. Execute the product discovery workflow for those products using the data provided in the shopping context, such as `brand_name`, `color`, and `product_name`, together with any constraints the user gave, but skip browser product search and search with<!-- catalog-search-v1-only:start --> `meta-catalog-search`<!-- catalog-search-v1-only:end --><!-- catalog-search-v2-only:start --> `shopping catalog-search`<!-- catalog-search-v2-only:end --> only.
4. Surface the found products in the shopping results widget and mention them via product markers in the text response.
