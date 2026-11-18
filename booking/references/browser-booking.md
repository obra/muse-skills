# Book through a website

- Use a website when it offers a suitable option or a better way to finish the booking. Airlines, hotels, venues, agencies and booking platforms can differ in inventory, total price, terms and benefits.

- Use an existing authorized session when one is available. Offer sign-in when it can unlock or verify member pricing, credits, points or saved details. Continue as a guest when that meets the need, and never require a new account.

- On an airline's website, a flight booked while signed in to the traveler's account carries their loyalty number. Sign in when they have an account with that airline and a saved sign-in exists or they agree to sign in. A traveler who books as a guest can type their number into the traveler details during a takeover, since membership numbers stay out of task text.

- When a task may sign in to an airline, hotel, car rental or travel booking site, ask it to keep the session by ticking "Keep me signed in" or "Stay signed in" when the sign-in form offers it.

- "Remember this device" and "Trust this browser" also let a site skip its one-time code next time, which changes the account's security settings. When you offer a sign-in to one of these travel sites, ask in the same message whether it may remember Muse's browser, and tell the task to tick these options only on sites the user agreed to.

- Follow [checkout](checkout.md) for the final refresh, worse terms, approval, an uncertain result and confirmation.

## Research offers

- Give a research task started with `browser.browse` and `task_id: "new"` the exact dates, party with ages, room or seats, and the terms that matter. Ask it to return the complete offer, current total, terms, seller URL and time checked, without starting a checkout or holding inventory.

## Run one checkout

- Continue the browser task that found the selected option. Use `task_id: "new"` only when none exists. Keep that task through review, changes, submission and verification; do not start a competing checkout or start over after approval.

- Give the task the exact seller URL and every known non-sensitive choice. When the booking takes payment or requires a card guarantee, follow `~/docs/chat/payments-and-purchases.md` for approval and ask it to book. Otherwise, ask it to prepare the booking, hand back the verified final review and stop before anything that creates a reservation, charge, deposit, points transfer or cancellation penalty. It may place a free, cancellable hold that protects this booking. Tell the user about the hold and its expiry right away.

- Keep passport, traveler-security and membership numbers out of task text. Use Wallet or browser takeover for card details, following `~/docs/chat/payments-and-purchases.md`; do not forward card numbers or CVVs from chat.

## Handle website snags

- Give custom date and party pickers the exact values in words.

- On a seat map, report the exact section, row, seat numbers and any obstructed-view note.

- Treat totals shown before the final review as provisional. If a hold expires before approval, refresh the inventory and terms.

- Use the supported sign-in or one-time-code path. Never bypass a site's controls.

- A site the browser cannot get past counts as blocked automation. The browser's bot-challenge specialist can solve CAPTCHAs and bot checks, so do not treat encountering one as blocked automation.

- If automation is blocked, try another authorized seller, a call when the phone tools are available, or a precise handoff with the exact link, the choices already made and what remains. A difficult checkout never justifies a different date, venue, property, seat, room, rate or price.
