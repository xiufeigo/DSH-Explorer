# 最新 DSH 兼容性审计（0.1.2-rc.1 桌面载荷 · 实测版）

> **后续状态**：本文件记录的是审计当时的事实与「官方重叠项」清单。其中 ToDo、Token 消耗、子智能体、会话大纲、对话点路径拦截**已按本审计结论删除**，`dsh.client.inject` 也已改为真实包名；当前实现状态与两处「有意偏离」的说明见 [`../README.md`](../README.md) 的「接入规范符合性」与「0.1.2 起已删除的功能」两节。

> **基线变化**：桌面载荷已从 `0.1.1-rc.2` 升级到 **`0.1.2-rc.1`**（`payload/payload-manifest.json` 的 `frontend.version` = `0.1.2-rc.1`，载荷目录时间 2026-09-06 21:32）。前一版审计只做「已装 0.1.1-rc.2 + 上游 0.1.2-rc.1 源码比对」，**现在 0.1.2 已真实落到本机**，本文件记录实测结果，取代那份纸面结论。
>
> 上游 `deepseek-harness` checkout 同为 `0.1.2-rc.1`（HEAD `a66e470204`），与载荷同版本，可对拍。

---

## 一、实测结论：DSH-Explorer 在 0.1.2-rc.1 载荷上存活

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| Host 半边在线 | `POST /dsh-explorer/rpc`（自定义头 + 回环 Origin） | ✅ **HTTP 200**，响应体是插件自己的文案（`{"error":"缺少 sessionId"}`），证明路由真的挂上了 |
| Origin 闸未退化 | 同一请求去掉 `Origin` | ✅ **HTTP 403**（防 DNS rebinding 闸仍在工作） |
| 路由精确匹配 | 请求 `/dsh-explorer/nonexistent` | ✅ **HTTP 404**（不是被兜底吞掉） |
| 载荷 fork 自愈 | 读载荷 `ui-layout/lib/client.js` | ✅ 已是 `clampWidth(details, 300, 1200)` + 文件尾标记；`client.js.dshx-orig` 备份仍是**干净上游** `300, 520` → 说明**新载荷装好后钩子重新打过**，不是旧补丁残留 |
| 6 个槽位 | 在载荷 bundle 里数出现次数 | ✅ `conversation.session.header.utilities`×2（ui-conversation）、`details`×51（ui-layout）、`sidebar.footer.action`×3（ui-sidebar） |
| `dsh-client-runtime` | 载荷目录 | ✅ **已删除**（0 命中），插件 `dsh.client.inject` 里的声明无害 |
| `workspaces.openPath` | 载荷 `dsh-api-workspace-controller/lib/client.js` | ✅ **0 命中**（本地面确实没了）→ 插件的特性检测分支按设计生效 |
| 客户端 bundle | 仓库自带 smoke（按运行时方式执行两个 bundle） | ✅ `All smoke checks passed.`（含 RPC 闸、载荷 fork 幂等/半命中/备份刷新、排序与置顶、tokenUsage 契约等全部用例） |
| 插件接线 | profile | ✅ `~/.dsh/profiles/node_modules/dsh-explorer` junction → 仓库；`profiles/web/cordis.patch.yml` 有 `insert: dsh-explorer` 行 |

**未能直接验证的一项**：本机 GUI 的 `index.html` 需要鉴权（`GET /` → 401、`/api/` → 401；`/plugins/*` 不拦但未公告的 URL 一律 404），所以**没能读到线上 boot graph** 来逐字确认浏览器半边那一行。间接证据已足够：两个 bundle 能按运行时方式执行通过；`exports["./client"]` 与 `lib/client.js` 齐全；加载器对 `inject` 只做数据投影、不做存在性校验（见下）。若客户端半边真的没进图，表现会是整页 `Failed to load plugins`，而不是现在「只有点路径的行为变了」。

### 加载器对「声明了不存在的 inject 包」确实是放行的（源码级确认）

