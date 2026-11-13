# Calendar layouts

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Twenty HTML starting points. Read this index, choose the closest layout, then read that file and adapt it. Change structure, color, spacing and copy when the user or content calls for it. Do not load all twenty.

Prefer `widget.create_agenda_widget` for ordinary day or week schedules. Use these HTML layouts when a particular comparison, event or preparation detail benefits from them.

Each file is a self-contained widget fragment. Replace and HTML-escape text and attribute placeholders. Keep verified external URLs in the handoff for delivery as ordinary chat links. Remove unused optional fields and repeated rows. Never invent data to fill a design. Keep local dates, timezones and verified event state clear. For cancellations, label old details as previously scheduled. A named guest is not proof that an invitation was sent or accepted.

Show the exact confirmed venue or address in the card. Carry its source location link in the handoff. For a remote meeting, carry the verified joining URL instead and place the working join link in chat. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Use the current files under `/opt/muse/assets/proactivity/templates/calendar/`. Deployments replace these references. Write the adapted result in the current run’s workspace, leaving this read-only library untouched. Reuse a prepared widget’s exact durable ID and embed token only while its content remains valid. For changing facts, selection supplies the original sources, fields to refresh and this reference path. Delivery checks the current state and creates the card just before presenting it. A saved token preserves content, not freshness. Preserve the source’s observation or update time and the actual check time when they differ, with their timezones. A fresh read does not make old source data current.

| Layout | Choose it for | Required context |
| --- | --- | --- |
| [Event summary](event-summary.html) | One event with balanced emphasis on date, time and place. | Grounded content and the actual current state. |
| [Date led](date-led.html) | An occasion whose date is the main thing to remember. | Grounded content and the actual current state. |
| [Time led](time-led.html) | An event in a tightly scheduled day. | Grounded content and the actual current state. |
| [Location led](location-led.html) | An event where finding the place needs extra care. | Verified location and entrance details. |
| [Remote meeting](remote-meeting.html) | A remote meeting with verified joining details. | A verified HTTPS meeting URL. Do not invent credentials. |
| [Invitation review](invitation-review.html) | An invitation with a real response still needed. | The actual invitation and current response state. |
| [Guest roster](guest-roster.html) | An event with many guests or useful attendance context. | Verified response counts. Remove these facts when unavailable. |
| [Preparation checklist](preparation-checklist.html) | An event with a few useful things to prepare. | Useful preparation, not a decorative or invented checklist. |
| [Event materials](event-materials.html) | A meeting with relevant prepared documents. | Actual materials. Share their real attachments separately. |
| [Changed event](changed-event.html) | A verified change to an existing event. | Both versions. Keep the main event details current. |
| [Reschedule options](reschedule-options.html) | A few viable alternative times to choose between. | Verified availability. Use `muse.create_options` for the actual choice outside the card. Follow **Offer useful replies** and **Deliver the finished work** in `/opt/muse/assets/proactivity/presentation.md`. |
| [Overlap comparison](overlap-comparison.html) | Two events whose times genuinely conflict. | Actual event times and overlap, including timezone. |
| [Travel buffer](travel-buffer.html) | An event whose travel time affects the plan. | Grounded travel time and the intended arrival buffer. |
| [Timezones](timezones.html) | An event involving people in different timezones. | The same instant converted with the correct dates and offsets. |
| [Overnight event](overnight-event.html) | An event that ends on a different local date. | Explicit start and end dates, not just clock times. |
| [Multiday event](multiday-event.html) | A single event spanning several days. | One multi-day event and its actual milestones. |
| [All day event](all-day-event.html) | An all-day event without invented clock times. | A source event marked all-day. Preserve its date semantics. |
| [Recurring occurrence](recurring-occurrence.html) | One occurrence that needs its series context. | The actual recurrence and any exception for this occurrence. |
| [Tentative hold](tentative-hold.html) | A tentative slot with one unresolved decision. | A real tentative hold. Keep proposed and saved state explicit. |
| [Cancelled event](cancelled-event.html) | A confirmed cancellation with useful next steps. | Verified cancellation. Never present the old event as upcoming. |
