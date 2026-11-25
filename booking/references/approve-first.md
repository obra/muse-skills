# Approve first, then book on the website

- Use this guide when Flight Booking or Hotel Booking sends you here: the trip or stay books on a website, the user approves the booking before the browser task, and the task books without another card. Read `~/docs/chat/browser-purchase-preapproval.md` with it for the binding, renewal and cancellation rules. Its request steps, a summary the user confirms before the card and no payment question before approval, do not apply here. The user picked an exact trip or stay at a price, so the review and the card replace them. The skill's summary of the chosen trip or stay before the traveler questions gives way to **The review and the card** below.

## Who approves first

- Before writing to the user, read in one step: the travel profile and saved travelers for names and loyalty programs, `credentials.list` with the site's domain for a saved login, `wallet.list_payment_methods` with `purchase: true`, and the profile's entry for how the user pays on that site.

- Approve first only when `wallet.list_payment_methods` shows Link (`stripe-link`) connected, with `purchase_preapproval_eligible: true` and a usable card. The flag is per wallet, so eligible but disconnected Link does not count, and Shop Pay does not qualify here even when eligible: airline and hotel checkouts take a card, and Shop Pay pays only on sites that accept it. Otherwise book as the skill's ordinary route describes, with the approval at checkout, and ask nothing about wallets or Link before then: the checkout offers Link setup when it needs a card.

- Ask no payment question in either case. The booking pays with a Link card: the one the profile's entry names for the site, else the card marked default, else the first usable one. When the profile's entry for the site says the card saved there, that card pays instead and `wallet` stays out of the approval.

- Sign-in is separate from payment. The task signs in with the saved login when the Secure Vault holds one for the site, or when the booking skill says signing in carries the user's status and the profile lists their program with the site. Otherwise it books as a guest.

- The review says how the booking pays, by the card's masked label, and which login it signs in with, in one line that says a reply changes either. A reply naming the card saved on the site, another wallet card or no sign-in is their lasting preference for that site. Go on without reporting it as saved. The travel profile workflow records how they pay on a site. The card itself stays out of the profile.

- When traveler or guest details are missing, ask for everything in one short plain-text message, about 60 words. The trip or stay with its total takes one line, then each open question one line, with the saved details the booking will use named. The itinerary, terms and settled add-ons show once, in the final review. An open seat or bag choice is one more question line, with its price. The message ends with the last question, and the review and the card come once they answer.

## The review and the card

- Once the facts are complete, write the final review as a message. Then call `permissions.preapprove` right after it, in the same turn, so the card arrives under the review. Do not raise the card before the review, and do not ask whether to go ahead between them.

- Call it with `connector: "browser"`. `intent` names the booking the way the skill says. One item with quantity 1 per booking. `shipping` is "No delivery, confirmation by email". `merchant_policy` names the approved site alone. `requirements` carry the fare or rate, its terms, the add-ons and the way to pay. `wallet` is `{"provider": "stripe-link"}` with the `payment_method_id` of the Link card that pays, and is left out when the card saved on the site pays. Never bind a card to a provider other than its own. `max_total` is the quoted total plus the add-ons they asked for that the site sells in the same checkout, rounded up to the next whole unit and written with the currency's decimal places, with no buffer. Leave `expires_at` out.

## The task

- On `approved`, start the browser task in the same turn: the task that found the trip or stay, or `task_id: "new"`, with `url` the booking page the skill names and `account_hint` the saved login's account when the task signs in. The assignment says that the approval is held and the task completes and confirms the booking, which way to pay with the masked card label when known, and whether to sign in with the saved login, as the review said. It says the task pays only on the approved site: a checkout on any other site, a total above the approved one, or a changed fare or room comes back through its question instead of being paid. It says to ask before paying another way when the chosen way is not there.

- Answer its cart review from the approved terms. A cart on another site or from another seller is a mismatch: do not answer it from the approved terms. Stop the task and tell the user what changed. Report the confirmation with the card that paid, masked.

## Several bookings

- Some itineraries are more than one order: separate one-way tickets, a traveler the site books alone, two sellers' sites, or seats, bags or a room upgrade the site sells only after the ticket or the reservation. Each order gets its own card, one at a time, with no payment question between them.

- The review lists every order with its total before the first card. Raise the card for the first order under it. On approval, start that order's task. When the task confirms the order, raise the next order's card right away in the same turn, under one line that names it. On approval, run the next order in a new task from its booking page, or, for add-ons to a confirmed booking, from the site's manage-booking page with the confirmation code, which may go in the task text. Each card has its own `purchase_id` and `max_total`. Raise the next card only after the previous order is confirmed: a task holds one purchase approval, and a newer one revokes the older.

- A denied or unanswered card ends the sequence there. Report what is booked and what is not, and keep the rest ready to retry.

## When it does not go through

- A denied or unanswered card stops the booking. Keep the trip or stay, ask what to change, and reuse `purchase_id` on a retry. A user who would rather approve at the site's checkout gets that: book as the skill's ordinary route describes.

- When the site's total comes out above the approved maximum or in another currency, the checkout refuses to pay (`preapproval_over_cap`) and the task reports it. Show the user the new total. When they agree, renew the approval with the same `purchase_id` and the new `max_total`, then continue the same task. Otherwise stop.
