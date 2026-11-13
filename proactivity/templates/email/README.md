# Email layouts

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Twenty HTML starting points. Read this index, choose the closest layout, then read that file and adapt it. Change structure, color, spacing and copy when the user or content calls for it. Do not load all twenty.

To, Cc and Bcc are optional. Omit each whole row when it has no recipients, including its label and empty chips. Keep the subject compact, close to body size, with a clear weight and enough room to wrap.

Use `muse.create_options` for useful send or edit replies outside the card. Preserve the connector’s required approval surface and follow **Offer useful replies** and **Deliver the finished work** in `/opt/muse/assets/proactivity/presentation.md`. Follow `Email` at `/opt/muse/skills/email-management/SKILL.md` for account choice, preserving the receiving account and thread for replies. Follow `Muse Mail` at `/opt/hatch/connectors/muse_mail/CONNECTOR.md` for Muse’s mailbox. Its drafts belong in chat only when requested.

Each file is a self-contained widget fragment. Replace and HTML-escape text and attribute placeholders. Keep verified external URLs in the handoff for delivery as ordinary chat links. Remove unused optional fields and repeated rows. Never invent data to fill a design. Keep the complete message and its meaningful line breaks. Label alternatives and translations, and make clear which text will be sent. Keep Muse’s preparation notes separate from the email body. Use the same routing and subject for both alternatives in the comparison layout, or show separate drafts when those differ.

For a plan or invitation, show the confirmed place and carry its source email or calendar location link in the handoff. Do not add a location to a draft merely to fill a card. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Use the current files under `/opt/muse/assets/proactivity/templates/email/`. Deployments replace these references. Write the adapted result in the current run’s workspace, leaving this read-only library untouched. Reuse a prepared widget’s exact durable ID and embed token only while its content remains valid. For changing facts, selection supplies the original sources, fields to refresh and this reference path. Delivery checks the current state and creates the card just before presenting it. A saved token preserves content, not freshness. Preserve the source’s observation or update time and the actual check time when they differ, with their timezones. A fresh read does not make old source data current.

| Layout | Choose it for | Required context |
| --- | --- | --- |
| [Compact reply](compact-reply.html) | A short reply that needs very little framing. | Grounded content and the actual current state. |
| [Long letter](long-letter.html) | A longer message that should read like a letter. | Grounded content and the actual current state. |
| [Quoted thread reply](quoted-thread-reply.html) | A reply whose meaning depends on one earlier passage. | The exact source passage and its sender. |
| [Question by question](question-by-question.html) | A draft organized around several questions. | The actual questions and complete answers, each paired within the draft. |
| [Availability](availability.html) | An email proposing a few specific times. | Verified availability, dates and timezone. |
| [Plan confirmation](plan-confirmation.html) | A message confirming an agreed plan. | An agreed plan. The message may still be unsent. |
| [Proposed change](proposed-change.html) | An email asking to change an existing arrangement. | The existing arrangement and the requested replacement. |
| [Introduction](introduction.html) | An introduction where both people need context. | Grounded identities and the reason for introducing them. |
| [Group coordination](group-coordination.html) | A group email with a few clear responsibilities. | Actual agreed or clearly proposed roles. |
| [Attachment packet](attachment-packet.html) | A covering email for one or more prepared files. | Files that actually exist. Deliver their real attachments separately. |
| [Review request](review-request.html) | A request to review a specific document or version. | The actual document and requested feedback. |
| [Event invitation](event-invitation.html) | A prepared invitation with event details at a glance. | Verified or explicitly proposed event details. |
| [Personal note](personal-note.html) | A warm short message with very little visual chrome. | Grounded content and the actual current state. |
| [Follow through](follow-through.html) | A ready follow-up connected to an earlier commitment. | The actual earlier commitment, without reviving settled work. |
| [Service request](service-request.html) | A request about a particular order, booking or service. | The correct service and reference. Avoid unnecessary sensitive data. |
| [Reimbursement](reimbursement.html) | A claim email with a concise expense summary. | Verified amounts, currency and supporting files. |
| [Cancellation request](cancellation-request.html) | A draft asking to cancel a specific service. | The requested effective date. A draft is not a completed cancellation. |
| [Two language draft](two-language-draft.html) | A message with a requested or useful translation. | An intentional language pair. Identify which text will be sent. |
| [Compare drafts](compare-drafts.html) | Two complete alternatives when the user needs a choice. | Two complete alternatives with the same recipients and subject. Explain their difference and use the reply controls described above for the actual choice. |
| [Recipient review](recipient-review.html) | Complex routing where exact recipients deserve emphasis. | Exact From, To, Cc and Bcc addresses. Remove empty optional rows. |
