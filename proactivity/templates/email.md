# Email draft

Tools: `widget.create_html_widget` or `widget.create_html_file_widget`. Use `muse.create_options` outside the card for real send or edit choices.

A compact compose sheet. Show visible address chips in labelled From, To, Cc and Bcc rows, followed by a distinct subject field and scrollable message body. To, Cc and Bcc are optional. Omit each entire row when it has no recipients. Keep the subject at a compact reading size, distinct from the body without treating it as a headline. Repeat chips for multiple recipients and keep the exact address readable. Address rows wrap and scroll when needed. Long subjects wrap without hiding words. The status must describe what actually exists, such as a draft prepared in Muse, a saved mailbox draft or a sent message. Do not draw pretend send buttons.

Keep From visible even when the user has one account. It identifies the sending account and distinguishes the user’s mailbox from Muse Mail. Follow `Email` at `/opt/muse/skills/email-management/SKILL.md` for account choice. Replies stay with the receiving account and thread. For new correspondence, an existing Muse Mail mailbox can be offered when useful, with the actual address shown. Do not silently switch accounts. For `Muse Mail`, follow `/opt/hatch/connectors/muse_mail/CONNECTOR.md` and the mail worker’s approval flow and show a chat draft only when requested.

Borrow the user’s provider cues when known, such as Gmail’s rounded compose sheet or Outlook’s tighter typography. Preserve Muse’s identity and the user’s theme. Use initials only when grounded in the recipient’s name. Keep the message body keyboard-scrollable. Its bounded height keeps a long draft from taking over the chat.

## Example

Treat this as design inspiration. Adapt its composition to the content and the user. Replace every `[[FIELD]]` with grounded content, escape text for HTML and remove unused fields. Follow the widget tool’s authoring rules.

