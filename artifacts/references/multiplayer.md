---
description: A web artifact several people use at once, like a shared board, a game, or a poll. Who is here, who did what, and keeping everyone's page current.
---

# Multiplayer spaces

The user can share a fullstack artifact with their Muse connections. Everyone opens it through the user's Muse and uses the same actions and data. Static pages can't do any of this.

## Who is here

In the page, `useSpaceViewer()` from `@hatch/space-sdk/client` returns `{ you, host, present }` or null.

- Each person has `id`, `name` (can be null), `role` (`view`, `use`, or `edit`), and `owner`.
- `you` is the viewer. `present` is everyone here, including `you`. Match people by `id`.
- `host` is the owner, present or away.
- Null means no one else can be here, like on a public share link. Hide the who's-here parts.

Outside React, `subscribeSpaceViewer(listener)` gives the same value, plus `join`, `leave`, and `change` events.

## Keeping pages current

Every action that changes data must call `ctx.invalidateQueries()`. Other people's pages then refetch, as long as they use `useSpaceViewer()`. Don't poll for other people's changes.

## Who did what

In an action, get the person from `ctx.viewer`. Don't trust one passed in the action's arguments.

- `source` is `"peer"` for someone the user shared with. Store their `museId` and `name`.
- A `delegate` means the user's agent or a schedule.
- Otherwise `isOwner` true means the owner, on their Muse or a share link. Show them with `host` in the page.
- For anyone else, like a share link visitor or no `ctx.viewer`, don't name anyone.

In the page, match a stored `museId` to a person's `id`. Everyone shares the same rows. Record who did what, but don't split rows per person. Someone with `view` can only look, so hide controls that change anything. Keep writes out of actions that run on open or refetch.

```ts
addCard: defineAction({
  request: z.object({ text: z.string().min(1).max(500) }),
  response: z.object({ ok: z.literal(true) }),
  async handler(ctx, { text }) {
    const viewer = ctx.viewer;
    const by =
      viewer?.source === "peer"
        ? { byMuse: viewer.museId, byName: viewer.name ?? null }
        : { byMuse: null, byName: null };
    const agent = viewer?.source === "local" && viewer.delegate !== undefined;
    const byOwner = viewer?.isOwner === true && !agent;
    await ctx.db<typeof schema>().insert(schema.cards).values({ text, byOwner, ...by });
    ctx.invalidateQueries();
    return { ok: true };
  },
}),
```
