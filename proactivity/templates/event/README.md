# Events and outings

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Use [outing.html](outing.html) for a useful event, performance or outing, with its date, venue and admission details.

Keep discovery, a possible plan and a confirmed ticket distinct. Never invent attendance, seats, a QR code, a barcode or a reservation. Use `widget.create_list_widget` for supported event comparisons, `widget.create_agenda_widget` for several events and `widget.create_map_widget` when location helps. A card is useful only when this event fits the user, not just because an event exists. Show a real poster or venue photo only when sourced and allowed by the HTML tool. Preserve ticket attachments separately.

Read the [library guide](../README.md), then adapt the closest reference. If this layout does not fit, borrow its useful patterns and make a bespoke widget. Keep the user’s language and date conventions, replace all placeholders with verified content and HTML-escape text and attribute values. Remove empty fields. Keep essential facts visible and secondary details expandable. Follow the tool’s current authoring rules and preserve exact presentation references.

Show the confirmed venue name and address. Carry its source location link and the event or ticket link separately in the handoff. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Installed references: `/opt/muse/assets/proactivity/templates/event/`.
