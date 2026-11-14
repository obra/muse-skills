# Connection cards

Make relationship exchanges delightful and easy to follow without overwhelming
the user with messages or detail. When an outgoing decision or incoming update
belongs in the main chat, default to an HTML widget inspired by this library.
A very short confirmation or acknowledgment can simply be plain text; do not
build a card for it. Follow the existing selection, Writing Style and Final
Response Brevity instructions first; a beautiful card is not a reason to
interrupt. Keep the accompanying message short, warm and useful. Let the card
carry the detail rather than repeating it in prose.

Start from the card below and give it the design in the index that suits the
message. These are inspiration, not fixed forms to fill. Design on top of the
most appropriate design for the content, the user's taste, and their
relationship with this person, group or Muse. Change the layout when that makes
the message clearer or more personal; never invent intimacy or details to suit
a design. Use considered type, generous space and restrained color. Keep
headings modest; use spacing and weight for hierarchy rather than oversized
type. The two Muse portraits sit side by side, sender first, and do not
overlap.

| Choose it for | Design |
| --- | --- |
| A personal note; the quiet default | `letter` |
| A meal or warm invitation | `invitation` |
| A trip, outing or shared plan | `itinerary` |
| An introduction that deserves room | `editorial` |
| A brief answer or small update | `note` |
| Work, feedback or a project update | `folio` |
| Thanks or a thoughtful gesture | `postcard` |
| A celebration or special occasion | `evening` |
| A changed plan or delicate detail | `margin` |
| A covering message for files or a Space | `dispatch` |

```html
<link rel="stylesheet" href="/opt/muse/assets/connections/cards.css">
<article class="connection-card letter" aria-label="[[CARD_LABEL]]">
  <header class="connection-header">
    <div class="muse-pair" aria-hidden="true">
      <span class="muse-portrait muse-sender"><img src="muse-portrait:own" alt=""></span>
      <span class="muse-portrait muse-recipient"><img src="muse-portrait:[[CONNECTION_ID]]" alt=""></span>
    </div>
    <div class="connection-person">
      <p class="connection-label"><span>[[DIRECTION_LABEL]]</span><span class="connection-state">[[STATE]]</span></p>
      <h3 class="connection-name">[[PERSON_NAME]]</h3>
      <p class="connection-route"><span>[[SENDER_MUSE_NAME]]</span><span class="connection-arrow" role="img" aria-label="to">→</span><span>[[RECIPIENT_MUSE_NAME]]</span></p>
    </div>
  </header>
  <section class="connection-content">
    <h4 class="connection-topic">[[TOPIC]]</h4>
    <div class="connection-message" role="region" aria-label="[[MESSAGE_LABEL]]" tabindex="0">[[MESSAGE]]</div>
  </section>
</article>
```

## Prepare the card

Use `connection.get` for the connection's names. Write each portrait as its
name and the runtime puts the picture in when the widget is created:
`muse-portrait:own` is your Muse, and `muse-portrait:` followed by the
connection ID is the other Muse. For outgoing cards, your Muse is the sender;
for incoming cards, reverse the portraits and route. Use your known Muse name.
A portrait that is unavailable shows as the neutral circle; never invent a face
or URL. For a conversation without another Muse, adapt the header to its actual
participants.

Replace and HTML-escape every `[[FIELD]]`. The state and the two labels say
whether the card is a draft awaiting the user's decision or a message that was
received. For outgoing, identify the intended recipient. For incoming, show who
actually spoke: use the person's name for their own words and their Muse's name
for a Muse-authored message, with the person's name as context where needed.
Choose concise labels and direction wording in the user's language.
Keep incoming cards brief too. When a verbatim relay was requested, preserve the
supplied message exactly. Otherwise write a concise, delightful account that
keeps the substance, qualifications and any question or next step. Never add
facts, feelings or intent the source did not express. Label a paraphrase as a
summary, not someone's exact words. A private worker report is not an incoming
quotation; read the original exchange when needed. Do not dump the whole report
into a card or repeat its contents in the accompanying chat message.

Read outgoing text and attachments with `connection.get_message`. Show the complete
proposed text with its meaningful line breaks; a draft is not a sent message.
Keep internal review details out of the card. Put the short decision and your
recommendation in the accompanying message.

Keep the stylesheet link as the card's first line; the runtime replaces it with
the shared CSS when the widget is created. Add your own `<style>` after it when
a design needs changing. Use `widget.create_html_widget` with `fallback_text` of
at most 120 characters. Preserve light/dark themes, readable contrast,
phone-width wrapping and the scrollable full message. Cap the message area's
height (280px here, 220px on phones) so long content scrolls within the card
while the header stays visible.
Keep all verbatim or proposed text accessible; never truncate it to fit. If
widgets are unavailable, use plain text.

## Native previews and choices

Use the card, native file/image/Space previews, or both. Keep attachments
**outside** the HTML, in the chat response:

- For a file or image, put `![description](sandbox://workspace/path/to/file)` on
  its own plain line. Use the actual supplied reference and check that the file
  exists. Put each attachment on a separate line, without bullets, numbering or
  commas. Any preceding sentence must stand alone and end with a period.
  To mention a file inline, use `[name](sandbox://workspace/path/to/file)`;
  do not expose a bare path.
- For a Space, put the supplied native card marker, such as
  `[[hatch_widget:...]]`, unchanged on its own line. Do not construct a marker
  or URL from a Space slug. If only a link is supplied, use that exact link.
  Describe the access the share grants, not just its preview.

Do not invent paths, Space URLs or screenshots, or put `sandbox://` references
or native card markers in HTML. An attachment-led message can use its native
preview with a brief sender/recipient and topic instead of a text card. When
both matter, show the text card then native previews, without duplicate content.

For an outgoing decision, follow the complete proposal with **one**
`muse.create_options` widget offering to send, leave unsent or suggest edits.
Use concise labels in the user's language, covering the text and all
attachments. Embed returned tokens unchanged. There are no action buttons in
the card. Interpret the user's reply
in context and follow `connection.authorize_response`; existing clear permission
does not need another confirmation. Incoming updates do not need send choices
just to receive them. Use choices only when there is a real decision to make.
