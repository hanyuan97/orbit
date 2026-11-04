# Integrations

[English](./integrations.md) · [繁體中文](./integrations.zh-TW.md)

Third-party tools that integrate with Orbit. Integrations build on Orbit's
public JSON CLI contract, described in the [agent CLI contract](./agent-cli.md).
Each tool's own repository documents its features and troubleshooting.

## Orbit for Orca

[Orca](https://www.onorca.dev) is a desktop app for running coding agents in
worktrees. The Orbit for Orca plugin adds a read-only Orbit status panel to
Orca's right sidebar. The panel shows:

- the default runtime and named instances;
- each instance's containers and services;
- the sync status of its SQL projects.

It requires Orbit 0.16.10 or newer, with `orbit` on your `PATH`, and Orca
1.4.247 or newer.

To install and use it:

1. In Orca, open Settings, then Plugins, and install Orbit for Orca from the
   marketplace. Its listing is
   [onorca.dev/plugins/iml885203/orca-orbit](https://www.onorca.dev/plugins/iml885203/orca-orbit).
   As a fallback, clone
   [the plugin repository](https://github.com/iml885203/orca-orbit) and run
   `orca plugin dev load <dir>`.
2. Open the Orbit panel from Orca's right sidebar.
3. Select an instance to see its resources and SQL status. Press Enter on a
   resource, or double-click it, to open its logs in a terminal tab.

![The Orbit panel in Orca's right sidebar](./assets/integrations/orca-orbit-panel.png)

For everything else, see the
[plugin repository](https://github.com/iml885203/orca-orbit).
