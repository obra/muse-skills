---
name: "vercel"
description: >-
  Inspect and manage the user's Vercel websites, web apps, projects, and
  deployments. Use to read build and runtime logs, investigate production errors
  and failed deployments, check deployment status, and deploy projects through
  Vercel's official MCP server.
icon: "vercel"
metadata: { "includeInPrompt": false }
---

# Vercel

Use the installed `vercel` CLI. Start with `vercel status`. If it reports
`not_connected`, run `vercel authorize-url` and share only the returned
`connect_url` with the user.

OAuth uses Dynamic Client Registration and PKCE through authd. Vercel declares
the client public and issues no client secret, so no shared credential enters
Muse and credentials must never be requested in chat. Vercel exposes only
identity and session OAuth scopes for this MCP server, so read-only-by-default
behavior is enforced by the connector permissions below rather than a narrower
provider scope.

Run `vercel list-tools` to inspect the live provider catalogue and schemas,
then call an advertised tool with:

```text
vercel call-tool --name <tool> --arguments-json '<json-object>'
```

Vercel migrated its deployment tool from `deploy_to_vercel` to
`create_deployment`. Use whichever name the live catalogue advertises; both
require the `deployments.publish` permission and approval according to the
user's connector settings.

`list-tools` exposes only reviewed Vercel tools and includes each tool's
`hatch_permission`, `hatch_action`, and `hatch_permission_label`. Unknown or
new provider tools remain unavailable until reviewed. Read permissions follow
the user's connector settings; deployments, purchases, and project changes use
separate granular approvals. Do not retry a failed or timed-out write
automatically because its side effect may have completed.
