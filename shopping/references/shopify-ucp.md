# Shopify UCP Checkout

Load this file only after the user has selected one or more Meta catalog
products from the same Shopify merchant whose
`is_agentic_checkout_creation_enabled` fields are all exactly `true`.

The catalog flags route the flow; the checkout endpoint remains authoritative.
Use every selected product's exact `product_id`, capability fields, and `url`
from its catalog data. Bundle products only when their catalog URLs clearly
identify the same merchant storefront; matching brand labels are not enough.
Never mix merchants in one checkout. Treat a missing or null capability as
`false`.

## Safety and input boundary

- `checkout create` moves no money. `checkout complete` creates the selected
  wallet spend request and places the order.
- `checkout complete` serves direct Stripe Link. It also serves direct Shop Pay
  when the checkout supports direct completion. Shop Pay uses the
  provider-approved credential and does not expose card details on this path.
  If direct completion is unavailable, use the browser route instead. On either
  browser route, the browser task places the order, so do not call `checkout
  complete`.
- Run `checkout complete` at most once for a checkout and only in the
  foreground. Never create a wallet spend request separately, background
  completion, poll it, or retry it automatically.
- A denial is the user's decision. Stop without placing an order. A later retry
  requires a new explicit user message.
- CLI inputs are JSON files with snake_case keys. Omit unknown optional fields
  and empty strings. Never carry endpoint-derived merchant, item, total, buyer,
  fulfillment, or legal-link data into completion input.

## Cart (optional)

A pre-purchase draft, never required — `checkout create` takes `items[]`
directly. Reach for one only when the basket must survive the turn: the user is
still adding or removing, or wants to come back to it later.
`shopify-ucp-cli cart --help` covers the subcommands; carry the `cart_id` from
`agent_state.cart_id` and treat it as opaque. Four things --help does not tell
you:

- `cart update` replaces the whole basket — that is how an item is removed, and
  why a partial list deletes the rest. Unsure you have every item? `cart get`
  first and rebuild from `cart.line_items[]`.
- One cart, one merchant. A cart spanning two is refused outright:
  `multiple_merchants_not_supported`, "All cart line items must belong to the
  same merchant." Start a separate cart rather than retrying.
- `cart` accepts a catalog `product_id` or the variant GID it echoes back;
  `checkout create` accepts catalog ids only. A resumed cart can be revised but
  not checked out until you search again for its catalog ids.
- Nothing links a cart to a checkout: it supplies items only. Cancel it once
  `checkout complete` returns `ok: true`, or once a browser task reports the
  order placed; nothing else closes it, and there is no way to enumerate the
  ones you left open.
- Cart, checkout, and order reads preserve provider timestamps and add semantic
  UTC and user-local forms such as `checkout_expires_at`, `order_placed_at`,
  and `order_event_occurred_at`. Do not treat an order-status message time as a
  delivery time.

## Prepare buyer details before checkout creation

Keep a payment route explicitly selected for this purchase. If none is
selected, ask with `muse.create_options` and wait. Offer the Wallet routes
supported under *Safety and input boundary*, using the provider presentation
rules in `~/docs/chat/payments-and-purchases.md`, plus `Use another method`.

When the user selects `Use another method`, treat it as browser takeover and
follow `/opt/hatch/skills/shopping/references/browser-checkout.md` from the
selected catalog product URLs. Do not create a UCP checkout first.

For a selected Wallet route, call `wallet.list_payment_methods` for its provider
and resolve one exact saved method using its result guidance. If the user
declines Wallet connection or card setup, or setup ends without a usable
method, treat that route as no longer selected and return to the route choice
above.

Before asking for a missing name, email address, or phone number, call
`wallet.get_user_info`; when a recipient name or shipping address required for
direct completion is missing, call `wallet.list_shipping_addresses`. Use Wallet
values only for matching fields that are missing. Do not tell the user they
need to provide buyer details before these Wallet lookups finish. Wallet results
may omit required fields or leave them ambiguous. After applying known, sole,
or default values, ask one grouped question for every required value that
remains missing or ambiguous.

