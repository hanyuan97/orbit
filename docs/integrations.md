# Integrations

[English](./integrations.md) · [繁體中文](./integrations.zh-TW.md)

Tools built on Orbit's [JSON CLI contract](./agent-cli.md).

## Orbit for Orca

A read-only Orbit panel in [Orca](https://www.onorca.dev)'s sidebar: instances,
their containers and services, SQL sync status, and logs in a terminal tab.

![The Orbit panel in Orca's right sidebar](./assets/integrations/orca-orbit-panel.png)

Install: in Orca, open Settings → Plugins → Add → "From a Git URL…" and enter
`https://github.com/iml885203/orca-orbit`. Needs Orbit 0.16.10+ and Orca
1.4.247+. Details are in the [plugin repository](https://github.com/iml885203/orca-orbit).

## Orbit for Herdr app

An Orbit window for the [Herdr app](https://herdr.dev) (`herdr-app`, the desktop
app; not the Herdr terminal TUI): every instance as a pill, its containers and
services with restart and stop, logs, traces with their span waterfall, SQL sync
status, and a button that stops the daemon. Logs and traces can be handed to a
coding agent in a Herdr app terminal.

![The Orbit window in the Herdr app](./assets/integrations/herdr-app-orbit-panel.png)

Install: Herdr app mods are added by your agent rather than by a package manager.
Ask the agent running in the Herdr app to add the mod from
`https://github.com/iml885203/orbit/tree/main/integrations/herdr-app`; it reads the
files, copies `mods/orbit/` into `~/.config/herdr-app/mods/` and merges `cmd-o`
from `keys.json`. Needs Orbit 0.16.10+ for SQL status. How it is built is in
[RECIPE.md](https://github.com/iml885203/orbit/blob/main/integrations/herdr-app/RECIPE.md).
