# Weather for a plan

Tool: `widget.create_html_widget`. Check the forecast with `browser.search`, using its weather results when available.

Lead with the place, temperature and a large weather symbol. Let a short daily strip show the outlook, then add one useful consequence for the actual plan. Use the user’s units. Label a trip high as a trip high, not a current temperature.

The example’s clouds, rain and sun must match the forecast. Choose or draw the right `currentColor` SVG for each day and remove unavailable days or measures. Do not invent a forecast, hourly curve or live state for visual effect. The sky wash is decorative. Include the source and local check time in the quiet footer.

Show the exact confirmed place in the card. Follow the [location-link guidance](README.md#location-links) and use `widget.create_map_widget` or an ordinary chat link beside it. Carry verified destinations in the handoff rather than putting outbound links inside the HTML.

## Example

Treat this as design inspiration. Adapt its composition to the content and the user. Replace every `[[FIELD]]` with grounded content, escape text for HTML and remove unused fields. Follow the widget tool’s authoring rules.

```html
<style>
.muse-weather, .muse-weather * { box-sizing: border-box; }
  .muse-weather { min-width: 0; max-width: 100%; font-family: var(--font-optimistic, system-ui), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: var(--text-body, 16px); line-height: var(--text-body--line-height, 22px); color: var(--hatch-widget-text); overflow-wrap: anywhere; }
  .muse-weather h3, .muse-weather p { margin: 0; }

  .muse-weather { --sky-top: #dbeaf8; --sky-bottom: #f0f6fc; --sky-text: #193953; --sky-muted: #486680; --sky-rule: #b8cddd; --sky-pane: #ffffff70; --cloud: #ffffff; --sun: #edb74f; --rain: #5499c9; border-radius: 24px; overflow: hidden; background: radial-gradient(ellipse at 100% 0%, #ffffff80, transparent 60%), linear-gradient(155deg, var(--sky-top), var(--sky-bottom)); color: var(--sky-text); border: 1px solid var(--sky-rule); box-shadow: 0 5px 18px var(--hatch-widget-shadow, transparent); }
  html[data-theme="dark"] .muse-weather { --sky-top: #193851; --sky-bottom: #101f34; --sky-text: #eff7ff; --sky-muted: #afc8df; --sky-rule: #36516b; --sky-pane: #ffffff08; --cloud: #e2edf8; --sun: #f4cf77; --rain: #82bde8; background: radial-gradient(ellipse at 100% 0%, #6b92ae2b, transparent 60%), linear-gradient(155deg, var(--sky-top), var(--sky-bottom)); }
  .muse-weather header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 20px 22px 0; }
  .muse-weather h3 { font-size: var(--text-title-3, 18px); letter-spacing: -.01em; font-weight: 600; line-height: var(--text-title-3--line-height, 26px); }
  .muse-weather .weather-dates { color: var(--sky-muted); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-weather .weather-now { display: flex; align-items: center; justify-content: space-between; padding: 12px 22px 19px; gap: 10px; }
  .muse-weather .weather-high { font-size: var(--text-lg-title-1, 48px); line-height: var(--text-lg-title-1--line-height, 52px); font-weight: 400; letter-spacing: -.01em; }
  .muse-weather .weather-high span { font-size: var(--text-title-3, 18px); vertical-align: top; line-height: var(--text-title-3--line-height, 26px); letter-spacing: -.01em; margin-left: 3px; }
  .muse-weather .weather-range { font-size: var(--text-footnote, 13px); color: var(--sky-muted); margin-top: 4px; line-height: var(--text-footnote--line-height, 18px); }
  .muse-weather .weather-icon { width: 42px; height: 42px; display: block; overflow: visible; }
  .muse-weather .weather-hero-icon { width: 108px; height: 108px; margin-right: 1px; filter: drop-shadow(0 5px 9px #0e284917); }
  .muse-weather .weather-cloud { color: var(--cloud); }
  .muse-weather .weather-sun { color: var(--sun); }
  .muse-weather .weather-rain { color: var(--rain); }
  .muse-weather .weather-strip { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); margin: 0 15px; padding: 13px 0; border: 1px solid var(--sky-rule); border-radius: 15px; background: var(--sky-pane); }
  .muse-weather .weather-day { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; min-width: 0; font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-weather .weather-day + .weather-day { border-left: 1px solid var(--sky-rule); }
  .muse-weather .weather-day .weather-temps { font-size: var(--text-subheadline, 14px); font-weight: 500; line-height: var(--text-subheadline--line-height, 20px); }
  .muse-weather .weather-day .weather-temps span { color: var(--sky-muted); font-weight: 400; margin-left: 5px; }
  .muse-weather .weather-chance { color: var(--sky-muted); font-size: var(--text-caption-1, 12px); line-height: var(--text-caption-1--line-height, 16px); }
  .muse-weather .weather-note { padding: 17px 22px 15px; font-size: var(--text-subheadline, 14px); line-height: var(--text-subheadline--line-height, 20px); }
  .muse-weather footer { padding: 0 22px 16px; color: var(--sky-muted); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }


</style>
<article class="muse-preview muse-weather" aria-label="Forecast for your plan">
  <header><h3>[[PLACE]]</h3><span class="weather-dates">[[DATE_RANGE]]</span></header>
  <section class="weather-now"><div><div class="weather-high">[[TRIP_HIGH]]°<span>[[UNIT]]</span></div><p class="weather-range">Trip high · Low [[TRIP_LOW]]°</p></div><svg class="weather-icon weather-hero-icon" viewBox="0 0 96 96" aria-hidden="true"><g transform="translate(17,-12)"><g class="weather-sun"><circle cx="48" cy="37" r="17" fill="currentColor"/><path d="M48 11V6m0 62v-5M22 37h-5m62 0h-5M30 19l-4-4m44 44-4-4M30 55l-4 4m44-44-4 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g></g><path class="weather-cloud" d="M31 65c-10 0-17-6-17-14 0-8 6-14 14-15 3-11 12-17 22-14 8 2 13 7 15 15 10-1 18 5 18 14 0 8-7 14-16 14Z" fill="currentColor"/></svg></section>
  <div class="weather-strip">
    <div class="weather-day"><span>[[DAY_ONE]]</span><svg class="weather-icon " viewBox="0 0 96 96" aria-hidden="true"><path class="weather-cloud" d="M31 65c-10 0-17-6-17-14 0-8 6-14 14-15 3-11 12-17 22-14 8 2 13 7 15 15 10-1 18 5 18 14 0 8-7 14-16 14Z" fill="currentColor"/><path class="weather-rain" d="m34 74-4 9m21-9-4 9m21-9-4 9" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg><span class="weather-chance">[[DAY_ONE_CONDITION]] · [[DAY_ONE_RAIN]]%</span><span class="weather-temps">[[DAY_ONE_HIGH]]° <span>[[DAY_ONE_LOW]]°</span></span></div>
    <div class="weather-day"><span>[[DAY_TWO]]</span><svg class="weather-icon " viewBox="0 0 96 96" aria-hidden="true"><g transform="translate(17,-12)"><g class="weather-sun"><circle cx="48" cy="37" r="17" fill="currentColor"/><path d="M48 11V6m0 62v-5M22 37h-5m62 0h-5M30 19l-4-4m44 44-4-4M30 55l-4 4m44-44-4 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g></g><path class="weather-cloud" d="M31 65c-10 0-17-6-17-14 0-8 6-14 14-15 3-11 12-17 22-14 8 2 13 7 15 15 10-1 18 5 18 14 0 8-7 14-16 14Z" fill="currentColor"/></svg><span class="weather-chance">[[DAY_TWO_CONDITION]] · [[DAY_TWO_RAIN]]%</span><span class="weather-temps">[[DAY_TWO_HIGH]]° <span>[[DAY_TWO_LOW]]°</span></span></div>
    <div class="weather-day"><span>[[DAY_THREE]]</span><svg class="weather-icon " viewBox="0 0 96 96" aria-hidden="true"><g class="weather-sun"><circle cx="48" cy="37" r="17" fill="currentColor"/><path d="M48 11V6m0 62v-5M22 37h-5m62 0h-5M30 19l-4-4m44 44-4-4M30 55l-4 4m44-44-4 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g></svg><span class="weather-chance">[[DAY_THREE_CONDITION]] · [[DAY_THREE_RAIN]]%</span><span class="weather-temps">[[DAY_THREE_HIGH]]° <span>[[DAY_THREE_LOW]]°</span></span></div>
  </div>
  <p class="weather-note">[[PRACTICAL_IMPLICATION_FOR_THE_PLAN]]</p>
  <footer>[[SOURCE]] · [[LOCAL_DATE_TIME_AND_ZONE]]</footer>
</article>
```
