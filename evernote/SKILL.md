---
name: "evernote"
description: "Search and manage notes, notebooks, Spaces, tags, tasks and attachments through Evernote's official MCP server."
metadata: { "includeInPrompt": false }
---

# Evernote

Use the installed `evernote` CLI. Start with `evernote status`. If it reports
`not_connected`, run `evernote authorize-url` and share only the returned
`connect_url` with the user.

Run `evernote list-tools` to discover the tools available for the connected
account and their argument schemas, then call an advertised tool with:

```text
evernote call-tool --name <tool> --arguments-json '<json-object>'
```

`search_tasks` is for individual accounts; `search_assigned_tasks` is for
Business accounts. `delete_note` moves a note to the trash; `restore_note`
restores it. `delete_task` removes a task. Send task date-time arguments in UTC
with a `Z` suffix; the provider can reject numeric timezone offsets.

## Attachments

- Download with `get_attachment` and `--output <local-path>`.
- Upload with `start_attachment_upload` and `--input <local-file>`. Include
  `noteId`, the file's lowercase MD5 `hash` and exact `sizeBytes` in the
  provider arguments, following the live schema from `list-tools`. The CLI transfers the file.
- Only after upload succeeds, register the attachment with `finalize_attachment`, using the same
  `noteId`, `hash` and `sizeBytes`, plus the file's real `mimeType` and optional
  filename from its live schema.
- Only after finalization succeeds, use `edit_note` to insert an `<en-media hash="..." type="..." />`
  fragment with the matching hash and MIME type, using `mode: "append"` to
  preserve existing content and place it at the end.
- If upload or finalization fails, stop this workflow; do not insert an
  `<en-media>` reference or attempt download. Re-read the note to inspect its state.
- Re-read the note to verify the attachment before reporting success.

Check both the CLI exit status and the provider result for errors, including
`isError: true`; an outer `ok: true` does not guarantee provider success.
When wrapping CLI calls in a shell, preserve their exit status.

After a failed or timed-out write, verify the provider state before retrying;
its side effect may have completed.
