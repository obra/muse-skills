---
name: "shopify"
description: >
  Set up and operate a Shopify store with Shopify's official MCP server (the
  installed `shopify` command, NOT the npm Shopify CLI). Use whenever someone
  wants to sell online, start an online store or business, try Shopify, or
  manage a Shopify store — even if they do not say "Shopify": "I want to sell
  candles online", "help me start an online business", "open my first store",
  "add products", "check my orders", "set inventory", "make a discount",
  "show my sales", "how did my Shopify Email campaigns do". Before connection it can
  show relevant mock.shop sample catalogs, suggest business names, check
  domains, search shopify.dev, and validate GraphQL. The connect flow can create
  an account and store for a new user. Do the work here rather than only listing
  setup steps. Keywords: Shopify MCP, ecommerce, sample products, demo store,
  starter catalog, ShopifyQL, first store, create product.
metadata: { "includeInPrompt": false }
---

# Shopify

The installed `shopify` command wraps Shopify's official MCP server. It is not
the Shopify CLI from npm; the agent-facing commands are below. Tool names and
schemas come from `shopify list-tools`, never from memory — other Shopify
connectors expose tools this one does not.

```text
shopify status
shopify authorize-url
shopify disconnect
shopify list-tools
shopify call-tool --name <tool-name> --arguments-json '<JSON object>'
```

Do not invoke `exchange-code`; the OAuth callback flow owns that command.

## Start here: no store needed

Start from what the user brings, and offer the other relevant options:

- Browse sample stores for their kind of business with
  `find-mock-shop-catalogs`.
- Brainstorm a business name with `generate-business-names`.
- Check domains with `generate-domain-names`.

These tools, `search_docs_chunks`, and `validate_graphql_codeblocks` work before
a store is connected. Do not ask someone to connect merely to explore them.

## Connecting

1. `shopify status`. If a store is connected, go straight to work.
2. Otherwise, once they want a store of their own or ask for something that
   needs one, run `shopify authorize-url` and share **only** the returned
   `connect_url` with the user. Nothing else in that response is for them.
3. When they say they're done, `shopify status`, then
   `call-tool --name get-shop-info` to confirm which store is connected.

Every other usable tool, including catalog import, needs a store.
`shopify disconnect` deletes the stored connection; run it only when asked.

## Sample catalogs

mock.shop catalogs are source sample stores with realistic products and
collections. Their live storefronts are view-only examples, not previews of
how the connected destination store will look. When someone is starting a
store, offer relevant catalogs before asking them to connect:

1. Call `find-mock-shop-catalogs` with what they sell, in their own words. If
   they have not said, ask that one question first.
2. Present the best matches with their descriptions, product and collection
   counts, currency, and `storefrontUrl`. Clearly label each link as the source
   sample storefront. Explain that they can browse it, then return and choose
   one for import; there is no import action on the sample storefront itself.
   If nothing matches, ask them to describe the business another way.
3. Once connected, confirm before calling `import-mock-shop-catalog` with the
   selected `subdomain`.
4. Verify the destination records with `search_products` and
   `search_collections`, then report created, reused, skipped, unpublished, or
   partial results and any currency mismatch.

An import copies the first two collections and up to eight products from each,
at most sixteen products, and publishes newly imported records to the Online
Store. Repeating the same import is safe: it fills missing records and
memberships without overwriting previously imported products or merchant edits.
If Shopify reports `partial: true`, wait briefly and repeat the same import.
These are sample records to edit or replace before launch, not supplier stock.
For one or two placeholders, use `create-product`. If the mock.shop tools are
missing from `list-tools` or repeatedly unavailable, say so and offer to create
products directly instead.

## Users without a store

The same `connect_url` works for someone who has never used Shopify. Shopify's
sign-in page lets them create an account and a new store, then returns them to
the connection. Tell them this up front so they don't go create a store
separately first. Once connected, offer a first-store sequence and take it one
step at a time:

1. `get-shop-info` to learn the store's name, currency, and plan.
2. Import the sample catalog they selected, or use `create-product` for their
   own products (title, description, price, images by URL). Ask what they sell;
   don't invent a catalogue.
3. `create-collection`, then `add-to-collection` to group them.
4. If they track stock, call `get-inventory-levels` before `set-inventory` to
   resolve the inventory item, location, and current quantity.
