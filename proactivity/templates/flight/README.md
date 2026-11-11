# Flight layouts

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Twenty HTML starting points. Read this index, choose the closest layout, then read that file and adapt it. Change structure, color, spacing and copy when the user or content calls for it. Do not load all twenty.

Use `widget.create_list_widget` for flight booking offers, with its required flight data. These layouts describe booked flights and verified flight updates.

Each file is a self-contained widget fragment. Replace and HTML-escape text and attribute placeholders. Keep verified external URLs in the handoff for delivery as ordinary chat links. Remove unused optional fields and repeated rows. Never invent data to fill a design. Keep local dates and timezones at both ends. Route progress needs actual flight data or an explicitly labelled estimate. Remove it for cancellations and situations where it would mislead. Grounded transfers, pickups and replacement bookings are different from proposals.

Show the exact origin and destination airports. Carry their source location links and any verified pickup link in the handoff. An airport-wide map pin does not identify a particular gate, terminal or pickup door. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Use the current files under `/opt/muse/assets/proactivity/templates/flight/`. Deployments replace these references. Write the adapted result in the current run’s workspace, leaving this read-only library untouched. Reuse a prepared widget’s exact durable ID and embed token only while its content remains valid. For changing facts, selection supplies the original sources, fields to refresh and this reference path. Delivery checks the current state and creates the card just before presenting it. A saved token preserves content, not freshness. Preserve the source’s observation or update time and the actual check time when they differ, with their timezones. A fresh read does not make old source data current.

| Layout | Choose it for | Required context |
| --- | --- | --- |
| [Pre departure](pre-departure.html) | A scheduled flight with route, duration and local times. | Grounded content and the actual current state. |
| [Checkin window](checkin-window.html) | A verified check-in window needs attention. | Airline-specific dates and deadlines. Do not claim the user is checked in. |
| [Boarding status](boarding-status.html) | Verified boarding information is useful now. | Actual boarding state and gate information, not a guess from departure time. |
| [Gate change](gate-change.html) | The airline changed the gate. | Both gate values and the source update time. |
| [Terminal transfer](terminal-transfer.html) | A connection needs a terminal transfer. | Verified terminals and grounded transfer instructions. |
| [Departure delay](departure-delay.html) | A confirmed delay changes the departure plan. | Scheduled and current estimated times with date and timezone. |
| [Cancelled flight](cancelled-flight.html) | A flight has been confirmed cancelled. | Verified cancellation. Do not imply a replacement is booked. |
| [In flight](in-flight.html) | Actual departure and an arrival estimate support progress. | Actual departure, expected arrival and labelled estimate basis. Never fake live location. |
| [Arrival update](arrival-update.html) | An updated arrival estimate affects an onward plan. | Current arrival estimate and relevant onward context. |
| [Landed](landed.html) | The flight has actually landed. | Confirmed landing. Landing does not prove arrival at gate. |
| [Tight connection](tight-connection.html) | A connection window needs careful comparison. | Both flights, correct dates and airports, and a calculated connection window. |
| [Missed connection](missed-connection.html) | A connection is confirmed missed. | Evidence the connection was missed and any actual airline arrangement. |
| [Multi leg itinerary](multi-leg-itinerary.html) | Several booked legs should be read in order. | Every booked leg with local dates and timezones. Remove unused legs. |
| [Overnight flight](overnight-flight.html) | Departure and arrival are on different local dates. | Correct date rollover, including international date-line crossings. |
| [Timezone comparison](timezone-comparison.html) | Clock changes could make the timing confusing. | Date-specific offsets and a correctly calculated elapsed duration. |
| [Codeshare](codeshare.html) | The booked and operating flight identities differ. | Both confirmed identifiers. Do not suggest these are different flights. |
| [Diverted flight](diverted-flight.html) | A confirmed diversion changes the destination. | An actual diversion and verified destination, not a routing guess. |
| [Rebooked flight](rebooked-flight.html) | A replacement flight has been confirmed booked. | A confirmed booking. Use `widget.create_list_widget` for unbooked flight offers. |
| [Baggage arrival](baggage-arrival.html) | Verified baggage information helps after landing. | Actual claim or baggage status. Do not infer bags are ready from landing. |
| [Pickup coordination](pickup-coordination.html) | Arrival information supports an agreed pickup. | A real pickup plan and current arrival information. |