```html
<style>
.muse-mail, .muse-mail * { box-sizing: border-box; }
  .muse-mail { min-width: 0; max-width: 100%; font-family: var(--font-optimistic, system-ui), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: var(--text-body, 16px); line-height: var(--text-body--line-height, 22px); color: var(--hatch-widget-text); overflow-wrap: anywhere; }
  .muse-mail h3, .muse-mail p { margin: 0; }

  .muse-mail { --mail-accent: #315c9e; --mail-tint: #dce9ff; --hatch-widget-text: #193452; --hatch-widget-muted: #56708e; --hatch-widget-border: #cfdcf0; --hatch-widget-surface: #f3f7ff; --hatch-widget-surface-muted: #e7effc; --mail-paper: #ffffff; --mail-header: #dce9ff; --mail-header-text: #234f87; --mail-chip: #e3edfc; --mail-cc: #e2f2eb; --mail-cc-text: #29634f; border: 1px solid var(--hatch-widget-border); border-radius: 20px; background: var(--hatch-widget-surface); overflow: hidden; box-shadow: 0 5px 18px var(--hatch-widget-shadow, transparent); }
  html[data-theme="dark"] .muse-mail { --mail-accent: #b4d2ff; --mail-tint: #315b91; --hatch-widget-text: #eaf3ff; --hatch-widget-muted: #abc2df; --hatch-widget-border: #365174; --hatch-widget-surface: #182c48; --hatch-widget-surface-muted: #213c60; --mail-paper: #102139; --mail-header: #254e82; --mail-header-text: #f0f6ff; --mail-chip: #28466f; --mail-cc: #234e4c; --mail-cc-text: #b7ede2; }
  .muse-mail .mail-bar { display: flex; align-items: center; gap: 8px; padding: 14px 20px; background: var(--mail-header); color: var(--mail-header-text); border-bottom: 1px solid var(--hatch-widget-border); font-size: var(--text-subheadline, 14px); font-weight: 600; line-height: var(--text-subheadline--line-height, 20px); }
  .muse-mail svg { width: 17px; height: 17px; flex: none; color: var(--mail-accent); }
  .muse-mail .mail-state { margin-left: auto; color: inherit; opacity: .8; font-size: var(--text-footnote, 13px); font-weight: 400; line-height: var(--text-footnote--line-height, 18px); }
  .muse-mail .mail-fields { padding: 7px 17px 0; }
  .muse-mail .mail-row { display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 6px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--hatch-widget-border); }
  .muse-mail .mail-label { color: var(--hatch-widget-muted); font-size: var(--text-caption-1, 12px); line-height: var(--text-caption-1--line-height, 16px); }
  .muse-mail .mail-chips { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; max-height: 92px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--hatch-widget-border) transparent; }
  .muse-mail .mail-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; border: 1px solid var(--hatch-widget-border); border-radius: 20px; padding: 3px 9px 3px 3px; background: var(--mail-chip); font-size: var(--text-subheadline, 14px); line-height: var(--text-subheadline--line-height, 20px); }
  .muse-mail .mail-copy .mail-chip { background: var(--mail-cc); color: var(--mail-cc-text); border-color: transparent; }
  .muse-mail .mail-avatar { width: 21px; height: 21px; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--mail-tint); color: var(--mail-accent); font-size: var(--text-caption-1, 12px); font-weight: 600; line-height: var(--text-caption-1--line-height, 16px); }
  .muse-mail .mail-subject { padding: 11px 0; display: grid; grid-template-columns: 45px minmax(0,1fr); align-items: baseline; gap: 6px; }
  .muse-mail .mail-subject h3 { margin: 0; font-size: var(--text-body, 16px); font-weight: 600; line-height: var(--text-body--line-height, 22px); letter-spacing: 0; }
  .muse-mail .mail-body { margin: 0 9px 10px; padding: 16px 12px; max-height: 185px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--hatch-widget-border) transparent; border: 1px solid var(--hatch-widget-border); border-radius: 10px; font-size: var(--text-body, 16px); line-height: var(--text-response--line-height, 26px); background: var(--mail-paper); }
  .muse-mail .mail-body p { white-space: pre-wrap; }
  .muse-mail .mail-body p + p { margin-top: 13px; }
  .muse-mail .mail-body:focus-visible, .muse-mail .mail-chips:focus-visible { outline: 2px solid var(--hatch-widget-focus); outline-offset: -2px; }
  .muse-mail footer { display: flex; align-items: center; gap: 7px; padding: 12px 22px; background: var(--hatch-widget-surface-muted); color: var(--hatch-widget-muted); font-size: var(--text-footnote, 13px); line-height: var(--text-footnote--line-height, 18px); }
  .muse-mail footer svg { width: 13px; height: 13px; color: inherit; }
</style>
<article class="muse-preview muse-mail" aria-label="Email draft">
  <header class="mail-bar"><svg class="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg><span>[[DRAFT_LOCATION]]</span><span class="mail-state">[[SEND_STATUS]]</span></header>
  <div class="mail-fields">
    <div class="mail-row"><span class="mail-label">From</span><div class="mail-chips" tabindex="0" role="group" aria-label="Email addresses"><span class="mail-chip"><span class="mail-avatar" aria-hidden="true">[[SENDER_INITIAL]]</span><span>[[SENDING_ACCOUNT]]</span></span></div></div>
    <div class="mail-row"><span class="mail-label">To</span><div class="mail-chips" tabindex="0" role="group" aria-label="Email addresses"><span class="mail-chip" title="[[RECIPIENT_NAME]]"><span class="mail-avatar" aria-hidden="true">[[RECIPIENT_INITIALS]]</span><span>[[TO]]</span></span></div></div>
    <div class="mail-row mail-copy"><span class="mail-label">Cc</span><div class="mail-chips" tabindex="0" role="group" aria-label="Email addresses"><span class="mail-chip"><span class="mail-avatar" aria-hidden="true">[[CC_INITIAL]]</span><span>[[CC]]</span></span></div></div>
    <div class="mail-row mail-copy"><span class="mail-label">Bcc</span><div class="mail-chips" tabindex="0" role="group" aria-label="Email addresses"><span class="mail-chip"><span class="mail-avatar" aria-hidden="true">[[BCC_INITIAL]]</span><span>[[BCC]]</span></span></div></div>
    <div class="mail-subject"><span class="mail-label">Subject</span><h3>[[SUBJECT]]</h3></div>
  </div>
  <section class="mail-body" tabindex="0" role="region" aria-label="Draft message body"><p>[[GREETING]]</p><p>[[BODY]]</p><p>[[SIGN_OFF]]</p></section>
  <footer><svg class="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/></svg><span>[[ATTACHMENTS_OR_REMAINING_DECISION]]</span></footer>
</article>
```
