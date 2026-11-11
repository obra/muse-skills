# Preserve a report during a temporary pause

Use this process when the user wants a completed-action report later. Preserve only the postponed portion when other actions can be reported now. An unwanted, already communicated or superseded report needs no new schedule. Silence alone is not a pause or a reason to repeat an offer.

## Preserve the work

Check the user's latest timing instructions and the relevant conversation with `chat.read_messages` or `muse.memory_search`. Use `tracking.search`, `tracking.get`, `cron.list` and `cron.view` to find existing coverage. Read a related user goal with `user_goal.get` when one is supplied. Use the same active record and schedule when they already carry this responsibility.

Use `tracking.create` only if no suitable record exists. Omit `proactivity_follow_up` on this background handoff. Keep the record open.

Save the actual prepared report with `muse.write` in a private Markdown file under its owner's `workspace/goals/<goal-slug>/hidden_files/`, not just a note to return to the topic. Preserve what changed, verified current state and check time, action and source IDs, exact attachment and widget references, the destination chat ID and any relevant user reply reference. Record the user's pause, its source message and the permitted resume time with its timezone. Keep the file and its referenced outputs until reporting is resolved. Note the obligation and saved report path with `tracking.create_entry`, or `user_goal.create_entry` for a user goal. Keep these entries concise and user-facing.

## Arrange the later report

For a known resume time, use one `cron.add` with a stable ID, `mode: "task"`, `schedule.kind: "runonce"`, a `goal:` owner naming the existing goal or tracked item, and an explicit destination chat ID. Follow the tool's time and permission schema. Update matching coverage with `cron.update` instead of adding another job.

Write the complete reporting task into the cron body, with the saved report's exact path and these instructions:

- Read the saved report and `~/PROACTIVE_PREFERENCES.md`, and check newer explicit feedback and user-visible replies. Report only the actions still owed. Recheck facts that may have changed, without repeating the underlying actions.
- Honor the saved resume time. If execution starts early, use `muse.exec` for a bounded wait and await its completion before reporting. An early start is not a reason to discard the report.
- If newer explicit feedback extends the pause, preserve the same report. This task authorizes one `cron.add` for a replacement one-off at the newly permitted time, with the same owner, destination and complete reporting task. Use an ID derived from the current job and new resume time. Inspect `cron.list` first and reuse matching replacement coverage. Verify it with `cron.view`. Do not retime the currently executing one-off job. Keep updated report state in its file, not the job body.
- Keep the original destination, source context and reply reference. Preserve useful finished outputs, follow their presentation instructions and match the conversation's language and tone. Do not add new offers or reminders.
- Keep the reporting obligation open until actual user-visible delivery is verified or the user no longer wants it. A successful run alone does not prove delivery.

Describe these outcomes without naming terminal tools in the cron body, since validation rejects those names. A pause without a known resume time leaves a pending obligation in Tracking. Preserve its resumption condition rather than inventing a cadence.

Read back the saved job with `cron.view` and verify its enabled state, time, owner, destination, body and report path before completing quietly. After an error or uncertain result, inspect the existing record and job before retrying. Repair the same obligation and do not claim the report is safely deferred until preservation succeeds. Keep unresolved failures in the record for follow-through.