Do not create the checkout until every buyer field required for direct
completion is present. If the user does not want to provide them, follow
`/opt/hatch/skills/shopping/references/browser-checkout.md` with the selected
Wallet. For direct UCP, the exact payment-method ID later goes only in the
trusted `checkout complete` input described here, not checkout creation.

## Create the checkout

Confirm every product, exact variant, and quantity. Include the buyer email,
recipient first and last name, and complete shipping address prepared for
direct completion in the `checkout create` request. Never guess or fabricate a
value. Checkout creation moves no money; save final purchase approval for the
completed quote.

Creation needs no payment method. The selected Wallet supplied buyer details
and determines later completion, but its provider and payment-method ID do not
enter this request.

Create one JSON file containing every selected product. Use each catalog
`product_id` as `items[].item_id`; use one entry per distinct variant and fold
repeated identical IDs into its quantity. Quantity defaults to `1`. Do not add
a merchant field: the endpoint resolves the merchant from the catalog IDs. The
endpoint requires buyer email and a checkout currency. Use the exact currency
from the selected product's latest catalog details, including `CAD` for a
CAD-priced product. If the product currency is absent, default to `USD`. Do not
infer currency from the shipping country. Every product in one checkout must
use the same currency. If their currencies differ, do not call `checkout
create`; offer browser checkout for all selected products instead. If accepted,
follow `/opt/hatch/skills/shopping/references/browser-checkout.md`. Shopify may
select a different market currency during checkout creation; handle that
authoritative response below rather than predicting the override here. Direct
native completion additionally requires a trusted recipient first and last name
and complete shipping address with street, city, state or region, postal code,
and ISO alpha-2 country. Include a phone number when it is already known; do not
ask for one before creation unless the user or merchant already made it a
requirement.

Before this call, combine buyer details already known from the conversation and
`~/USER.md` with the selected Wallet profile and shipping-address results.

```json
{
  "buyer": {
    "email": "<email>",
    "phone_number": "<phone-string>",
    "country_code": "<country-code>",
    "address": {
      "first_name": "<first-name>",
      "last_name": "<last-name>",
      "street1": "<street1>",
      "street2": "<street2>",
      "city": "<city>",
      "state": "<state>",
      "postal_code": "<postal-code>",
      "country": "<country-alpha-2>"
    }
  },
  "items": [
    {"item_id": "<product_id-1>", "quantity": 1},
    {"item_id": "<product_id-2>", "quantity": 2}
  ],
  "currency": "<catalog-currency-or-USD>"
}
```

```sh
shopify-ucp-cli checkout create --input-file "<checkout.json>" --format json
```

Put the complete item set in this initial create call. `checkout update` cannot
add or remove products. Do not use the separate `cart` commands to assemble
this checkout.

Inspect the authoritative create response before branching on the catalog
completion capability. A returned `continue_url` does not by itself require a
browser handoff because checkouts ready for direct completion may also include
one.

Read `requested_currency`, `checkout_currency`, and `currency_changed` from the
create output. A supported Shopify market-currency override is not a create
error and does not require browser fallback. When `currency_changed` is `true`,
use only the returned checkout currency and amounts for every later checkout,
wallet, budget, and approval step. Tell the user both the catalog/requested
currency and the authoritative checkout currency, explain that Shopify selected
the checkout market after seeing the shipping destination, and call out the
new item price and total. Re-evaluate any budget constraint using the
authoritative checkout amounts. If the budget is in a different currency and
no user-approved equivalent is available, explain that the amounts cannot be
compared directly and ask the user for a limit in the checkout currency before
proceeding. Do not compare amounts in different currencies as raw numbers or
invent a conversion. The user must approve the final quote in that returned
currency; never reuse a decision made for the catalog price.

If create returns an error or rejects the item, explain the result and offer
browser checkout from the original catalog `url`; do not retry automatically.
When the user accepts, follow
`/opt/hatch/skills/shopping/references/browser-checkout.md`.

