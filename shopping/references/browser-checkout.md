# Browser Checkout

Use browser checkout when the Purchase workflow sends a purchase through a
product or checkout page. Use this reference to start and continue the
BrowserTask.

## Start the browser task

Call `browser.spawn_task` with the exact product or checkout URLs and every
choice already made for this purchase:

```json
{
  "task": "Purchase <items> from <exact product or checkout URLs>. Use these choices: <variants, quantities, delivery details, payment choice, and other requirements>. Ask only for missing required item or checkout choices. Continue through checkout and hand off the exact final terms before submission."
}
```

When a wallet route is selected, include its exact provider ID. When a saved
method is also selected, include its masked label. Do not include the opaque
payment-method ID in `task`. Include a payment refusal or checkout failure when
one already occurred. When no route is selected, omit one. The runtime adds
checkout-supported providers to the BrowserTask handoff.
Do not ask the BrowserTask to infer providers from checkout buttons. When the
user selects Link with a condition such as "if it is there" or "if available",
pass `stripe-link` as the selected provider. Do not turn that condition into a
requirement for a merchant Link button. Browser checkout permits `Use another
method` through browser takeover. Present that choice with the other eligible
routes. When the user selected it,
state that they will enter payment during browser takeover. Do not include card
details.

## Continue the purchase

Follow the acknowledgment returned by `browser.spawn_task`. Continue the same
task with `browser.steer_task`. Do not replace it with a new task during wallet
setup or confirmation.