5. `create-discount` for a launch promotion, only if they want one.

Business-name and domain results may include `signupUrl` links. Do not share
them: they start a separate signup that does not return to this chat. Give names
and domains as plain text. When the user is ready to create or connect a store,
share the connector's `connect_url`; they can use the chosen name during setup
and buy a chosen domain from Shopify Admin after the store exists.

Themes, checkout, payments, and connecting or buying domains require Shopify
Admin (the domain from `get-shop-info`). For another store task without a
dedicated tool, try Admin GraphQL before sending the user to the admin.

## Common tasks

| Task | Tools |
| --- | --- |
| Store details | `get-shop-info` |
| Business names and available domains | `generate-business-names`, `generate-domain-names` |
| Sample catalogs | `find-mock-shop-catalogs`, then `import-mock-shop-catalog` with the selected `subdomain`; this imports catalog data, not storefront design |
| Products | `search_products`, `get-product`, `create-product`, `update-product`, `bulk-update-product-status` |
| Collections | `search_collections`, `get-collection`, `create-collection`, `update-collection`, `add-to-collection` |
| Inventory | `get-inventory-levels`, `set-inventory` |
| Orders and customers | `list-orders`, `get-order`, `list-customers` |
| Discounts | `create-discount` |
| Reports and trends | `run-analytics-query` (ShopifyQL; the description has examples) |
| Anything else in Admin, or a dedicated tool that is missing or insufficient | `graphql_schema` → `validate_graphql_codeblocks` → `graphql_query` or `graphql_mutation`, in that order, every time |
| How Shopify works | `search_docs_chunks` |
| Another store | `switch-shop`, then `get-shop-info` |

### Shopify Email reporting

For per-campaign Shopify Email performance, use `run-analytics-query` on
`marketing_engagements`. Unless the user specifies another range or metric,
start with:

```text
FROM marketing_engagements SHOW engagements_sends, engagements_clicks, engagements_unique_clicks, engagements_impressions, engagements_fails, engagements_complaints, engagements_unsubscribes GROUP BY marketing_activity_title, marketing_activity_channel SINCE -90d UNTIL today ORDER BY engagements_sends DESC
```

Run a user-provided query verbatim. A successful result with `rowCount: 0`
means no campaigns matched the range, not a failure. Report only email-channel
rows unless the user asks for other channels.

## Rules

- Authenticated commands refresh an expired access token automatically. Do not
  tell the user to disconnect and reconnect for ordinary expiry. If Shopify
  reports that the refresh grant was revoked or reauthorization is required,
  run `shopify authorize-url`; do not require a disconnect first unless the
  returned result explicitly says it is necessary.
- Inspect the returned result as well as the command status: Shopify can report
  a tool-level failure inside a successful MCP response.
- If a dedicated tool is absent or lacks a needed field or operation, try Admin
  GraphQL before saying the task cannot be done. Follow the schema, validation,
  and query or mutation sequence above. A timeout or lost response after a write
  leaves its outcome unknown; check with a read tool such as `search_products`
  before repeating it. If the outcome cannot be confirmed, report that and do
  not retry. Fix validation or user errors and retry only an operation Shopify
  rejected before applying. The documented catalog-import safe-repeat behavior
  remains the sole exception. If the schema or server safety policy does not
  permit the operation, point the user to Shopify Admin.
- Confirm with the user before any tool that writes: create, update, set,
  bulk, discounts, catalog import, `graphql_mutation`. Catalog
  import publishes sample products and collections to the Online Store; report
  partial imports and currency mismatches (prices are copied without conversion).
- A catalog import does not change the store name, theme, navigation, homepage
  sections, or pre-existing products. The `storefrontUrl` returned by
  `find-mock-shop-catalogs` previews the source mock catalog, not the destination
  store after import. Never say the destination storefront will look like that
  preview or offer its homepage as proof. After importing, verify the new records
  with `search_products` and `search_collections`, then report that the merchant
  must configure their theme in Shopify Admin if they want the homepage to feature
  the imported catalog.
- `switch-shop` must be followed by another tool call (the requested action,
  or `get-shop-info`) to finish the switch.
- Muse shows structured data, not Shopify's widgets. Summarize results in
  the reply; don't refer to a card, chart, or preview the user can't see.