Only a successful create response with a usable `.agent_state.checkout_id` may continue below. Save that checkout ID. The CLI stores the endpoint-derived checkout behind the trusted runtime boundary. Inspect `.result` without copying its trusted fields into later commands.

A response carrying `requires_escalation`, `status: "redirect"`, or a note that
buyer detail is still missing is a successful create when it returned a
checkout ID. Do not treat it as an error. Keep the route selected before
creation and follow *Route after creation*; do not ask the route question again.

Take the checkout URL now, from `.result.continue_url` or
`.result.checkout.continue_url`. Use only a value the endpoint returned. When
it is absent, fall back to one selected product's original catalog `url` from
that merchant rather than inventing one.

## Continue the selected payment route

The Wallet route and exact saved method were selected before checkout creation.
Do not ask for the route again unless the user requests a switch or the selected
method becomes unavailable. Follow *Route after creation* to decide whether
checkout continues directly or through a BrowserTask.

If the user requests another Wallet, call `wallet.list_payment_methods` for the
new provider and resolve one exact saved method using its result guidance. Keep
the existing checkout. If connection or card setup for the requested Wallet is
declined or produces no usable method, keep the checkout and ask the user to
choose another route. For `Use another method`, reuse the browser-takeover
route defined above and follow
`/opt/hatch/skills/shopping/references/browser-checkout.md` using the existing
checkout URL; do not recreate the checkout.

On escalation, redirect, or buyer details still missing at creation, say that
the browser will finish the already selected route and collect what remains.
Missing delivery options and an unsettled total are ordinary direct-checkout
work under *Refresh delivery and totals* below.

## Route after creation

For a selected wallet route, take the first branch that matches:

1. The user selected Shop Pay with an exact saved method: use direct completion
   only when every selected product's
   `is_agentic_checkout_completion_enabled` is exactly `true`, create did not
   report `requires_escalation` or `status: "redirect"`, and the checkout carries
   the required name and address. Otherwise use the browser Shop Pay route below
   with the exact connected payment method. Finish connection or setup in the
   parent first.
2. The Stripe Link route, and create reported `status: "redirect"`,
   `requires_escalation`, or messages that explicitly require buyer input or
   review: the browser, carrying Link. Take this branch regardless of
   `is_agentic_checkout_completion_enabled`.
3. The Stripe Link route, and any selected product's
   `is_agentic_checkout_completion_enabled` is not exactly `true`: the browser,
   carrying Link.
4. The Stripe Link route, and the checkout was created without the name and
   address direct completion requires: the browser, carrying Link.

Otherwise every selected product's `is_agentic_checkout_completion_enabled` is
exactly `true`, and the direct Stripe Link flow below applies.

On any browser branch, briefly acknowledge the handoff and end the response
after delegating. Do not poll the browser task. Do not call `checkout complete`
for that checkout.

### Shop Pay, in the browser

Spawn the task with the Shop Pay route and the selected method's masked label.
Do not include the opaque `payment_method_id` in `task`. The trusted checkout
tool revalidates the exact selected ID against a fresh wallet read before
creating approval.

```json
{
  "task": "<what the user asked for, in their words>. Open <exact Shopify checkout URL> for <selected products>. The user selected Shop Pay for this purchase with saved method <masked card label>. Complete the purchase using these known choices: <color/size/quantity/other variants>. Ask only for missing required purchase choices. Shipping preference: <deadline/budget/speed, or none>."
}
```

Resolve the Shop Pay connection and exact method before delegating. BrowserTask
does not call wallet tools or discuss another payment route. Follow
`/opt/hatch/skills/shopping/references/browser-checkout.md` for continuation.

### Stripe Link, in the browser

Use the exact Stripe Link method selected above, then spawn the task. Identify
the provider and saved method with the exact provider ID and masked label. Do
not include the opaque payment-method ID in `task`.

```json
{
  "task": "<what the user asked for, in their words>. Open <exact Shopify checkout URL> for <selected products>. Use provider stripe-link with saved method <masked label>. Use these known choices for every item: <color/size/quantity/other variants>. Ask only for missing required purchase choices. Continue through checkout and hand off the exact final terms before submission. Shipping preference: <deadline/budget/speed, or none>."
}
```

