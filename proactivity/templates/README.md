# HTML widget inspiration

This library supplies starting points after you have chosen an HTML card for a useful outcome. Adapt a reference to that work and the user. Use `widget.create_list_widget` for flight offers and `travel.create_hotel_results_widget` for hotel offers to compare or select bookings. A booked flight’s status, a restaurant reservation and an existing hotel stay need a summary of the arrangement, not a new booking flow.

Tools: `widget.create_html_widget` and `widget.create_html_file_widget`.

## Choose a starting point

Read the relevant index and the closest HTML reference. Borrow its useful structure and adapt it freely to the user and the work. If nothing fits, read a few examples for inspiration and make a bespoke widget. The catalog is not a limit on what Muse can prepare.

| Category and reference count | Absolute index path | What they help present |
| --- | --- | --- |
| Email (20 variants) | `/opt/muse/assets/proactivity/templates/email/README.md` | Replies, introductions, attachments, translations and recipient review |
| Calendar (20 variants) | `/opt/muse/assets/proactivity/templates/calendar/README.md` | Events, guests, preparation, changed plans and timezones |
| Weather (20 variants) | `/opt/muse/assets/proactivity/templates/weather/README.md` | Current conditions, hourly outlooks and weather that affects a plan |
| Flight status (20 variants) | `/opt/muse/assets/proactivity/templates/flight/README.md` | Booked flights, delays, connections, arrivals and pickup timing |
| Hotel (Reservation) | `/opt/muse/assets/proactivity/templates/hotel/README.md` | Property photo, stay dates, room and arrival details |
| Restaurant (Reservation) | `/opt/muse/assets/proactivity/templates/restaurant/README.md` | Venue photo, date, time, party size and arrival details |
| Events and outings (Outing) | `/opt/muse/assets/proactivity/templates/event/README.md` | A fitting event, its venue, admission and arrival details |
| Deliveries and pickups (Order status) | `/opt/muse/assets/proactivity/templates/delivery/README.md` | Confirmed milestones, arrival estimates and pickup details |
| Payments and renewals (Payment status) | `/opt/muse/assets/proactivity/templates/payment/README.md` | Amount, date and the distinction between due, scheduled and paid |
| Job opportunities (Prepared opportunity) | `/opt/muse/assets/proactivity/templates/job/README.md` | Role, terms, fit and application material ready to use |
| Progress (Before and after) | `/opt/muse/assets/proactivity/templates/progress/README.md` | Comparable measurements with dates and units |
| Learning (Ready exercise) | `/opt/muse/assets/proactivity/templates/learning/README.md` | A complete practice activity, hint and answer |

`/opt/muse/assets/proactivity/templates/catalog.json` lists each reference and when it fits. The original [email](email.md), [calendar](calendar.md), [weather](weather.md) and [flight](travel.md) guides explain the foundation of those designs.

## Reply choices

Use `muse.create_options` for useful replies outside the HTML card. Keep the card for displaying the result, without action buttons. Read **Offer useful replies** and **Deliver the finished work** in `/opt/muse/assets/proactivity/presentation.md`. The brief introduction and optional choices precede the standalone card. Keep the result useful without requiring a reply.

## Make it fit

Use a clear visual hierarchy, a deliberate palette and recognizable icons. Let the layout carry information without long explanations or decorative clutter. Preserve light and dark mode support when adapting a reference, with deliberate background, surface, text, border and accent colors in each. Inspect the rendered result in both modes at a narrow chat width. Check contrast, visible controls and long content. Keep essential facts visible, let names and addresses wrap, and bound long bodies and lists with keyboard-accessible scrolling.

Replace every `[[FIELD]]` with grounded content and escape text and attribute values for HTML. Remove unused fields and adjust icons to match actual data. Use the user’s language, date conventions and established taste. Preserve the real state of the work. A preview is not a sent email, a saved event or a completed booking. Follow the tool’s current authoring and delivery rules.

The installed library at `/opt/muse/assets/proactivity/templates/` is read-only and refreshes with deployments. Read current references each run, then save adapted HTML in this run’s directory under `workspace/proactivity`. Existing prepared widgets retain their stored content. Reuse their exact IDs and embed tokens only while the content remains valid. For changing facts, selection supplies the sources and design brief, and delivery refreshes the facts and creates the card just before presenting it. Preserve the source’s observation or update time and the actual check time when they differ, with their timezones. A fresh read does not make old source data current. A delivered HTML card does not keep updating when the user opens it later.

## Typography

Keep card typography close to the conversation. Use the host’s Optimistic font when supplied, with the native system sans-serif stack as the fallback. A widget iframe does not inherit the surrounding app’s custom font automatically. Do not fetch a different font just to style a card.

The references use the web client’s type scale with explicit fallbacks: body text at 16px/22px, longer copy at 16px/26px, compact details at 14px/20px, footnotes at 13px/18px and short labels at 12px/16px. Card headings use 18px/26px. Email subjects stay at body size and gain emphasis from weight, not scale. Larger type belongs to a useful number such as a temperature, date or amount. Preserve the host’s font and text-size settings when available, and let content wrap instead of shrinking text to fit.

## Location links

Show the confirmed place and address in the card. HTML widgets cannot open outbound links. Deliver a native map with `widget.create_map_widget` when pins, nearby choices or a route help, or put a labelled location link in the accompanying chat message. Do not draw a link or navigation button inside the HTML.

Research and selection must preserve the destination, exact place text and a short link label in the preparation notes and handoff. Prefer the Google Maps, Apple Maps or verified venue-location URL already supplied by the source email, calendar entry or reservation. Never guess a venue website. Without a source location link, use `https://www.google.com/maps/search/?api=1&query=` followed by the URL-encoded confirmed name and address. Label it as a map search, not a verified pin. Do not invent an entrance, terminal or physical address.

Use the same delivery path for verified meeting, tracking, event, employer and account links. Keep them distinct from location links. For an online meeting, preserve the actual joining URL and share it in chat. Do not map an online-only event to a physical place or use scripts to bypass widget navigation restrictions.
