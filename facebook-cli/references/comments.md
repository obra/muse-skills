# Facebook Comments

Read comments and add approved text comments or replies on Facebook posts.

## Command

```bash
facebook-cli post comments read --post-id <post-id> [--limit <n>] [--after <cursor>]
```

**Options:**
- `--post-id` (required): Post ID to read comments from
- `--limit` (optional): Maximum number of comments per page (max 20; higher values are capped server-side)
- `--after` (optional): Pagination cursor — pass the `paging.cursors.after` value from the previous response to fetch the next page

## Response Fields

The response is cursor-paginated:
- `data`: Array of comment objects, each with:
  - `id`: Comment ID
  - `author_name`: Name of the comment author
  - `text`: Comment text content
  - `created_time`: Unix timestamp of when the comment was created
  - `reply_count`: Number of replies to this comment
  - `comment_url`: Direct Facebook URL to this specific comment. Use this when the user wants to see or share a particular comment.
- `summary.post_url`: Permalink to the original post on Facebook. Always present — use this to link the user back to the post. (This moved from the old top-level `post_url` into `summary` when the endpoint became paginated.)
- `paging.cursors.after`: Opaque cursor for the next page. **Present only when more comments exist** — its absence means you've reached the end. Pass it back via `--after` to continue.

When presenting comments to the user, always include `summary.post_url` so they can navigate to the original post, and mention that each comment has a direct `comment_url` link. To gather more than one page, follow `paging.cursors.after` with `--after` until it's absent.

## Operating Rules

1. When presenting comments, always include `summary.post_url` for the parent post and `comment_url` for each comment. Never show raw comment IDs or post IDs — always use the URLs.
2. When the user asks about "recent" or "latest" comments, always state the date range you used in your response (e.g., "Here are comments from the past 7 days").
3. When organizing comments across multiple posts, present them grouped per post with clear separation.
4. Include timestamps (`created_time`) for comments when presenting them.
5. When cross-referencing commenters across posts, accurately identify only people who appear in multiple threads. Do not fabricate commenter names.

## Adding a comment or reply

```bash
facebook-cli post comments add --post-id <post-id> --text 'Exact comment text'
facebook-cli post comments add --post-id <post-id> --parent-comment-id <comment-id> --text 'Exact reply text'
```

Read the target with `post read` before commenting, even when an ID is given.
Decode share links first. Before replying, read the comments and use the
identified parent comment ID. Reuse successful reads from this request.
The post accepts numeric IDs or PFBIDs; the parent comment must be numeric.
Text must be nonblank. The complete target and
text appear in native approval before the single write attempt.

A successful receipt completes the request: return its `comment_url` as a
clickable link. Never repeat the write to obtain a link, verify success, or
handle a later confirmation of the same request. An uncertain outcome needs
read-only inspection. Editing and deletion are unavailable.
