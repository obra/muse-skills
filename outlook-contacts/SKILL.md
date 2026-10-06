---
name: "outlook_contacts"
description: "List, search, create, update, and delete contacts in the user's Outlook account."
metadata: { "includeInPrompt": false }
---

# Outlook Contacts

## Purpose
Manage Outlook contacts with a local helper CLI so the prompt stays concise.
The connector supports both personal Microsoft accounts and Microsoft 365 work
or school accounts.

## Tooling
Use:

```sh
outlook-contacts <subcommand> [options]
```

Core subcommands:
- `disconnect`
- `accounts` (identity metadata only; never tokens)
- `list [--page-size 10] [--page-token <token>]`
- `get "AAMkAD..."`
- `search "alice smith" --page-size 10`
- `create --given-name "Alice" --family-name "Smith" --email alice@example.com --phone "+15551234567"`
- `update "AAMkAD..." --given-name "Alice" --email newalice@example.com`
- `delete "AAMkAD..."`

Commands use the default linked contacts account unless `--account
<account_id>` is provided. When the user clearly means a particular account,
run `outlook-contacts accounts`, match its `display_name`, and pass its opaque
`account_id` with `--account`. Ask when the match is ambiguous, and never
silently retry against the default account. `--account` applies only to
contact operations; `--status`, `accounts`, and `disconnect` are
connector-wide. To remove one contacts account while keeping the others,
direct the user to that account under Connectors in Settings; do not run
`disconnect`.

Once an account is selected, repeat the same `--account <account_id>` on every
follow-up that uses results from that contacts account, including pagination
with `--page-token`, `get`, `update`, and `delete`. Contact IDs and page tokens
belong to the account that returned them.

Common option:
- `--timeout-secs N` (default `30`)

Use `--page-size` for result count. `--top`, `--limit`, and `--max-results`
are compatibility aliases only; do not use them in new commands.

JSON output contract:
- `disconnect`: parse `ok`, `action`, `status`, and `disconnect_url`
- `list` / `search`: parse `ok`, `count`, `next_page_token` (when present, pass back as `--page-token`), `total_people`, and `contacts[].resource_name`, `contacts[].display_name`, `contacts[].emails`, `contacts[].phones`
- `get`: parse `ok` and `contact.resource_name`, `contact.display_name`, `contact.emails`, `contact.phones`, `contact.organization`, `contact.title`
- `create` / `update` / `delete`: parse `ok`, `action`, `resource_name`

## Auth
This skill depends on an Outlook connector managed by `outlook-contacts`.

Use:

```sh
outlook-contacts --status
```

Rules:
- If `outlook-contacts --status` returns `connect_url`, replace `<connect_url>` with the returned URL and share exactly this Markdown link: `[Connect Outlook Contacts](<connect_url>)`; do not paste the raw URL separately.
- When the connected response includes `add_account_url`, share it as `[Add Outlook Contacts account](<add_account_url>)` when another account should be linked.
- For disconnect, run `outlook-contacts disconnect`. When `disconnect_url` is present, replace `<disconnect_url>` with the returned URL and share exactly this Markdown link: `[Disconnect Outlook Contacts](<disconnect_url>)`; do not paste the raw URL separately. If absent, say the connector is already disconnected.
- never use a shared connector helper CLI for Outlook Contacts
- do not hand-author token files or guess connector state; rely on `outlook-contacts --status`

## Operating Rules
1. Use `search` for finding contacts by name, email, or phone number.
2. Use `list` for browsing contacts with pagination via `--page-token` (skip value).
3. Contact IDs are opaque Graph strings (for example `AAMkAD...`); use the exact value from `list` or `search`.
4. `create`, `update`, and `delete` may proceed from a clear, unambiguous user request without an additional confirmation.
5. When updating a contact, only the specified fields change; unspecified fields keep their existing values.
6. If any command reports an auth failure, stop and run
   `outlook-contacts --status`. If it returns `connect_url`, share the normal
   connect link. Otherwise run `outlook-contacts accounts`: check the selected
   account when the failed command used `--account`, or every account when it
   did not. For each relevant row with `needs_reauth: true`, share the status
   response's `add_account_url` as
   `[Reconnect Outlook Contacts account](<add_account_url>)` and ask the user
   to sign in with that same Microsoft account. Never rerun a failed
   `--account` command without `--account`.
7. Never print connector secrets or dump raw contact payloads unless the user explicitly asks for them.
8. Never surface raw Graph identifiers (contact ids like `AAMkAD...`) or other internal response fields (change keys, page/skip tokens, raw JSON) in text shown to the user — including in summaries, lists, or per-item annotations. Reuse the ids only internally to chain follow-up commands (rule 3). The sole exceptions are when the user explicitly asks for a raw id or you must show one to troubleshoot a failure.