`packages/client/modules` 里 `dsh.client.inject` 只被投影成图行数据，不校验目标包是否存在：

- `parseDshClient`：只校验 `platform` 是字符串、`inject`/`external` 是非空字符串数组，**不解析包名**；
- `graphRow(...)`：`...(fields.inject !== undefined ? { inject: fields.inject } : {})` 原样写进 row；
- 排序阶段 `rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))` 取不到就当「无图边」，**不抛错**。

➡️ 所以 `package.json` 里保留 `@deepseek-ai/dsh-client-runtime` 是安全的，**不需要**改成新域包名。

---

## 二、升级后唯一用户可见的行为变化（已落地）

**对话里点文件路径，不再进 Explorer 的编辑器 tab。**

原因链：

1. 0.1.1 及更早：官方对话点路径 → 调用客户端本地服务 `workspaces.openPath`，插件包装它把文本文件截进右侧栏编辑器；
2. 0.1.2：本地服务面随 client-runtime 重组删除，打开改走远端 `session/openWorkspacePath`（载荷已确认 `openPath` 0 命中、ui-chat 里存在 `openWorkspacePath`/`openFile`）——**没有可包装的本地函数**，`installChatFileOpen` 走 `typeof workspaces?.openPath !== 'function'` 分支返回空 disposer，路径点击回落宿主默认行为（系统默认程序打开）；
3. 插件自己的「用系统默认程序打开」经 `openWithSystem` 的远端回退仍可用，插件自有 RPC `fs.openExternal` 仍是最终兜底。

**不受影响**：左侧文件树、审查面板、摘要卡片里的入口（都不经过 `workspaces.openPath`）。

### 可选修复方向（比 README 现状更进一步）

`chatFileOpen.rememberRemoteOpenPath()` 已经把 `ctx.get('remote').session` 命名空间**捕获下来**了，却只用于 `openWithSystem`。理论上可以**同样包装远端方法**恢复点击拦截：

- `remote.session.openWorkspacePath` 是 Typert 远端方法（`@Remote('openWorkspacePath')`，入参 `{ path }` + `AbortSignal`）；
- 捕获后尝试 `ns.openWorkspacePath = 包装版`（own property 遮蔽原型方法）：命中文本文件就转 `openFileTab`，否则回落原始方法；
- 需要 `try/catch`（远端代理可能被冻结/拒写，和现有 `workspaces.openPath` 包装同一套防御）；
- 待确认：远端对象是否允许属性写入；官方 `ui-deliverables` 的行内链接是否也走这同一个方法（若走，包装后一并生效）。

这是**新宿主上唯一丢失的能力**，若要补，就是上面这一处。

---

## 三、官方已在 0.1.2 实现的功能（**已在载荷里**，非纸面）

载荷中确认存在：`dsh-client-ui-deliverables`、`dsh-client-ui-subagent`、`dsh-client-ui-reference`、`dsh-session-turn-outline`、`dsh-api-session-controller`、`dsh-api-workspace-controller`、`dsh-client-ui-renderer`。

