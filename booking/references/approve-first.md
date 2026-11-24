# Approve first, then book on the website

- Use this guide when Flight Booking or Hotel Booking sends you here: the trip or stay books on a website, the user approves the booking before the browser task, and the task books without another card. Read `~/docs/chat/browser-purchase-preapproval.md` with it for the binding, renewal and cancellation rules. Its request steps, a summary the user confirms before the card and no payment question before approval, do not apply here. The user picked an exact trip or stay at a price, so the review and the card replace them. The skill's summary of the chosen trip or stay before the traveler questions gives way to **The payment question** below.

## The payment question

- Before writing to the user, read in one step: the travel profile and saved travelers for names and loyalty programs, `credentials.list` with the site's domain for a saved login, `wallet.list_payment_methods` with `purchase: true`, and the profile's entry for how the user pays on that site.

- When no saved answer covers the site, ask once how to pay there, in one line with two options. One is to sign in to their account on the site and pay with the card saved there. The other is their Link card, named by its masked label when one is known. Name the site and add that the answer is kept for it. Put the sign-in option first when the Secure Vault holds a login for the site, or when the booking skill says signing in carries their status, and Link first otherwise. When the profile lists their program with the site, the sign-in option says in a few words that it keeps their status. Other reasons for the order, what a sign-in asks, and what the vault or wallet lacks wait until they answer or ask.

- Ask through `muse.create_options` when it is the only open question. When traveler or guest details are missing too, ask for everything in one short plain-text message, about 60 words. The trip or stay with its total takes one line, then each open question one line, with the two payment options spelled out and the saved details the booking will use named. The itinerary, terms and settled add-ons show once, in the final review. An open seat or bag choice is one more question line, with its price. The message ends with the last question, and the review and the card come once they answer. An options widget and other questions do not mix in one message.

- When Link is the way to pay and no wallet is connected, or the connected one has no usable card, say why Link is needed: the site's checkout takes a card, and Muse pays with a one-time Link card. Show the setup action the wallet tool returns in the same message, then wait. After they connect, continue the same booking from where it stopped.

- When they choose the saved card and no wallet is connected, `permissions.preapprove` cannot raise the card yet, since it needs a connected wallet even for a saved card. Book with the approval at checkout instead, and say so. Offer Link setup only for a Link booking.

- The answer is their lasting preference for that site. Go on without reporting it as saved. The travel profile workflow records how they pay on a site. The card itself stays out of the profile.

## The review and the card

- Once the facts are complete, write the final review as a message. Then call `permissions.preapprove` right after it, in the same turn, so the card arrives under the review. Do not raise the card before the review, and do not ask whether to go ahead between them.

- Call it with `connector: "browser"`. `intent` names the booking the way the skill says. One item with quantity 1 per booking. `shipping` is "No delivery, confirmation by email". `merchant_policy` names the approved site alone. `requirements` carry the fare or rate, its terms, the add-ons and the way to pay. `wallet` is `{"provider": "stripe-link"}` when they chose Link, with the `payment_method_id` of a card they named from `wallet.list_payment_methods`, and left out when they chose the saved card. `max_total` is the quoted total plus the add-ons they asked for, rounded up to the next whole unit and written with the currency's decimal places, with no buffer. Leave `expires_at` out.

## The task

- On `approved`, start the browser task in the same turn: the task that found the trip or stay, or `task_id: "new"`, with `url` the booking page the skill names and `account_hint` the saved login's account when they sign in. The assignment says that the approval is held and the task completes and confirms the booking, which way to pay with the masked card label when known, and to sign in with the saved login when they chose the saved card or when signing in puts their status on the booking. It says the task pays only on the approved site: a checkout on any other site, a total above the approved one, or a changed fare or room comes back through its question instead of being paid. It says to ask before paying another way when the chosen way is not there.

- Answer its cart review from the approved terms. A cart on another site or from another seller is a mismatch: do not answer it from the approved terms. Stop the task and tell the user what changed. Report the confirmation with the card that paid, masked.

## When it does not go through

- A denied or unanswered card stops the booking. Keep the trip or stay, ask what to change, and reuse `purchase_id` on a retry. A user who would rather approve at the site's checkout gets that: book as the skill's ordinary route describes.

- When the site's total comes out above the approved maximum or in another currency, the checkout refuses to pay (`preapproval_over_cap`) and the task reports it. Show the user the new total. When they agree, renew the approval with the same `purchase_id` and the new `max_total`, then continue the same task. Otherwise stop.
