# Meta Ads — complete campaign creation

Use this controller for a new campaign hierarchy. Adding one child to an
existing hierarchy is a standalone write under `references/writes.md`.

## Route only the current stage

Full research is the default. Ask product-focused questions only when the
advertised product or event is too unclear to research, then complete research
and pricing without optional recommendation steers; stop only for required
identity or a genuinely advertiser-owned blocker. Use guided mode only when the
advertiser explicitly asks to work step by step; do not ask which mode they
prefer. A mode change retains decisions that remain valid.

| Current need | Read now | Stage complete when |
|---|---|---|
| Full-research product brief, identity, research, delivery plan, or plan approval | `campaign-planning.md`; load `campaign-budget.md` after non-amount pricing inputs and advertiser constraints stabilize | All delivery decisions were presented together and accepted. |
| Explicit step-by-step planning or its separate budget steer | `campaign-guided.md`; load `campaign-budget.md` only when it directs | Its current steer was answered; budget is accepted before creative. |
| Creative plan, source preparation, or media approval | `campaign-creative.md` | The complete plan authorized its source action and every prepared ad passed the media gate. |
| Final review, paused creation, initial Ads Manager handoff, or partial recovery | `campaign-execution.md` | Every reviewed object exists, the campaign is verified paused, and the handoff is shown. |
| A selected post-create publish or editing action | `campaign-handoff.md` | The requested delivery-state or follow-up action is complete, or the campaign remains paused. |

Load only the first incomplete stage. A strategy-only request stops after its
plan is accepted unless the advertiser asks to continue.

## Decision and interaction contract

Keep one `next_open_decision`. In full research it may be the product-brief
bundle, one advertiser-owned blocker, whole-plan approval, creative source,
prepared-media approval, or final create approval. Guided mode resolves one
consequential setting at a time.

Use `muse.create_options` whenever the current question has a small bounded set
of meaningful answers. A tap submits only its `selectedText`; an unambiguous
typed answer to the same already-shown, unchanged choice is equivalent. Neither
answers another question nor accepts surrounding prose. Therefore a response
containing options asks only that widget's question, puts all decision context
before its token in the same final response, and ends after the token. Do not
repeat a settled choice merely because its answer was typed. Ask related
free-form product facts together in plain text without options. For a bounded
approval, never substitute `say the word` or another typed invitation for the
options.

These approvals remain distinct:

- identity does not approve research or budget;
- strategy approval accepts only the shown delivery plan;
- a creative-axis choice does not approve the complete creative plan;
- a source action authorizes only that preparation;
- media approval accepts only the shown media paired with the unchanged plan;
- final review authorizes only the unchanged paused hierarchy; and
- publication is a later spending decision.

## Capability and research ordering

Follow the discovery contract in `SKILL.md`: names once, only current-stage
descriptors, and `--agent-output` on normal calls. Do not fetch later-stage
create descriptors during research.

For full research, establish the product brief before discovery. Then resolve
identity sequentially: fetch the account descriptor, run the exact protected
account command required by `SKILL.md`, select the account, fetch the Page
descriptor, and read `ads_get_ad_account_pages` for that account. Later reads
may proceed only after this scope is known. Targeting resolution follows
objective and compliance; budget pricing follows the final audience,
geography, placements, and hierarchy.

Ads Manager creation requires:

- `ads_get_ad_accounts` and `ads_get_ad_account_pages`;
- `ads_targeting_search` for a creation-bound interest, place, or language that
  is not already canonical;
- `ads_create_campaign`, `ads_create_ad_set`, `ads_create_creative`, and
  `ads_create_ad`, with every selected input schema current before final review;
  a creative schema read during the current creative stage may be reused;
- every identity, destination, format, and source required by those schemas;
  and
- `ads_creative_upload_media` for each new accepted asset after final approval.
  Existing Ads references need no upload.

If a required creation capability is absent, create no partial hierarchy and
do not render final-create review or its approval options. Keep the flow at plan
or creative review, explain that execution is unavailable, and offer only a
supported revision.
When an accepted placement-specific static-image plan is unavailable, explain
the supported single-image alternative without exposing internal field names
and ask whether to revise. Never silently downgrade the accepted plan.
Capability does not authorize generation or upload; `campaign-creative.md`
owns those gates.

## Private strategy ledger

Keep the ledger only in conversation state—never `MEMORY.md`, a file, database
record, persisted strategy object, or runtime API. Track independently:

- account, Page, and Instagram identity;
- goal, objective, optimization, destination, and tracking;
- compliance, geography, audience, placements, and hierarchy;
- budget, schedule, planning mode, and strategy approval;
- creative plan, source, prepared media, and media approval; and
- final approval, returned Ads IDs, handoff, and delivery state.

Classify each decision as `settled` (value, basis, provenance), `assumed` (safe
default and reason), or `open` (exact decision and who or what can resolve it).
Settle only fields explicitly supplied by the advertiser or supported by a
successful result. A supported skill-owned default remains `assumed` and must
be shown for approval; it is not evidence. An answer to one question leaves
omitted sibling fields open, and any execution-critical field with neither a
settled value nor a safe executable default blocks strategy or final approval.
Failed research is unavailable evidence, not a negative advertiser fact.

Invalidate only dependants:

```text
identity/destination
  -> tracking + objective
  -> compliance
  -> audience + structure + placements
  -> budget
  -> strategy approval
  -> creative plan
  -> prepared media
  -> final approval
```

Retain unaffected siblings and upstream work. Material execution drift returns
to the earliest invalidated decision; reprice only after new inputs stabilize.
A DRAFT is staged, not created. Sentinel remains the native write gate after
either form of conversational acceptance; no widget, artifact, typed reply, or
conversation state replaces it.
