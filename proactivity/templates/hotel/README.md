# Hotel booking

Tool: `widget.create_html_widget` or `widget.create_html_file_widget`.

Use [confirmed-reservation.html](confirmed-reservation.html) for an existing hotel reservation. Lead with the actual property or venue, confirmed dates and booking state. This is a reservation summary, not a search result or proof that Muse made the booking. Use `travel.create_hotel_results_widget` when comparing bookable hotel offers. Do not create a booking or imply a requested change succeeded just to complete the card.

Read the [library guide](../README.md), then adapt this reference to the user and the useful details. It is inspiration, not a fixed form. Remove empty or irrelevant fields. Use the user's language and date conventions. Include the year when dates could be ambiguous and preserve local timezones. Keep confirmation numbers inside the details section unless they matter immediately. Do not invent room, seating, policy, access or check-in details.

Use a verified photo of this exact hotel from its official website or account. Check that it depicts the correct place. Never generate a replacement photograph. Widget HTML accepts a stable public image URL. A signed Instagram or other expiring URL must not appear in the card. If the only useful photo has an expiring URL, download and inspect it, retain the file and hand off its exact sandbox attachment for delivery beside the card. Remove the photo element when no suitable header image is available. Follow the tool's image rules and retain the source link in the preparation notes.

Replace every `[[FIELD]]` with grounded content and HTML-escape text and attribute values. Keep essential information visible, with secondary details expandable and long lists keyboard-scrollable. Keep verified external URLs in the handoff for delivery as ordinary chat links. Follow the tool's current schema and delivery instructions.

Show the exact hotel and street address. Carry the location link from the booking confirmation and the verified property website separately in the handoff. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Installed references: `/opt/muse/assets/proactivity/templates/hotel/`.