| DSH-Explorer 功能 | 官方对应 | 重叠度与建议 |
| --- | --- | --- |
| 上下文 → ToDo | `ui-conversation` 的 `TodoPanel`（`todoDockEntry` → `conversation.composer.dock`，带状态计数与折叠） | **重叠**。官方是输入区 dock 的 checklist；Explorer 是右侧栏「上下文」里的只读展示。可保留，或改成引用官方组件少维护一份 |
| 上下文 → Token 消耗 | `ui-chat` 的 `TurnUsagePanel`（回合级 usage 展开行） | **重叠但层级不同**。官方按回合，Explorer 按会话 / 模型 / 时间桶聚合。建议保留 Explorer（官方没有跨会话聚合） |
| 子智能体面板 | `ui-subagent`：header lineage 面包屑 → 完整后代目录（token / 时长 / 运行态 / 继续会话 / `@` 引用） | **重叠且官方更全**。建议评估以官方 Catalog 为主，Explorer 面板降级，或只保留「右侧栏看子会话」这一差异点 |
| 会话大纲（左侧用户消息） | `session-turn-outline` + ui-chat TurnNavigator / turn-rail | **部分重叠**。官方是回合级右侧 rail；Explorer 是用户消息级左侧大纲。可共存 |
| 来源 | `ui-reference`（`@file`/`@session` 输入候选） | **基本不重叠**：官方管「输入候选」，Explorer 管「本会话已引用/搜到的页面回顾」。保留 |
| 审查（Git 变更 / 上一回合 / 分支变更） | `ui-deliverables`（回合产物行 + 行内代码链接，交系统打开） | **定位不同**：官方只给「本轮产出了哪些文件 + OS 打开」；Explorer 给 Git diff 可视 + 面板内编辑/预览。保留 |
| 文件树 / 编辑器 / HTML·Markdown 预览 / 浏览器端终端 / 摘要卡片 / 工作区时间排序+置顶 | **无官方对应** | **全部保留**。官方 `terminal/` 是给模型的 PTY 工具，不是浏览器终端 UI；载荷里也搜不到 xterm / file tree / editor 面板 |

---

## 四、待办

1. **升级后重跑** `pnpm plugin:install --fork-ui`：宽度 fork 已由载荷自愈钩子自动重打（已实测），但 `sidebar.workspaces.actions` **座位 fork 改的是 harness 源码树**（`scripts/install.mjs` 中 `SIDEBAR_DIR = harnessRoot/packages/client/ui-sidebar/src/client`），桌面载荷吃 npm 包，**载荷 ui-sidebar 里 `workspaces.actions` 为 0 命中** → 桌面壳上「工作区 \| 文件」始终走 `sidebar.footer.action` 兜底座位（README 已说明该回退）。若想在桌面壳也拿到顶部座位，需要给 `payloadFork` 再加一条 ui-sidebar 的 `ForkSpec`。
2. 若在意「点对话里的文件路径进编辑器」：按第二节「可选修复方向」包装远端 `session.openWorkspacePath`。
3. 官方重叠项按上表取舍，避免 ToDo / 子智能体长期双入口并存。

---

## 五、复现命令

```powershell
# 载荷版本
(Get-Content "$env:LOCALAPPDATA\DSH Desktop\payload\payload-manifest.json" -Raw | ConvertFrom-Json).frontend.version

# 载荷 fork 现状（应为 300, 1200 + 标记；备份应为 300, 520）
$l = "$env:LOCALAPPDATA\DSH Desktop\payload\app\node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js"
Select-String -Path $l -Pattern 'clampWidth\([^)]*\)' -AllMatches | % { $_.Matches.Value }
Select-String -Path $l -Pattern 'dsh-explorer payload fork' -SimpleMatch

# 槽位是否在载荷 bundle 里
$nm = "$env:LOCALAPPDATA\DSH Desktop\payload\app\node_modules\@deepseek-ai"
(Select-String -Path "$nm\dsh-client-ui-conversation\lib\client.js" -Pattern 'header.utilities' -SimpleMatch).Count
(Select-String -Path "$nm\dsh-client-ui-sidebar\lib\client.js" -Pattern 'footer.action' -SimpleMatch).Count

# openPath 是否已删除（应为 0）
(Select-String -Path "$nm\dsh-api-workspace-controller\lib\client.js" -Pattern 'openPath' -SimpleMatch).Count

# Host 半边在线（200 / 403 / 404）
Invoke-WebRequest -Uri "http://127.0.0.1:53052/dsh-explorer/rpc" -Method POST -Body '{}' `
  -ContentType 'application/json' `
  -Headers @{ 'x-dsh-explorer'='1'; 'Origin'='http://127.0.0.1:53052' } -UseBasicParsing | % StatusCode

# 插件自检
cd C:\sensorsdata\main\program\DSH-Explorer; node scripts/smoke.mjs
```
