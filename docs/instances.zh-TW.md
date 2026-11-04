# 隔離的 runtime instances

[English](./instances.md) · [繁體中文](./instances.zh-TW.md)

同一台機器上的多個 checkout、agent 或 CI job 需要獨立執行時，請使用
named instance。預設 runtime 使用宣告的 host port、預設 daemon socket 和
dashboard 位址，以及既有的 Docker 資源名稱。

## 使用 named instance

`--instance <name>` 會指定一個隔離 runtime，可套用於 lifecycle 與 diagnostic
commands：

```bash
orbit up --instance checkout-a --json
orbit status --instance checkout-a --json
orbit logs app --instance checkout-a --json
```

整個 workflow 都應維持相同的 instance target。JSON response 會包含 `instance`
field，recommended actions 也會保留該 target。
Named dashboard 會在 header 與 browser tab 顯示 instance；default runtime 則維持
標準 dashboard header，不顯示 instance badge。

列出 named instances，即可取得 environment、daemon state、dashboard 與解析後的
resource endpoints：

```bash
orbit instance list --json
```

`state` 是該 instance daemon 的狀態（`running` 或 `stopped`），不是 resources
的狀態。每個 entry 另外回報：

- `resource_states`：各 state 的 resource 數量，key 為 `orbit status` 回報的
  resource `state`，例如 `{"healthy": 2, "stopped": 10}`。Daemon 停止或沒有
  回應時會省略，因此欄位不存在代表未知，而非零。
- `last_active_at`：該 instance 最近一次記錄 command 或 dashboard 操作的時間。
  Instance 尚無 history 時會省略。

## 隔離與 ports

每個 named instance 都擁有 `~/.orbit/instances/` 下的獨立目錄，其中包含 daemon
socket、log、state、ownership record 與解析後的 ports；同時也擁有獨立的 Docker
namespace、network、containers 與 volumes。

Default runtime 會把宣告的 host ports 視為固定值。Named instance 則把它們視為
preferences：必要時 Orbit 會選擇可用 port、持久化結果以維持 restart 穩定、將解析
後的 port 注入 host services，並透過 `up`、`status` 與 `instance list` 回報實際
endpoints。

Caller 應使用這些回報的 endpoints，不要假設宣告 port，也不必自行協調
`ORBIT_HOME`、`ORBIT_NAMESPACE`、`ORBIT_DASHBOARD_PORT` 與 `ORBIT_SOCKET`。

## 清理

```bash
orbit instance clean checkout-a --json
```

Cleanup 會停止該 instance，並移除其 daemon state 與 Docker resources。這會刪除
該 instance 的本機 processes 與資料，但 ownership labels 會保護其他 named
instances 與 default runtime。只在確定不再需要該 instance 時執行。

Cleanup 不需要該 instance 原本的 config，因此即使存放該檔案的 checkout 或暫存目錄
已不存在仍可執行。執行中的 instance 會透過它自己的 daemon 停止。對已停止的
instance，Orbit 只會停止 live process group、working directory 與 command 仍符合
紀錄的 service processes。其他 PID 會保持執行，因為 PID 可能在重開機後被重複使用，
並回報為 [skipped process](agent-cli.zh-TW.md)。符合紀錄但無法停止的 process group
也會以相同方式回報，reason 為停止時的錯誤。Cleanup 仍會移除該 instance 的紀錄，
若該 PID 仍是該 service，請自行停止它。

Orbit 會在新建的 named volumes 加上該 instance 的 exact ownership label。舊版
Orbit 建立的 volumes 可能沒有這個 label；cleanup 會保留這些 unlabeled legacy
volumes，因為只靠名稱無法安全證明 ownership。請先確認資料，再手動移除或遷移這些
volumes。一般的 `down` 與 restart 會保留設定中宣告的 named volumes 和 bind
mounts，並隨 container 移除 image 建立的 anonymous volumes。

底層 runtime environment variables 仍保留給相容性與 Orbit 隔離內部的測試，
不再是啟動第二個 stack 的一般方式；詳見
[設定](configuration.zh-TW.md#底層-runtime-覆寫)。
