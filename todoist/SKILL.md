---
name: "todoist"
description: "Read and manage Todoist tasks, projects, comments, labels, filters, and reminders through Todoist's official MCP server."
metadata: { "includeInPrompt": false }
---

# Todoist

Use the installed `todoist` CLI. Start with `todoist status`. If it reports
`not_connected`, run `todoist authorize-url` and share only the returned
`connect_url` with the user.

OAuth uses one shared public client and PKCE through authd. No client secret
enters Muse, and credentials must never be requested in chat.

The first connection requests read-only Todoist access. Before every write or
deletion, run `todoist status --for-command <permission>` with the permission
matching the requested action. This check is required even when `todoist
list-tools` advertises the provider tool: the catalogue describes available
operations, not the scopes granted to the current connection.

- `tasks.create` to add tasks;
- `tasks.manage` to update, complete, reschedule, assign, or manage reminders;
- `projects.manage` to create or change projects and sections;
- `comments.manage` to add or update comments;
- `labels.manage` to add or update labels and filters;
- `items.delete` to delete tasks or other non-project objects;
- `projects.delete` to delete projects.

When the status returns `scope_status: not_granted`, copy its `scope_add_url`
exactly and post it on its own line as `[Additional Todoist
access](<scope_add_url>)` so the client renders the native access button. Wait
for consent, then rerun `todoist list-tools` to obtain the provider's live tool
schema before performing the operation. Todoist may hide ungranted write and
delete tools from that catalogue, so an all-read list does not mean write
support is unavailable. Never construct an authorization URL or substitute a
raw Todoist scope. Hatch approval for the action remains separate.

`todoist call-tool` enforces the same check before approval or provider access.
If it returns `error_kind: additional_access_required`, the Todoist request was
not sent. Share its `scope_add_url` exactly as above, wait for consent, rerun
`todoist list-tools`, and then retry once. Do not describe this as a failed
Todoist API write.

Run `todoist list-tools` to inspect the live provider catalogue and schemas,
then call an advertised tool with:

```text
todoist call-tool --name <tool> --arguments-json '<json-object>'
```

`list-tools` exposes only reviewed Todoist tools and includes each tool's
`hatch_permission`, `hatch_action`, and `hatch_permission_label`.
`delete-object` is authorized as `projects.delete` for projects and as
`items.delete` for every other object type. Unknown or new provider tools
remain unavailable until reviewed. Read permissions follow the user's connector
settings; changes require the corresponding granular approval. Do not retry a
failed or timed-out write automatically because its side effect may have
completed.
