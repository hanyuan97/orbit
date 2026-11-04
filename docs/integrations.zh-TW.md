# 整合

[English](./integrations.md) · [繁體中文](./integrations.zh-TW.md)

建立在 Orbit [JSON CLI contract](./agent-cli.zh-TW.md) 上的工具。

## Orbit for Orca

在 [Orca](https://www.onorca.dev) sidebar 加入唯讀的 Orbit 面板：instances、其
containers 與 services、SQL 同步狀態，並可在 terminal 分頁開啟 logs。

![Orca 右側 sidebar 中的 Orbit 面板](./assets/integrations/orca-orbit-panel.png)

安裝：在 Orca 開啟 Settings → Plugins → Add → "From a Git URL…"，輸入
`https://github.com/iml885203/orca-orbit`。需要 Orbit 0.16.10+ 與 Orca 1.4.247+。
詳細內容見 [plugin repository](https://github.com/iml885203/orca-orbit)。
