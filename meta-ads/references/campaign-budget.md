# Campaign budget

Read this only after every non-amount pricing input and advertiser constraint is
stable. Unresolved requested geography blocks pricing, including pricing only
the resolved subset. Existing-campaign budget diagnosis belongs to the insights
tools in `tool-routing.md`.

## Price the whole proposal once

After compact discovery confirms `ads_budget_estimate`, read its live input
schema with `describe-tool --input-only`, then run one typed
`meta-ads-cli estimate-budget` command before stating a proposed budget, cost
per result, result count, or feasibility—even when the advertiser supplied an
amount. Use objective, optimization, and result values from that live schema or
a successful current-request result, never memory or trial calls. The command
owns correlation, JSON serialization, and final live-schema validation.
Invoke `ads_budget_estimate` only through this typed command. The documented
shape below is complete; do not use `call-tool`, CLI help, or source inspection
to construct it.

Canonical broad-country shape (replace placeholders with current values):

```sh
/opt/hatch/bin/meta-ads-cli estimate-budget --account-id <ACCOUNT_ID> --advertiser-request '<COMPLETE_REQUEST>' --campaign campaign_1 '<CAMPAIGN_NAME>' <OBJECTIVE> <OPTIMIZATION_GOAL> CBO --ad-set campaign_1 ad_set_1 '<AD_SET_NAME>' --country <COUNTRY_CODE> --target-country ad_set_1 <COUNTRY_CODE> --advantage-audience ad_set_1 on
```

For resolved city-and-interest targeting, keep `--country` as plan context,
replace `--target-country ad_set_1 <COUNTRY_CODE>` with
`--city-key ad_set_1 <CITY_KEY>`, and append
`--interest-id ad_set_1 <INTEREST_ID>` for each returned interest.
Add a bounded schedule with `--ad-set-start <AD_SET_KEY> <ISO_8601>` and
`--ad-set-end <AD_SET_KEY> <ISO_8601>`.

- Add every campaign with `--campaign KEY NAME OBJECTIVE OPTIMIZATION CBO|ABO`
  and every ad set with `--ad-set CAMPAIGN_KEY KEY NAME`. Prospecting is the
  default; add `--campaign-stage KEY retargeting` only when the plan is
  affirmatively grounded as retargeting.
- Attach canonical targeting with the keyed country, city, region, interest,
  audience, locale, age, gender, and Advantage+ flags exposed by the command.
- Keep resolved targeting identical across ad sets in the same campaign. The
  estimator publishes one cost per campaign and otherwise prices on country.
- Use `--country` for plan context and exactly one geography scope per ad set:
  target countries, resolved city keys, or resolved region keys.
- When the advertiser wants a recommendation or has left budget open, omit
  `--daily-budget` and `--lifetime-budget` so the estimator solves it; do not
  choose a seed amount first. A committed advertiser amount goes in the matching
  flag with `--currency`; use maximum and goal flags only for supplied
  constraints. Lifetime budgets require duration or end dates.
- Use the complete current multi-turn `advertiser_request` required by
  `SKILL.md`.
- If cadence or stated currency is ambiguous, ask before pricing; do not divide
  a periodic amount or infer its currency.
- Never provide a cost or CPA; the tool derives it.

Consume the returned payload directly. Use `total_budget` for the whole plan and
`per_campaign[]` for allocation;
prefer returned formatted or major-unit values because minor units are write
inputs. Preserve both currencies when conversion is present.

Validate returned budget mode, assumptions, and warnings against the proposal.
A mismatched assumed CBO/ABO mode does not support that claim: make one clear
schema-grounded correction, otherwise leave pricing unresolved.

## Interpret the result

- Amount basis (`solved_for` / `basis`) explains why the budget was selected;
  cost `source`, `confidence`, sample size, and fallback reason explain how the
  result projection was grounded. Keep those concepts separate.
- `solved_for` says what decided the budget: `budget_honored`, `target_derived`,
  `account_history`, `learning_floor`, `delivery_floor` or `mixed`.
- `account_history` is measured for this advertiser, so quote it and cite the
  sample size; `peer_benchmark` and `forecast` are estimates and must be labelled
  as such; `hardcode` is a low-confidence static planning fallback and must never
  be presented as measured. Every expected result remains a projection.
- **`fallback_reason` and `cost_caveat` are not the same thing.**
  `fallback_reason` appears only when a stronger source declined, and explains
  why. `cost_caveat` qualifies the figure you were actually given —
  `cost_not_split_by_stage` means the cost *is* this advertiser's own measured
  delivery but spans prospecting and retargeting together, so quote it and say it
  is not split by stage. A caveat is not licence to distrust the number or to
  substitute one of your own.
- Treat feasibility as planning guidance, not a delivery guarantee. Preserve
  returned shortfalls, below-floor statuses, warnings, and recommended-action
  options. Never silently raise spend, reallocate, or drop a campaign.
  `estimate-budget` sends no placement input, so the figure is not
  placement-specific and cannot be repriced per placement: never present it as
  covering, excluding, or adjusted for any placement. That leaves the account's
  own identities as the thing to check. Read `ads_get_ig_accounts` whenever the
  request names Instagram or accepts automatic placements, and when none
  resolves say plainly that Instagram placements are unavailable on this
  account, so the advertiser does not plan delivery that cannot run.
  `campaign-planning.md` owns identity resolution, but a pricing-only question
  never loads it, so the check has to exist here as well.
- A delivery-floor amount establishes only the minimum supported delivery plan.
  When the advertiser's commercial value or constraints remain unknown, do not
  describe that amount or its projected results as viable, efficient, or
  profitable.
- Copy returned values exactly; do not recompute or round them.

In full research, include the exact amount and material basis inside the one
complete strategy review; there is no separate budget stop. In guided mode,
return to `campaign-guided.md` for its dedicated budget response.

An argument, schema, or other deterministic failure leaves budget unresolved
until the grounded input or interface changes. Retry at most once only for an
explicitly transient failure; otherwise do not repeat an unchanged request.
A successful response that omits required pricing fields is incomplete, not a
syntax failure; keep budget unresolved without inspecting CLI help or repeating
the unchanged call.
