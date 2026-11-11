# Weather layouts

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Twenty HTML starting points. Read this index, choose the closest layout, then read that file and adapt it. Change structure, color, spacing and copy when the user or content calls for it. Do not load all twenty.

Check the forecast with `browser.search`, using its weather results when available, then render it with `widget.create_html_widget` or `widget.create_html_file_widget`. Keep observations, forecasts and planning advice distinct.

Each file is a self-contained widget fragment. Replace and HTML-escape text and attribute placeholders. Keep verified external URLs in the handoff for delivery as ordinary chat links. Remove unused optional fields and repeated rows. Never invent data to fill a design. Set every `*_ICON` placeholder to one of `sun`, `partly-cloudy`, `cloud`, `rain`, `snow`, `wind`, `fog` or `storm`, according to the corresponding source condition. These values select inline SVGs, not remote images. Use the closest honest symbol, or remove it if none fits. Never derive the forecast from the illustration. Keep observations, forecast times, units and source times explicit. Adapt weekend day labels to the user’s calendar.

Show the exact forecast location. Carry each relevant stop’s location link and the forecast source separately in the handoff. Follow the [location-link guidance](../README.md#location-links) and deliver links through `widget.create_map_widget` or an ordinary chat message, never an inert HTML control.

Use the current files under `/opt/muse/assets/proactivity/templates/weather/`. Deployments replace these references. Write the adapted result in the current run’s workspace, leaving this read-only library untouched. Reuse a prepared widget’s exact durable ID and embed token only while its content remains valid. For changing facts, selection supplies the original sources, fields to refresh and this reference path. Delivery checks the current state and creates the card just before presenting it. A saved token preserves content, not freshness. Preserve the source’s observation or update time and the actual check time when they differ, with their timezones. A fresh read does not make old source data current.

| Layout | Choose it for | Required context |
| --- | --- | --- |
| [Current conditions](current-conditions.html) | A current observation for a place that matters now. | A current observation and its observation time, not a forecast high. |
| [Hourly outlook](hourly-outlook.html) | A short forecast around a useful time window. | Actual hourly forecast values and matching condition symbols. |
| [Daily outlook](daily-outlook.html) | Several days of forecast at a glance. | Grounded content and the actual current state. |
| [Weekend window](weekend-window.html) | Choosing a useful window across the weekend. | Forecast-backed windows and the user’s actual weekend days. |
| [Outdoor event](outdoor-event.html) | Weather at the time and place of a real event. | Forecast coverage for the actual event location and time. |
| [Departure arrival](departure-arrival.html) | Comparing origin and destination conditions. | Forecasts for each place at the relevant local time. |
| [Multi stop trip](multi-stop-trip.html) | Different weather needs along a multi-stop trip. | Each stop, date and local forecast. Use an itinerary Space for the wider plan. |
| [Rain window](rain-window.html) | Rain timing matters more than the daily high. | Hourly precipitation data. A chance of rain is not a rainfall amount. |
| [Hot day](hot-day.html) | Heat changes the practical plan. | Relevant sourced heat measures. Avoid inventing heat alerts. |
| [Cold morning](cold-morning.html) | A cold start followed by a different afternoon. | Forecast temperatures and conditions for both windows. |
| [Snow day](snow-day.html) | Snow timing affects an actual plan. | Sourced snowfall amount and any claimed travel impact. |
| [Wind window](wind-window.html) | Wind or gusts affect the activity. | Wind units, gusts and the forecast window. |
| [Air quality](air-quality.html) | A sourced air-quality observation is relevant. | The named index scale, source category and observation time. |
| [UV day](uv-day.html) | Sun exposure is relevant to an outdoor plan. | Actual forecast UV and the relevant hours. |
| [Official alert](official-alert.html) | An official alert applies to the user’s place and time. | An actual official alert. Preserve its scope, severity and instruction. |
| [Daylight window](daylight-window.html) | Daylight determines when an activity fits. | Sunrise and sunset for the location and date, with timezone. |
| [Walking window](walking-window.html) | A few forecast windows offer a useful choice. | Actual forecast conditions for the suggested windows. |
| [Packing outlook](packing-outlook.html) | A trip forecast has a few practical packing implications. | Ground each suggestion in the trip, conditions and what the user owns. |
| [Coastal day](coastal-day.html) | Weather and sourced coastal conditions affect the outing. | Sourced marine or tide data. Ordinary weather is not proof of safe conditions. |
| [Forecast change](forecast-change.html) | A meaningful forecast change affects an existing plan. | The earlier and latest source readings with their times. |
