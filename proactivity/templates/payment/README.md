# Payments and renewals

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Use [payment-status.html](payment-status.html) for a bill, payment, refund or renewal where the state and next step matter.

Use `widget.create_html_widget` or `widget.create_html_file_widget` for this payment summary. Distinguish due, scheduled, pending, failed and paid. An authorized or scheduled payment is not a settled one. Show currency and the relevant date, mask account numbers, and omit unknown amounts. Keep the tone calm and give one useful implication. Do not create urgency from a generic deadline or turn a receipt into a new demand to pay. Preserve verified account links in the handoff for delivery in chat. Do not put outbound links inside the HTML or reuse a suspect email link. A preview does not execute a payment.

Read the [library guide](../README.md), then adapt the closest reference. If this layout does not fit, borrow its useful patterns and make a bespoke widget. Keep the user’s language and date conventions, replace all placeholders with verified content and HTML-escape text and attribute values. Remove empty fields. Keep essential facts visible and secondary details expandable. Follow the tool’s current authoring rules and preserve exact presentation references.

Installed references: `/opt/muse/assets/proactivity/templates/payment/`.
