# Flight status

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`.

Use a compact flight slip with a strong route, local times and a quiet status. Include a route line with an airplane marker and total duration. For a scheduled flight, set progress to 0 and label it as scheduled. Show a filled progress segment and remaining time only from verified flight data or a clearly labelled estimate based on actual departure and expected arrival. Never imply live aircraft location from a schedule. Restrict the progress value to 0–100%. Duration must come from the source or correctly account for both local dates and timezones. Label times as scheduled, estimated or actual. Each end needs its own date and timezone. Show gate and terminal only when known. The footer identifies the source and check time. Do not add a barcode, boarding claim or invented airline branding.

Show the exact confirmed place in the card. Follow the [location-link guidance](README.md#location-links) and use `widget.create_map_widget` or an ordinary chat link beside it. Carry verified destinations in the handoff rather than putting outbound links inside the HTML.

## Example

Treat this as design inspiration. Adapt its composition to the content and the user. Replace every `[[FIELD]]` with grounded content, escape text for HTML and remove unused fields. Follow the widget tool’s authoring rules.

```html
<style>
.muse-flight, .muse-flight * { box-sizing: border-box; }
  .muse-flight { min-width: 0; max-width: 100%; font-family: var(--font-optimistic, system-ui), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: var(--text-body, 16px); line-height: var(--text-body--line-height, 22px); color: var(--hatch-widget-text); overflow-wrap: anywhere; }
  .muse-flight h3, .muse-flight p { margin: 0; }

  .muse-flight { --flight-accent: #446b61; --flight-wash: #dceee7; --hatch-widget-surface: #f6fbf8; --hatch-widget-border: #cbdfd5; --hatch-widget-text: #183e32; --hatch-widget-muted: #557569; background: var(--hatch-widget-surface); border: 1px solid var(--hatch-widget-border); border-radius: 22px; overflow: hidden; box-shadow: 0 5px 18px var(--hatch-widget-shadow, transparent); }
  html[data-theme="dark"] .muse-flight { --flight-accent: #a1c6b7; --flight-wash: #254b40; --hatch-widget-surface: #182f29; --hatch-widget-border: #385a4f; --hatch-widget-text: #e5f5ed; --hatch-widget-muted: #a8c9ba; }
  .muse-flight .flight-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 7px 12px; padding: 16px 21px; border-bottom: 1px solid var(--hatch-widget-border); }
  .muse-flight .flight-name { font-size: var(--text-footnote, 13px); font-weight: 600; line-height: var(--text-footnote--line-height, 18px); }
  .muse-flight .flight-state { background: var(--flight-wash); color: var(--flight-accent); border-radius: 20px; padding: 3px 8px; font-size: var(--text-caption-1, 12px); line-height: var(--text-caption-1--line-height, 16px); }
  .muse-flight .flight-route { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); padding: 20px 22px 0; align-items: center; gap: 5px; }
  .muse-flight .flight-route h3 { font-size: var(--text-title-1, 30px); line-height: var(--text-title-1--line-height, 34px); font-weight: 500; letter-spacing: -.01em; }
  .muse-flight .flight-city { font-size: var(--text-footnote, 13px); color: var(--hatch-widget-muted); margin-top: 3px; line-height: var(--text-footnote--line-height, 18px); }
  .muse-flight .flight-destination { text-align: right; }
  .muse-flight .flight-journey { padding: 19px 22px 17px; }
  .muse-flight .flight-track { position: relative; height: 2px; background: var(--hatch-widget-border); margin: 7px 11px 15px; }
  .muse-flight .flight-track:before { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--flight-progress); background: var(--flight-accent); }
  .muse-flight .flight-node { position: absolute; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--hatch-widget-surface); border: 1px solid var(--flight-accent); }
  .muse-flight .flight-node:first-child { left: 0; }
  .muse-flight .flight-node:nth-child(2) { right: 0; }
  .muse-flight .flight-plane { width: 26px; height: 24px; position: absolute; left: var(--flight-progress); top: 1px; transform: translate(-50%,-50%); background: var(--hatch-widget-surface); color: var(--flight-accent); padding: 2px; }
  .muse-flight .flight-duration { color: var(--hatch-widget-muted); font-size: var(--text-footnote, 13px); text-align: center; line-height: var(--text-footnote--line-height, 18px); }
  .muse-flight .flight-times { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; padding: 0 22px 22px; }
  .muse-flight .flight-times > div:last-child { text-align: right; }
  .muse-flight .flight-time { font-size: var(--text-title-2, 24px); font-weight: 400; line-height: var(--text-title-2--line-height, 29px); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .muse-flight .flight-kind { font-size: var(--text-caption-1, 12px); color: var(--hatch-widget-muted); margin-top: 4px; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-flight .flight-local { font-size: var(--text-caption-1, 12px); color: var(--hatch-widget-muted); margin-top: 2px; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-flight .flight-stub { padding: 15px 22px; border-top: 1px dashed var(--hatch-widget-border); background: var(--flight-wash); color: var(--flight-accent); display: flex; align-items: center; gap: 9px; font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-flight .flight-stub svg { width: 15px; height: 15px; flex: none; }
  .muse-flight footer { padding: 12px 22px; color: var(--hatch-widget-muted); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }


</style>
<article class="muse-preview muse-flight" aria-label="Flight status">
  <header class="flight-bar"><span class="flight-name">[[OPERATING_AIRLINE_FLIGHT_AND_DATE]]</span><span class="flight-state">[[VERIFIED_STATUS]]</span></header>
  <section class="flight-route"><div><h3>[[ORIGIN_AIRPORT]]</h3><p class="flight-city">[[ORIGIN_CITY]]</p></div><div class="flight-destination"><h3>[[DESTINATION_AIRPORT]]</h3><p class="flight-city">[[DESTINATION_CITY]]</p></div></section>
  <div class="flight-journey"><div class="flight-track" style="--flight-progress: [[PROGRESS_PERCENT]]%;" aria-hidden="true"><span class="flight-node"></span><span class="flight-node"></span><svg class="flight-plane" viewBox="0 0 24 24" fill="currentColor"><path transform="rotate(90 12 12)" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5Z"/></svg></div><p class="flight-duration">[[DURATION_AND_PROGRESS_LABEL]]</p></div>
  <div class="flight-times"><div><div class="flight-time">[[DEPARTURE_TIME]]</div><p class="flight-kind">[[DEPARTURE_TIME_KIND]]</p><p class="flight-local">[[DEPARTURE_LOCAL_DATE_AND_ZONE]]</p></div><div><div class="flight-time">[[ARRIVAL_TIME]]</div><p class="flight-kind">[[ARRIVAL_TIME_KIND]]</p><p class="flight-local">[[ARRIVAL_LOCAL_DATE_AND_ZONE]]</p></div></div>
  <div class="flight-stub"><svg class="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>[[VERIFIED_GATE_TERMINAL_OR_CONNECTION_DETAIL]]</span></div>
  <footer>[[SOURCE]] · [[LOCAL_DATE_TIME_AND_ZONE]]</footer>
</article>
```
