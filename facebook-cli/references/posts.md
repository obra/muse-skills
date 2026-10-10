# Facebook Posts

## Creating a personal text post

```bash
facebook-cli post create --message 'Exact post text'
facebook-cli post audiences
facebook-cli post create --message 'Exact post text' --privacy 'RETURNED_AUDIENCE_ID_OR_NAME'
facebook-cli post crossposting [--privacy 'RETURNED_AUDIENCE_ID_OR_NAME']
```

Omit `--privacy` to use the current Facebook composer default. The native
approval shows the linked profile, the exact text, audience and any sharing
destinations. Do not ask a separate audience question or infer the default.
For an explicit audience request, refresh `post audiences` and pass a returned
ID or exact name. Only me, Friends and Public are supported when returned.
Custom audiences and per-person inclusions or exclusions are unsupported.
If the default is unsupported or the requested choice is absent or ambiguous,
ask the user to choose an available audience; never substitute another choice.

Text must be nonblank. This command supports
personal text posts; media attachments, group posting, editing and deletion
are unavailable. Preserve the exact approved text.

Sharing follows the account settings unless the user requests a per-post
change. Pass `--share-to-story`, `--share-to-instagram` or `--share-to-threads`
with `on` or `off` in the first creation command. Keep existing overrides when
the user requests a revised approval. An unavailable destination fails before
approval; relay the reason. Do not add media to work around a text-only limit.
`post crossposting` reports `auto_share` for account-setting questions;
`eligible` describes whether this content and audience can be shared, not
whether the account setting is enabled. Account settings change in Accounts
Center, not through these flags.

Return the successful receipt's `post_url`. Do not publish again to verify it.
If transport or the receipt fails, the post may exist: inspect readback and
report the outcome as unconfirmed. Never retry with another audience or a test
post. An explicit audience rejection means no post was created; refresh the
choices once and obtain a fresh approval for any user-chosen alternative.

## Reading a Post

```bash
facebook-cli post read --post-id <post-id>
facebook-cli post read --url '<canonical-facebook-url>'
```

Supply exactly one nonblank `--post-id` or `--url`. IDs may be numeric or bare
PFBIDs. Output uses the normalized `social_posts_v1` format with the post's text,
permalink, and available media context.

## Reading from a Facebook URL

Resolve Facebook share wrappers such as `/share/<token>/` or
`/share/p/<token>/` before reading the content:

```bash
facebook-cli link-sharing decode-url \
  --url 'https://www.facebook.com/share/p/<share-token>/'
```

The response includes `original_url`. If it is null, missing, or blank, report
that the link could not be resolved and stop. Do not use the share token as an ID.
A decoded URL identifies the content type; it does not confirm that content is
available to the account. The post reader does not decode share links itself.

For an already canonical URL, skip decoding. Pass the complete supplied URL or
decoded `original_url` to `post read --url` for these HTTP(S) URL patterns on
`facebook.com`, `www.facebook.com`, `m.facebook.com`, `mbasic.facebook.com`,
`web.facebook.com`, or `touch.facebook.com`:

| Content | Canonical URL patterns |
| --- | --- |
| Post | `/<profile>/posts/<post-id>` or `/posts/<post-id>` |
| Group post | `/groups/<group>/posts/<post-id>` or `/groups/<group>/permalink/<post-id>` |
| Post permalink | `/story.php?story_fbid=<post-id>` or `/permalink.php?story_fbid=<post-id>` |
| Photo | `/photo.php?fbid=<id>` or `/photo/?fbid=<id>` |
| Video or reel | `/reel/<id>`, `/videos/<id>`, or `/<profile>/videos/<id>` |
| Video query URL | `/watch/?v=<id>` or `/video.php?v=<id>` |

```bash
facebook-cli post read --url '<original_url-from-decoder>'
```

