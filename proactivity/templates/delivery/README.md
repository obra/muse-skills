# Deliveries and pickups

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Use [order-status.html](order-status.html) for an order whose current state, arrival or pickup details help the user.

Use `widget.create_html_widget` or `widget.create_html_file_widget` for the delivery timeline. Show only confirmed milestones and label estimates. Remove future steps when the delivery is complete. Separate an ordered item from one that shipped, arrived or is ready for pickup. Preserve split shipments and partial refunds. A new email is not by itself a reason to repeat an unchanged status. The card is a dated snapshot. An ongoing watch is separate and needs an actual authorized schedule.

Read the [library guide](../README.md), then adapt the closest reference. If this layout does not fit, borrow its useful patterns and make a bespoke widget. Keep the user’s language and date conventions, replace all placeholders with verified content and HTML-escape text and attribute values. Remove empty fields. Keep essential facts visible and secondary details expandable. Follow the tool’s current authoring rules and preserve exact presentation references.

For a confirmed physical pickup, show its exact place and carry its location link in the handoff. Preserve the tracking link separately. Include a private delivery address only when it helps the user. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Installed references: `/opt/muse/assets/proactivity/templates/delivery/`.
