# Home Assistant

Runtime assets for the Home Assistant that the agent installs on the VM when
the user asks for it. The build installs them at
`/opt/hatch/skills/home-assistant`; the runtime cell reads them at
`/opt/muse/assets/home-assistant`.
`~/docs/devices/home_link/integrations/home_assistant.md` tells the agent when
to run which command and how to read its result.

- `home-assistant` is the agent's interface: `status`, `install`, `start`,
  `stop`, `setup`, `rollback` and `step-text`, each printing one JSON object.
  It keeps the install in `~/homeassistant`:
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