Keep the URL intact, including its query parameters; do not extract an ID or
make a separate media-resolution request. The reader resolves supported
photo/video URLs to their containing post.
Standalone media may have no containing post. A failed read stops the chain:
report the failure without guessing an ID, retrying the media ID as a post ID,
or claiming that the content is readable from the URL alone.

Malformed or unsupported URLs, including undecoded share links, return HTTP 400.
Supported URLs whose media or post is missing, private, or unreadable return
HTTP 404. Neither result provides post content.

### Other Entities

Route other entities to their own readers:

- `/groups/<group-id>`: use `groups posts --group-id <group-id>` to browse posts.
  If the group path contains a name instead of an ID, use `groups search` first.
- `/marketplace/item/<listing-id>`: use `marketplace listing details --url '<decoded-url>'` with the full URL intact.
- Event, game, and unrecognized URLs: report that this URL type is unsupported. Do not
  pass an arbitrary number from the URL to `post read`.

## Browsing a Profile's Timeline

To view recent posts for a profile, use `timeline fetch`:

```bash
facebook-cli timeline fetch --profile-id <profile-id>
```

## Reading Comments or Reactions

```bash
facebook-cli post comments read --post-id <post-id>
facebook-cli post reactions read --post-id <post-id>
```

## Operating Rules

1. When presenting normalized post, feed, or timeline results, include `post_caption` and `url` when present. A feed caption that matches `header_text`, or a caption derived from `media_summary`, is descriptive provider text rather than the author's quoted words. Do not fabricate links or text when these fields are absent.
2. Include the owner's name only when the user isn't asking about a specific person (e.g., browsing a feed). Omit it when the context already makes the author obvious.
3. When summarizing what someone has been up to, ground every claim in a specific post. Do not fabricate or infer activities that are not evidenced by an actual post.
4. Use normalized `media_summary`, `media_ocr`, or `video_transcript` fields when present to provide media context.
5. Media fields are pre-computed and may not be available for all posts. Never claim a post contains specific media content unless one of those fields confirms it.
6. Facebook video and reel posts may also carry shopping context: `shoppable_products` (a list of detected products, each with `product_name` and optional `descriptive_name`, `category`, `item_type`, `brand_name`, `color`, `style`, `gender`, `prominence`), `shoppability`, and `shoppable_product_category`. Use them to answer questions about what is shown or sold in a video instead of inferring products from the caption or transcript. They are absent on posts with no shopping content understanding, and on list endpoints (`profile posts`, `feed`) — only `post read` returns them.
7. For general Reel shopping, `post read --out <file>` also retrieves a set of similar products. They are recommendations, not creator-tagged products or confirmed identifications of what appears in the video. The CLI prints compact candidate attributes and a contract: `featured_products_status=available` means `<file>` was written as a resolver-ready catalog; `ordered_featured_product_ids` lists the candidates in ranking order.
8. Only in the general featured-products path, after resolving applicable requirements, use the CLI status: when it is `available`, pass `<file>` and every ordered ID unchanged to `shopping.resolve_results`, as directed by the Shopping Skill. The CLI summary is sufficient; you do not need to read `<file>`. When the status is `unavailable`, the IDs are empty and no resolver catalog was written: do not pass the output path. Follow the Shopping Skill's standard Product discovery fallback.
9. Follow the Shopping Skill's preference and required-attribute rules. Explicit current instructions override conflicting saved requirements; soft preferences alone do not change the default flow. Requests explicitly limited to shown products only filter those results. Before reading a Reel, collect only constraints already known to apply. Read without `--out` for a named product/category or an established constraint; otherwise use `--out`. After this read, resolve category-dependent requirements using the returned context. A named product/category or any applicable hard requirement requires fresh standard Product discovery, even if featured candidates match; reuse this context without repeating `post read` or filtering featured products. Search requested targets, or otherwise `shoppable_products`, with all applicable constraints; ask if neither supplies a target. For either discovery path, an explicit catalog-only request means using only catalog search and skipping browser product search. Render products through the trusted resolver; do not describe the internal contract in the response.
