# muse-skills

A day-by-day history of the skill collection shipped with [Hatch](https://muse.ai) containers (`/opt/hatch/skills`): every skill's `SKILL.md`, references, scripts, and resources, snapshotted daily. The newest commit is always the current state.

## Where this comes from

This repo is generated, not curated. A scheduled job on a Hatch container hashes every file under `/opt` and `/usr` once a day for integrity monitoring; as part of that run it mirrors `/opt/hatch/skills` here and commits whenever anything changed. The daily job then pushes the new commit automatically.

Each snapshot commit's message is a hand-written analysis of that day's
changes — what changed and why it matters, written from reading the
actual diffs, not generated from file statistics.

## A note on the early history

The commits for 2026-09-26 through 2026-09-28 were reconstructed after the fact from per-day change archives, which only kept the *new* versions of files that changed each day. Consequences:

- Every file version in those commits is exact.
- A file first appears on the earliest day it changed inside that window — its earlier versions weren't retained, so `git log` on such a file starts at its first observed change, not its true creation.
- One removed skill (`muse-mail`, removed 2026-09-27) couldn't be recovered and is absent from all commits.

From 2026-09-29 onward, every commit is a complete, exact snapshot.

## What's excluded

Build output (`dist/`, `node_modules/`, `*.tgz`, …) is excluded per the skills' own `.gitignore` files, exactly as upstream ships them. The integrity monitor still hashes those files daily — they just aren't versioned here.

## Unofficial

This is an independent mirror kept for change-tracking. It isn't affiliated with or endorsed by Meta or the Hatch team.
