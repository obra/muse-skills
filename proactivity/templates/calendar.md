# Calendar event

Tools: `widget.create_agenda_widget` for a plan. `widget.create_html_widget` for one event.

Give a single event a clear date tile, time and place. Use `widget.create_agenda_widget` for a day, week or itinerary. Show the actual local date and timezone. Distinguish a proposal from a saved event, and a pending reservation from a confirmed one. Give each invitee a named chip, with initials grounded in that person’s name. Chips wrap, and a long guest list scrolls within its own keyboard-accessible region. Do not imply an invitation was sent or accepted unless verified. Include only preparation that helps the user arrive ready.

Show the exact confirmed place in the card. Follow the [location-link guidance](README.md#location-links) and use `widget.create_map_widget` or an ordinary chat link beside it. Carry verified destinations in the handoff rather than putting outbound links inside the HTML.

## Example

Treat this as design inspiration. Adapt its composition to the content and the user. Replace every `[[FIELD]]` with grounded content, escape text for HTML and remove unused fields. Follow the widget tool’s authoring rules.

```html
<style>
.muse-event, .muse-event * { box-sizing: border-box; }
  .muse-event { min-width: 0; max-width: 100%; font-family: var(--font-optimistic, system-ui), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: var(--text-body, 16px); line-height: var(--text-body--line-height, 22px); color: var(--hatch-widget-text); overflow-wrap: anywhere; }
  .muse-event h3, .muse-event p { margin: 0; }

  .muse-event { --event-accent: #986238; --event-wash: #f8ede1; --event-line: #e7c7a4; --hatch-widget-surface: #fffaf2; --hatch-widget-border: #e9ddcd; --hatch-widget-text: #493422; --hatch-widget-muted: #7b6853; background: var(--hatch-widget-surface); border: 1px solid var(--hatch-widget-border); border-radius: 22px; overflow: hidden; box-shadow: 0 5px 18px var(--hatch-widget-shadow, transparent); }
  html[data-theme="dark"] .muse-event { --event-accent: #e5bd8f; --event-wash: #362c25; --event-line: #80603b; --hatch-widget-surface: #2e251f; --hatch-widget-border: #574737; --hatch-widget-text: #faeddd; --hatch-widget-muted: #ceb89b; }
  .muse-event .event-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 22px 0; font-size: var(--text-caption-1, 12px); letter-spacing: 1.2px; text-transform: uppercase; color: var(--event-accent); line-height: var(--text-caption-1--line-height, 16px); }
  .muse-event .event-state { text-transform: none; letter-spacing: 0; color: var(--hatch-widget-muted); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-event .event-hero { display: grid; grid-template-columns: 66px minmax(0,1fr); gap: 17px; padding: 22px; align-items: center; }
  .muse-event .event-date { border: 1px solid var(--event-line); border-radius: 12px; text-align: center; overflow: hidden; background: var(--event-wash); color: var(--event-accent); }
  .muse-event .event-month { display: block; padding: 4px 2px; border-bottom: 1px solid var(--event-line); font-size: var(--text-caption-1, 12px); font-weight: 600; letter-spacing: 1px; text-transform: uppercase; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-event .event-day { display: block; font-size: var(--text-title-1, 30px); font-weight: 400; letter-spacing: -.01em; line-height: var(--text-title-1--line-height, 34px); padding: 3px 2px; }
  .muse-event h3 { font-size: var(--text-title-3, 18px); letter-spacing: -.01em; line-height: var(--text-title-3--line-height, 26px); font-weight: 600; }
  .muse-event .event-weekday { display: block; font-size: var(--text-subheadline, 14px); color: var(--hatch-widget-muted); margin-top: 6px; line-height: var(--text-subheadline--line-height, 20px); }
  .muse-event .event-details { margin: 0 22px; padding: 16px 0; border-top: 1px solid var(--hatch-widget-border); border-bottom: 1px solid var(--hatch-widget-border); display: grid; gap: 13px; }
  .muse-event .event-row { display: flex; align-items: flex-start; gap: 11px; font-size: var(--text-subheadline, 14px); line-height: var(--text-subheadline--line-height, 20px); }
  .muse-event svg { width: 17px; height: 17px; flex: none; margin-top: 2px; color: var(--event-accent); }
  .muse-event .event-row small { display: block; color: var(--hatch-widget-muted); font-size: var(--text-footnote, 13px); margin-top: 2px; line-height: var(--text-footnote--line-height, 18px); }
  .muse-event .event-guests { padding: 15px 22px 17px; }
  .muse-event .event-guests-label { display: block; font-size: var(--text-caption-1, 12px); color: var(--hatch-widget-muted); margin-bottom: 8px; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-event .event-chips { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px; list-style: none; margin: 0; padding: 0; max-height: 100px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--hatch-widget-border) transparent; }
  .muse-event .event-chips:focus-visible { outline: 2px solid var(--hatch-widget-focus); outline-offset: 3px; border-radius: 6px; }
  .muse-event .event-chips li { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 3px 8px 3px 3px; border: 1px solid var(--hatch-widget-border); border-radius: 16px; font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-event .event-chips .initial { width: 20px; height: 20px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--event-wash); color: var(--event-accent); font-size: var(--text-caption-1, 12px); font-weight: 600; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-event .event-chips .name { min-width: 0; overflow-wrap: anywhere; }
  .muse-event footer { padding: 12px 22px; background: var(--event-wash); color: var(--event-accent); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }


</style>
<article class="muse-preview muse-event" aria-label="Event preview">
  <header class="event-top"><span>[[EVENT_CATEGORY]]</span><span class="event-state">[[PROPOSED_OR_SAVED_STATUS]]</span></header>
  <section class="event-hero"><div class="event-date"><span class="event-month">[[MONTH]]</span><span class="event-day">[[DAY]]</span></div><div><h3>[[EVENT_TITLE]]</h3><span class="event-weekday">[[WEEKDAY_AND_YEAR]]</span></div></section>
  <div class="event-details">
    <div class="event-row"><svg class="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div>[[LOCAL_TIME_RANGE]]<small>[[TIMEZONE]]</small></div></div>
    <div class="event-row"><svg class="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><div>[[PLACE]]<small>[[PLACE_DETAIL]]</small></div></div>
  </div>
  <div class="event-guests"><span class="event-guests-label">Guests</span><ul class="event-chips" tabindex="0" aria-label="Guest list">
    <li><span class="initial" aria-hidden="true">[[ATTENDEE_ONE_INITIAL]]</span><span class="name">[[ATTENDEE_ONE_NAME]]</span></li>
    <li><span class="initial" aria-hidden="true">[[ATTENDEE_TWO_INITIAL]]</span><span class="name">[[ATTENDEE_TWO_NAME]]</span></li>
    <li><span class="initial" aria-hidden="true">[[ATTENDEE_THREE_INITIAL]]</span><span class="name">[[ATTENDEE_THREE_NAME]]</span></li>
    <li><span class="initial" aria-hidden="true">[[ATTENDEE_FOUR_INITIAL]]</span><span class="name">[[ATTENDEE_FOUR_NAME]]</span></li>
  </ul></div>
  <footer>[[USEFUL_PREPARATION]]</footer>
</article>
```