Follow `/opt/hatch/skills/shopping/references/browser-checkout.md` for
continuation.

### Stripe Link, completed directly

Use the exact Stripe Link method selected above, then continue with the direct
flow.

## Use the selected wallet

Reuse the selected provider and exact payment method resolved above. If the
selected method is no longer listed, do not substitute another; ask the user to
choose a current method or another route.

## Refresh delivery, discounts, and totals

If the checkout offers delivery options, select one. With more than one, if the
user stated a shipping preference (a deadline, budget, or speed) or the options
are trivially close, pick the best fit and tell the user which you chose;
otherwise present the options with their price and delivery estimate and let the
user choose. Update the trusted quote before completion:

If the checkout requires independent delivery choices for different item
groups, do not attempt direct completion; continue in the browser from the
returned checkout URL.

```json
{
  "checkout_id": "<checkout-id>",
  "selected_delivery_option_id": "<delivery-option-id>"
}
```

```sh
shopify-ucp-cli checkout update --input-file "<update.json>" --format json
```

To apply promo or coupon codes, pass the complete desired set in
`discount_codes`. Use codes the user supplied, or codes found during a deal
search the user requested. Do not invent codes or interrupt every checkout to
ask for one. Omit `discount_codes` to preserve the checkout's existing codes;
use an empty array to clear all codes. Delivery selection and discount codes
may be changed in one call:

```json
{
  "checkout_id": "<checkout-id>",
  "selected_delivery_option_id": "<delivery-option-id>",
  "discount_codes": ["<promo-code>"]
}
```

A discount-only update needs only `checkout_id` and `discount_codes`. Report
applied discounts, `result.checkout.rejected_discount_codes`, and the refreshed
total; rejected codes can be present even when `ok` is `true`. A checkout
without delivery options skips delivery selection, not a requested discount
update.

## Review and complete

Use the exact saved method selected above. If the user asks to switch methods,
follow the switch rules under *Continue the selected payment route*. Do not ask
the user to confirm a switch they just requested and do not create another
checkout.

Show the completed quote with the masked method, items, final total, and
delivery choice. Present this quote using the checkout-review instructions in
`~/docs/chat/payments-and-purchases.md`. For Stripe Link, ask for explicit
approval and wait. For Shop Pay, do not ask for a separate chat confirmation.
`checkout complete` requests the wallet approval that serves as final purchase
confirmation. A wallet connection and an earlier request to buy are not
approval for this quote. Then write
completion input containing only the trusted checkout ID, chosen wallet
provider, chosen payment-method ID, and selected delivery-option ID when one
exists:

```json
{
  "checkout_id": "<checkout-id>",
  "wallet_provider": "<stripe_link-or-shop_pay>",
  "payment_method_id": "<selected-wallet-payment-method-id>",
  "selected_delivery_option_id": "<delivery-option-id>"
}
```

Include `wallet_provider` in every completion input: use `"stripe_link"` for
Stripe Link or `"shop_pay"` for Shop Pay. For Shop Pay use the exact
instrument ID returned by `wallet.list_payment_methods`. The Shop Pay branch
keeps credentials inside trusted payment workers. The provider CLI creates the
payment approval. When the merchant supports direct Shop Pay,
the runtime adds that approval ID to the selected credential and submits it
to the merchant. If direct Shop Pay completion is unavailable, use the browser
route instead of producing card details. The runtime does not receive
a separate buyer identity token.

Omit `selected_delivery_option_id` when the checkout has no delivery selection.

```sh
shopify-ucp-cli checkout complete --input-file "<complete.json>" --format json
```

Read the top-level `ok`: `true` means the order was placed; `false` means it was
not. Never paste raw `.result` JSON or expose internal IDs, API fields, buyer
contact information, or shipping-address details. Summarize only available
user-facing fields: order status, products, merchant, final amount, delivery
estimate, and confirmation link. If completion fails after card save or reports
an unknown outcome, do not claim no order was placed and do not retry or switch
to browser checkout automatically.
