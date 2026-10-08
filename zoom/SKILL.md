---
name: "zoom"
description: >-
  Review Zoom meetings, calls, recordings, and transcripts. Use to
  catch up on missed calls, summarize decisions, and extract action items and
  owners; also work with Team Chat, Canvas, Tasks, Whiteboard, Hub, and Revenue
  Accelerator through Zoom's official MCP servers.
metadata: { "includeInPrompt": false }
---

# Zoom

Use the installed `zoom` CLI. Start with `zoom status`. If it reports
`not_connected`, run `zoom authorize-url` and share only the returned
`connect_url` with the user.

OAuth uses the fixed Muse Zoom OAuth client and PKCE through authd. CAGI supplies
the client secret for token exchange and refresh; the secret must never enter
Muse or be requested in chat.

Run `zoom list-tools --names-only` for compact live discovery across every
official Zoom MCP server. To inspect only one server, add `--server <server>`,
where `<server>` is one of `zoom`, `meeting`, `chat`, `canvas`, `tasks`,
`whiteboard`, or `revenue-accelerator`. Once you select a tool, inspect only
its current schema with:

```text
zoom describe-tool --server <server> --name <tool>
```

Bare `zoom list-tools` retains the complete catalogue for diagnostics. Do not
truncate that output through a shell pipeline to discover one schema.

Call an advertised tool on the server that returned it with:

```text
zoom call-tool --server <server> --name <tool> --arguments-json '<json-object>'
```

The `zoom` server is the default for backward compatibility. The dedicated
`meeting` server currently overlaps with the meeting and recording tools on the
all-in-one `zoom` server, while the other dedicated servers add broader product
capabilities.

Provider catalogues can contain both reads and mutations and may change over
time. The CLI validates the name against the selected server's live catalogue.
Reviewed read-only tools use Zoom's read permission; mutations and newly
advertised tools remain write-gated until their behavior is reviewed. Do not
retry a failed or timed-out tool call automatically because its side effect may
have completed.

If a dedicated server reports a missing OAuth scope after an upgrade, ask the
user to reconnect Zoom so the expanded grant can be approved. Never disconnect
an existing connection without the user's confirmation.

Some servers require separately licensed Zoom products. Treat a per-server
error as that server being unavailable; continue using catalogues that report
`ok: true` rather than claiming the whole Zoom connection failed. A provider
tool result marked as an error is a failed CLI invocation, even if the MCP
transport itself succeeded.

Do not infer meeting CRUD availability from OAuth scopes or previous catalogues.
If live discovery advertises `meeting_create`, inspect its schema before use;
the CLI supplies `userId: "me"` when that field is omitted. Never retry a
meeting create after a timeout or uncertain provider outcome.

Before promising a recap, confirm that the selected meeting exposes a recording
or transcript to the connected user. Attendees normally cannot read a host's
private recording, and some summaries require a separate Zoom license. Explain
those limits immediately when the required asset is absent. Zoom cannot join a
live meeting through these MCP servers.
