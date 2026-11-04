# Isolated runtime instances

[English](./instances.md) · [繁體中文](./instances.zh-TW.md)

Use a named instance to run multiple checkouts, agents, or CI jobs independently
on the same machine. The default runtime uses the declared host ports, the
default daemon socket and dashboard address, and the legacy Docker resource names.

## Use a named instance

`--instance <name>` targets one isolated runtime and is available to lifecycle
and diagnostic commands:

```bash
orbit up --instance checkout-a --json
orbit status --instance checkout-a --json
orbit logs app --instance checkout-a --json
```

Keep the same instance target for the whole workflow. JSON responses include
the `instance` field, and their recommended actions retain that target.
Named dashboards show the instance in the header and browser tab. The default
runtime keeps the standard dashboard header without an instance badge.

List named instances to discover their environment, daemon state, dashboard,
and resolved resource endpoints:

```bash
orbit instance list --json
```

`state` is the instance daemon's state (`running` or `stopped`), not its
resources'. Each entry also reports:

- `resource_states`: how many resources are in each state, keyed by the
  resource `state` that `orbit status` reports, such as
  `{"healthy": 2, "stopped": 10}`. It is omitted when the daemon is stopped or
  does not answer, so a missing field means unknown, not zero.
- `last_active_at`: when the instance last recorded a command or dashboard
  action. It is omitted when the instance has no history yet.

## Isolation and ports

Each named instance owns a directory under `~/.orbit/instances/`, including its
daemon socket, log, state, ownership record, and resolved ports. It also owns a
Docker namespace, network, containers, and volumes.

The default runtime treats declared host ports as fixed. A named instance
treats them as preferences: Orbit selects available ports when necessary,
persists the result for stable restarts, injects the resolved ports into host
services, and reports the actual endpoints through `up`, `status`, and
`instance list`.

Callers should consume those reported endpoints instead of assuming the
declared port or coordinating `ORBIT_HOME`, `ORBIT_NAMESPACE`,
`ORBIT_DASHBOARD_PORT`, and `ORBIT_SOCKET` themselves.

## Cleanup

```bash
orbit instance clean checkout-a --json
```

Cleanup stops the instance and removes its daemon state and Docker resources.
It is destructive to that instance's local processes and data, but ownership
labels keep other named instances and the default runtime untouched. Run it
only when that instance is no longer needed.

Cleanup does not need the instance's original config, so it still works after
the checkout or temporary directory holding that file is gone. A running
instance stops through its own daemon. For a stopped instance, Orbit stops only
recorded service processes whose live process group, working directory, and
command still match the record. It leaves any other PID running, because a PID
can be reused after a reboot, and reports it as a
[skipped process](agent-cli.md). A matching process group that fails to stop
is reported the same way, with the stop error as its reason. Clean still
removes the instance's records, so stop such a PID yourself if it is still the
service.

Orbit labels newly created named volumes with their exact instance ownership.
Volumes created by older Orbit versions may not have this label. Cleanup
preserves these unlabelled legacy volumes because their names alone cannot
prove ownership safely; remove or migrate them manually after verifying their
data. Ordinary `down` and restart operations keep
configured named volumes and bind mounts, while removing image-created
anonymous volumes with their containers.

Low-level runtime environment variables remain available for compatibility
and tests of Orbit's isolation internals. They are not the normal way to run a
second stack; see [Configuration](configuration.md#low-level-runtime-overrides).
