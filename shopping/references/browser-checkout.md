# Browser Checkout

Use browser checkout when the Purchase workflow sends a product through its
product page. Follow Purchasing Flow for item choices, shipping, payment, final
review, and confirmation. Follow Payments & Wallet for wallet setup and saved
payment methods.

## Start the browser task

Call `browser.spawn_task` with the product URLs and every choice already made
for this purchase:

```json
{
  "task": "Open <exact product URLs> and prepare the purchase of <items>. Use these choices: <variants, quantities, delivery details, payment choice, and other requirements>. Ask only for missing required choices. Report the final items, shipping, total, and payment setup before submitting. Follow Purchasing Flow for confirmation."
}
```

Include a payment choice, a Stripe Link refusal, or a checkout failure when one
has already occurred. Do not include card details in the initial task.

## Add catalog route information

Some products returned by `shopping product-details` include a
`hatch_telemetry_context`. For those products, add `shopping_checkout` to the
browser task. Copy each product's complete `hatch_telemetry_context` into
`products` without changing it. This information records why browser checkout
was used. It does not change the checkout.

Set `stage` and `reason` from the situation that started the browser task:

| Situation | `stage` | `reason` |
|---|---|---|
| Agentic checkout creation was unavailable, and `checkout create` was not called | `checkout_start` | `agentic_creation_ineligible` |
| The user chose browser checkout before `checkout create` was called | `checkout_start` | `user_selected_browser` |
| Shop Pay must finish in the browser | `payment_lane` | `shop_pay_selected` |
| `checkout create` failed | `agentic_fallback` | `agentic_create_failed` |
| The user chose browser checkout after `checkout create` | `agentic_fallback` | `user_selected_browser` |
| The selected provider requires browser checkout | `agentic_fallback` | `provider_requires_browser` |
| Agentic checkout completion was unavailable | `agentic_fallback` | `agentic_completion_ineligible` |
| The browser must collect required buyer details | `agentic_fallback` | `buyer_details_required` |
| Stripe Link was unavailable for agentic completion | `agentic_fallback` | `stripe_link_unavailable` |

Do not add `shopping_checkout` for a product found only by the browser.

Example:

```json
{
  "task": "<self-contained browser checkout task>",
  "shopping_checkout": {
    "products": [<complete hatch_telemetry_context for each catalog product>],
    "stage": "checkout_start",
    "reason": "agentic_creation_ineligible"
  }
}
```

## Continue the purchase

Follow the acknowledgment returned by `browser.spawn_task`. When the browser
task requests information or reports the purchase review, follow Purchasing
Flow and Payments & Wallet. Continue the same task with `browser.steer_task`.

If the user selects Shop Pay, call `wallet.list_payment_methods` and pass the
selected card's exact `payment_method_id` and masked label to the browser task.
Do not derive the ID from the label. If the Shop Pay approval returns a
different `approved_card`, report that masked card as the card used.

For multiple purchases, run browser tasks in parallel only on different sites.
Two checkouts on one site share the same cart.
