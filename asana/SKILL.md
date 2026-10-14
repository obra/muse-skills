---
name: "asana"
description: >-
  Plan and track team projects and tasks in Asana. Use to assign work to owners,
  update due dates and status, set task dependencies, and review project progress,
  comments, teams, and workspaces through Asana's official MCP server.
metadata: { "includeInPrompt": false }
---

# Asana

Use the installed `asana` CLI. Start with `asana status`. If it reports
`not_connected`, share only its returned `connect_url` with the user. If it is
connected, run `asana accounts` before accessing workspace data.

Asana authorizes one workspace per grant. Treat every ID returned by `accounts`
as opaque and use its workspace `display_name`. When entries are ambiguous,
inspect each one with `asana call-tool --account <id> --name get_user
--arguments-json '{"user_id":"me","opt_fields":"workspaces.gid,workspaces.name"}'`
and ask the user which workspace they mean. Once selected, pass `--account
<id>` on every following `status`, `refresh`, `list-tools`, and `call-tool`
command in that task, except for the connector-wide recovery check below.
Never silently fall back to another account.

If the selected account fails authentication, run `asana accounts`. When it is
marked `needs_reauth`, run `asana status` without `--account`: share its
`add_account_url` as “Add account” if another workspace is connected, or its
`connect_url` if none are. If status cannot return a link, direct the user to
add the workspace in Settings. Authd uses both the Asana user GID and workspace
GID to recognize a previously indexed grant and replace it in place. An older
rejected grant that expired before identity metadata was indexed can still
appear as a separate stale row after reconnect; Settings can unlink that row.
After the user reconnects, run `asana accounts` again before retrying. Confirm
which healthy entry represents the intended workspace, using the display name
and workspace inspection procedure above. If its `account_id` changed, tell the
user and use the new ID for the rest of the task. If the intended workspace is
still ambiguous, ask the user before switching. Do not keep retrying the old
`needs_reauth` ID.
To remove one linked account, healthy or stale, direct the user to that
account under Connectors → Asana in Settings. Use `asana disconnect` only
when the user asks to disconnect Asana entirely: it removes every account.

OAuth uses the fixed Muse Asana MCP app, PKCE, and Asana's MCP resource
indicator through authd. CAGI supplies the client secret for token exchange,
refresh, and revocation; the secret must never enter Muse or be requested in
chat. Do not request ordinary Asana API scopes because MCP apps reject them.

Run `asana list-tools` to inspect the live provider catalogue and schemas,
then call an advertised tool with:

```text
asana call-tool --account <id> --name <tool> --arguments-json '<json-object>'
```

`list-tools` exposes only reviewed Asana tools and includes each tool's
`hatch_permission`, `hatch_action`, and `hatch_permission_label`. Unknown or
new provider tools remain unavailable until reviewed. Read permissions follow
the user's connector settings; changes require the corresponding granular
approval. Do not retry a failed or timed-out write automatically because its
side effect may have completed.
