# Home Assistant

Runtime assets for the Home Assistant that the agent installs on the VM when
the user asks for it. The build installs them at
`/opt/hatch/skills/home-assistant`; the runtime cell reads them at
`/opt/muse/assets/home-assistant`.
`~/docs/devices/home_link/integrations/home_assistant.md` tells the agent when
to run which command and how to read its result.

- `home-assistant` is the agent's interface: `status`, `install`, `start`,
  `stop`, `setup`, `rollback`, `step-text` and `put-file config/<path>`, each
  printing one JSON object. It keeps the install in `~/homeassistant`:
  - `status` separates installed, running and ready; onboarded and
    credentials valid; each user-added integration's configured and connected
    state; whether the service routes through the Link; an update to the
    pinned release; and installs made another way.
  - `install` installs or upgrades to the pins in `pins.json`: the pinned uv
    (checksum-verified), the pinned uv-managed Python, and only the
    hash-locked packages in `requirements.lock`. It holds
    `~/homeassistant/installing` while it changes the environment, which keeps
    the service and its ensure timer off; it restores the old environment if
    the build fails or is interrupted. Before an upgrade it keeps the old
    environment and a copy of the database and `.storage` in `previous/`.
    `install.json` records the release, Python, uv, lock and routing-module
    hashes.
  - `rollback` restores `previous/`: the old environment and the database it
    used, since a newer release migrates the database forward.
  - `setup` onboards Home Assistant: it saves the generated owner password
    (`config/muse_owner.json`, mode 0600) before creating the owner, resumes
    an interrupted onboarding by signing in with it, and stores a long-lived
    token.
  - `step-text` reads a config flow reply on stdin and adds the step's
    title, instructions, field labels, error, abort, menu and progress text
    from the integration's English translations (a custom integration's when
    one replaces the core integration). The flow API returns only ids, so
    without it the agent misses steps such as "press the button on the
    bridge". Home Assistant's own refusals pass through as `error`.
  - `sync-adapter` runs before every service start and brings the routing
    module up to the shipped one.
- When updates happen: a new routing module takes effect at the next service
  start. A new Home Assistant release (a new `pins.json` and lock) takes
  effect only when the agent runs `install`, which it does after `status`
  reports `update_available` and the user agrees, because the release
  migrates the database.
- `muse_link_route.py` is loaded at interpreter start through
  `muse_link_route.pth`. With `MUSE_LINK_PROXY` set, Home Assistant's TCP
  connections to private (RFC 1918) IPv4 addresses become HTTP CONNECT
  tunnels through the Link proxy, under Sentinel's tunnel policy and
  approvals. Its docstring lists the supported callers;
  `scripts/tests/test_home_assistant_link_route.py` pins them.

The runtime cell's `home-assistant.service` and `home-assistant-ensure.timer`
are written by `bundle-setup/crates/spawnd/templates/runtime_cell/ensure-rootfs.sh`
on every cell start.

## Sandbox

Home Assistant runs third-party integrations and can be reached from the
home network, so it runs as its own user, `homeassistant` (in-cell uid 8123),
and sees only `~/homeassistant` and the egress CA, with no capabilities.

- `home-assistant-prepare.service`, which every start of the service pulls
  in, and the command whenever root runs it, create the user with
  `systemd-sysusers` and give it everything under `~/homeassistant` (systemd
  resolves `User=` before any `ExecStartPre=`, so this cannot be a step of
  the service itself). Home files can carry a host group the cell does not
  map; as their owner, the cell's root moves them to its own group first. The walk holds directory descriptors and never follows a
  symlink (`os.fwalk`), so a tree Home Assistant can change cannot redirect it.
- A file with another hard link (uv links packages from its cache) is copied
  into place rather than chown-ed, so a link outside the tree keeps its owner.
- Run as root, the command does its work in a child: a private mount
  namespace hides every home except `~/homeassistant`, the cell's host sockets
  except the egress CA, other users' processes and the shared temp dirs, and
  `setpriv` drops to `homeassistant` with no capabilities. Its Python runs
  isolated (`-I`) with an environment built from scratch. Code under
  `~/homeassistant` (the venv, its Python, `uv`) never runs as root.
- The child never asks root for anything. Root's own work happens before the
  child starts and after it exits, chosen by the command's name and only the
  boolean `ok`, `enabled` and `installed` fields of the child's result
  (`before` and `after`):
  - Before `install` and `rollback`, root takes the change lock
    (`/run/home-assistant-command/hold.lock`, passed on to the child) and then
    stops the service. `home-assistant-ensure.service` runs `home-assistant
    ensure`, which holds the same lock from its checks until its start is
    queued, so nothing restarts Home Assistant while the change writes its
    `installing` marker and replaces the environment.
    The timer itself is never stopped, and the kernel drops the lock with the
    last process holding it: when the agent's activity is stopped and the
    whole command is killed before root's `after`, the timer brings back an
    enabled Home Assistant within a minute, unless the change was cut off
    mid-way and left its `installing` marker (the next `start` or `install`
    settles that). After the command, root starts the service when the change
    succeeded, when it failed and was undone while `enabled` exists, or, when
    the child never reported back, when it was running before.
  - After `start`, root starts the service and the timer; after `stop`, it
    stops the service.
  - Before `status`, root reads the service's state, its environment and, while
    it is active, the journal's recovery-mode line, and hands them to the child
    as JSON in `HOME_ASSISTANT_SYSTEMD_FACTS`. After it, root runs the scan for
    other installs when the child reports nothing installed.
  A SIGTERM is passed to the child, which settles an interrupted change and
  still reports, so root's work after it runs as for any failed change.
- `step-text` and `put-file` read stdin: the child's stdin is the caller's, and
  the child reads at most 4 MiB. The child's stdout carries only its one JSON
  result.
- `put-file config/<path>` writes its stdin to that file as Home Assistant's
  user. It opens every directory relative to the last without following a
  link (`O_NOFOLLOW`), creates missing folders, refuses a link at the target,
  and replaces the file through a fresh temp name, so a tree Home Assistant
  can change cannot redirect the write. The agent writes into
  `~/homeassistant/config` only this way.
- The child stays in the caller's process tree, so Sentinel attributes its
  downloads as before.

Home Assistant still installs each integration's own packages from PyPI when
the integration is added; the lock covers Home Assistant Core.

## Updating the pinned release

1. Set `home_assistant` in `pins.json` to the new release and `python` to the
   newest uv-managed Python that satisfies its `requires_python`. Update the
   `uv` version and both checksums from that uv release's `.sha256` files if
   uv moves too.
2. Regenerate the lock:

   ```bash
   echo "homeassistant==<release>" > /tmp/ha.in
   uv pip compile /tmp/ha.in --python-version <python> --universal \
     --generate-hashes --no-header --annotation-style line \
     -o hatch-skills/runtime-assets/home-assistant/requirements.lock
   ```

3. On a test VM with an existing install, run `home-assistant install`, check
   `status`, add an integration over the Link, run `rollback` once, and update
   the guide's "Last verified" line.
