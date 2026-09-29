---
name: "figma"
description: >-
  Inspect Figma designs and generate implementation context for screens and
  interfaces. Use to read component variants, spacing and design tokens, inspect
  layouts and design-system libraries, and extract image assets for implementing
  a design through Figma's official MCP server.
icon: "figma"
metadata: { "includeInPrompt": false }
---

# Figma

Use the installed `figma` CLI. Start with `figma status`. If it reports
`not_connected`, run `figma authorize-url` and share only the returned
`connect_url` with the user.

OAuth uses Dynamic Client Registration and PKCE through authd. Figma issues a
per-registration confidential client; authd stores its generated secret outside
the runtime cell, so credentials must never be requested in chat.

Run `figma list-tools` to inspect the live provider catalogue and schemas,
then call an advertised tool with:

```text
figma call-tool --name <tool> --arguments-json '<json-object>'
```

`list-tools` exposes only reviewed Figma tools and includes each tool's
`hatch_permission`, `hatch_action`, and `hatch_permission_label`. Unknown or
new provider tools remain unavailable until reviewed. Read permissions follow
the user's connector settings; design, file, asset, Code Connect, plugin, and
shader changes require granular approval. Do not retry a failed or timed-out
write automatically because its side effect may have completed.

## Choose the workflow

Read only the guide that matches the task before calling provider tools:

- Implement a Figma design in code: [design-to-code](references/design-to-code.md)
- Create or edit canvas content with `use_figma`:
  [canvas editing](references/canvas-editing.md)
- Generate a FigJam diagram: [diagrams](references/diagrams.md)
- Create Code Connect mappings: [Code Connect](references/code-connect.md)

For a Figma URL, extract its `fileKey` and `node-id`; convert node IDs from URL
form (`123-456`) to API form (`123:456`). Inspect the live schema before
constructing arguments because Figma can add optional fields without changing
this skill.

Avoid redundant catalogue, context, screenshot, and validation calls. Figma
applies account- and seat-dependent usage limits, and repeated reads can consume
a user's small monthly allowance. Reuse results gathered earlier in the task.
