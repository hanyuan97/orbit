# 整合

[English](./integrations.md) · [繁體中文](./integrations.zh-TW.md)

與 Orbit 整合的第三方工具。整合建立在 Orbit 公開的 JSON CLI contract 上，詳見
[Agent CLI contract](./agent-cli.zh-TW.md)。各工具的功能與疑難排解以該工具自己的
repository 為準。

## Orbit for Orca

[Orca](https://www.onorca.dev) 是在 worktree 中執行 coding agent 的桌面應用程式。
Orbit for Orca plugin 會在 Orca 右側 sidebar 加入一個唯讀的 Orbit 狀態面板，顯示：

- 預設 runtime 與 named instances；
- 每個 instance 的 containers 與 services；
- 其 SQL projects 的同步狀態。

需要 Orbit 0.16.10 以上（`orbit` 需在 `PATH` 中）與 Orca 1.4.247 以上。

安裝與使用：

1. 在 Orca 開啟 Settings → Plugins，從 marketplace 安裝 Orbit for Orca，
   其頁面為
   [onorca.dev/plugins/iml885203/orca-orbit](https://www.onorca.dev/plugins/iml885203/orca-orbit)。
   也可以 clone [plugin repository](https://github.com/iml885203/orca-orbit)，
   再執行 `orca plugin dev load <dir>`。
2. 從 Orca 右側 sidebar 開啟 Orbit 面板。
3. 選取 instance 查看其 resources 與 SQL 狀態。在 resource 上按 Enter 或雙擊，
   即可在 terminal 分頁開啟它的 logs。

![Orca 右側 sidebar 中的 Orbit 面板](./assets/integrations/orca-orbit-panel.png)

其他內容請見 [plugin repository](https://github.com/iml885203/orca-orbit)。
