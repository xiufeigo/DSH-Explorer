# DSH-Explorer

> 声明：本项目是纯 vibecoding 做出来的，由 Cursor + Grok 4.6 制作。

给 DeepSeek Harness（Web / Desktop）加的 OpenCode 风格浏览与审查插件：左侧看文件，中间看会话，右侧审查变更。

## 界面

### 左侧栏 — 工作区 | 文件

头栏变成 **[工作区 | 文件]**，和原生搜索 / 筛选 / 新建同一行。

| 模式 | 做什么 |
| --- | --- |
| 工作区 | 原生会话分组、搜索、新建、打开目录。可开启**按最后会话时间排序**（设置 → 插件 → DSH-Explorer，默认开）：谁有会话活动谁顶到最前，口径与宿主 recentWorkspace 一致（取工作区里会话的最大 updatedAt，无会话回退 createdAt），通过宿主拖拽排序同一 API 落到持久注册顺序——重启后仍保留。**自定义指针拖拽**（按住行移动 5px 进入，ghost 跟随 + 插入指示线，不依赖原生 HTML5 拖拽）：普通区拖动 = 把该工作区钉在落点（不再跟时间流动，其他项照常流动，锚点消失自动回归时间流）。支持**置顶分区**：拖到最顶即置顶（置顶行有左侧色条），拖到普通区某处即钉住/取消置顶；置顶与普通两段各自跟时间排，置顶区内拖动可固化自定义顺序；设置卡里可清除手动定位、让置顶恢复按时间排序 |
| 文件 | 以当前会话工作目录为根的文件树（惰性展开，按类型显示图标；**单层超 120 条折叠为「显示全部」**，防大目录撑爆切换帧）。树自动跟随磁盘变化（3s 指纹轮询），**展开状态按工作目录记忆**（localStorage，切会话 / 刷新页面后错峰分批恢复）；右键文件 / 文件夹 / 空白处可打开编辑、预览、**新建文件 / 新建文件夹**、复制路径。点回「工作区」即卸掉文件树，原生会话栏原样恢复 |

未 fork 顶部座位时，同一组 tab 会画在侧栏底部，切换逻辑相同。

### 中栏 — 摘要

会话头部 utilities（开合按钮始终钉在这里，不会跑到右侧 tab 上）：

- **置顶摘要**：Codex 风格环境卡片，含变更（`+N / -N`，**计入未跟踪文件**，点击打开右侧**审查**）、切分支、提交 / 推送、比较分支（有 GitHub remote 时同时打开 compare）、来源。没有「本地」项。
- **终端**：右上角底栏按钮。点开在对话列下方展开终端，默认进当前会话工作目录；支持多标签、`+` 新建、关闭标签。收起面板不断开进程。窗口缩放 / 拖高度 / 切标签都会把实测尺寸同步到 PTY 内核（`pty.resize`，旧宿主自动降级为纯本地 resize；瞬时上报失败会重试，连续 3 次失败后停发降级）；输出流被掐断时自动提示并指数退避重连（进程保活，最多 5 次；重连成功后自动补一次尺寸重同步）。
- **面板**：开关右侧栏。

宽屏且右侧栏收起时，摘要钉在对话右侧，点窗外不收。右侧栏拉开或中栏变窄后改成悬浮窗，点窗外或 Esc **只收摘要，不关右侧栏**。

### 右侧栏 — 审查 / 上下文 / 文件

嵌入官方 details 列。右侧栏状态**全部按会话记忆**：只有你显式打开过右栏的会话，切回来才自动恢复（rAF 后直接写入宿主布局 store，宽度用 ResizeObserver 实测落盘——官方拖拽不经过任何包装层，实测是唯一可靠来源）；其他会话保持关闭不弹开；文件 tab 和当前激活页也只属于各自打开它们的会话（`localStorage: dsh-explorer:panel-sessions` 记录打开过的会话集合）。右栏收起期间文件跟随轮询自动暂停（宿主关列仍保留挂载）。常驻 **审查**、**上下文**；从摘要可打开 **来源**；点文件则多出编辑 / 预览 tab。

**审查**（Git 变更 / 上一回合变更 / 分支变更）：

- 面板顺序：未跟踪文件 → Diff → 其他文件。三个面板默认折叠，开合状态记在 `localStorage`。未跟踪文件的全文预览限前 100 个、单文件 ≤ 128KB（超出仅列清单不带正文）。
- 列表只拉路径；点到某个文件才拉该文件的 patch，文件列表和 diff 都虚拟滚动。
- 切到上下文 / 编辑等 tab 再回来，审查页不卸载，立刻显示上次结果，git 在后台刷新。
- **上一回合变更**：上一个 Agent 回合（`turn/start` → `turn/end`）里产生的文件变更，回合结束时冻结。快照或单个 patch 被截断时响应带 `truncated` 标志，界面给出可见提示，不再静默缺文件。
- **分支变更**：当前分支相对基准（`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`）的差异和提交列表。

**上下文**：**上下文使用率**（读官方 `contextPressure` 投影：分子取 `projectedTokens`，回落 `pressureTokens`）、会话概览（Goal / 计划模式 / 工作目录 / 预设）和模型上下文清单（System prompt 节 / 动态上下文 / 工具 / 提示词变量）。

**来源**：当前会话引用 / 搜到的页面与内容。

**文件 tab**：编辑器（Ctrl+S 保存、脏标记）、Markdown 预览（渲染异常有错误边界兜底，不会白屏面板）、HTML 沙箱预览。**打开中的 tab 都自动跟随文件更新**（约 2 秒轮询：优先 `fs.stat` 指纹，宿主未升级时自动回退 `fs.list` 父目录条目，两种宿主都能跟随）：预览 / 查看态静默重读；编辑态无未保存修改也自动套用；正在编辑时轮询照常（只探指纹不重读内容），磁盘有变化即弹「文件已在磁盘上被修改」提示条，由你决定载入或忽略，绝不覆盖正在写的内容；切走再切回的 tab 会与记录的基准指纹比对，切走期间的磁盘变化同样能看到。保存带版本基线（宿主支持时）：文件已被外部改过则保存被拒并当场提示；在提示条上确认「覆盖外部改动」的保存跳过版本检查直接写。自己保存后基准重建，不会把保存误判为外部修改。对话里点工具行上的文件路径**不再进本插件**——0.1.2 起官方改走远端 `session/openWorkspacePath` 交系统默认程序打开（另见官方 `ui-deliverables` 的产物行与行内文件链接），本插件原来的本地 opener 包装点已随官方删除而消失。

## 快速开始

需要 Node.js ≥ 22、pnpm，以及能跑的 `dsh web`。

```powershell
git clone <仓库地址> DSH-Explorer
cd DSH-Explorer
pnpm plugin:install                 # 构建 + 自检 + junction + patch 行
pnpm plugin:install --fork-ui       # 额外：放宽右侧栏宽度 + 工作区顶部动作条座位
```

然后 **重启 `dsh web`**（Host 半边只有重启才会加载），再刷新页面。

包已声明 `dsh.bundle`（[`cordis.patch.yml`](./cordis.patch.yml)）。也可以走官方安装：

```powershell
dsh plugin --profile web add <本仓库路径>
```

这会把包写进 profile 的 `dsh.profile.bundles`。`pnpm plugin:install` 仍是本机捷径：junction + 直接写 profile 的 `cordis.patch.yml` 行，不必经过 `dsh plugin add`。

构建挂在 `prepack`（`pnpm pack` / 发布打包前自动构建，`--prod` 安装不再触发构建失败）；git / 本地路径直装不会自动触发构建——`pnpm plugin:install` 会自检并按需补构建，手工安装请先 `pnpm run build`。

应能看到：左侧 **[工作区 | 文件]**、会话头 **摘要 / 终端 / 面板**、右侧 **审查 / 上下文**。

常用参数：`--profile <name>`（默认 `web`）、`--harness <path>`、`--rebuild`、`--dry-run`。

### 卸载

```powershell
pnpm plugin:uninstall                # 去掉 patch 行和 junction，同时回退宽度与座位两类 fork
pnpm plugin:uninstall --keep-fork    # 保留宽度与座位两类 fork 改动
pnpm plugin:uninstall --dry-run
```

卸载后建议再重启一次 `dsh web`。

### 改动能不能只刷新？

| 改了什么 | 怎么生效 |
| --- | --- |
| 客户端 UI（`src/client/`） | `pnpm run build` 后刷新页面 |
| Host RPC / 终端 PTY（`src/index.ts`、`src/pty.ts`） | 必须重启 `dsh web` / 桌面壳。运行中的进程会缓存已加载的插件模块 |

### DSH 版本兼容性

| 宿主版本 | 状态 |
| --- | --- |
| 0.1.1-rc.2（上一代桌面载荷） | ✅ 已验证：RPC 路由 / 设置命名空间 / 全部槽位 / 载荷 fork |
| 0.1.2-rc.1（**当前桌面载荷**，2026-09-06 起） | ✅ 已实测：Host 半边在线（`/dsh-explorer/rpc` 带自定义头 + 回环 Origin → 200、缺 Origin → 403、未知路径 → 404）；载荷 fork 自愈**已在新载荷上重打**（`clampWidth(…,300,1200)` + 标记，`client.js.dshx-orig` 仍是干净的 `300,520` 原文）；6 个槽位在载荷 bundle 中全部命中（`header.utilities`×2、`details`×51、`footer.action`×3）；`dsh-client-runtime` 与 `workspaces.openPath` 在载荷中均为 0 命中，按下述设计降级 |
| 0.1.2-alpha.1 ～ alpha.5（上游，源码审计） | ✅ 已适配（见下） |

**升级到 0.1.2-rc.1 后用户可见的变化**：对话里点文件路径不再进 Explorer 的编辑器 tab——0.1.2 把打开改走远端 `session/openWorkspacePath`，本地面 `workspaces.openPath` 已删除，包装点消失（官方改由 `session/openWorkspacePath` 交系统默认程序打开，另见官方 `ui-deliverables` 的产物行与行内文件链接）。`openWithSystem`（右键「用系统默认程序打开」）经远端回退仍可用，插件自有 RPC `fs.openExternal` 仍是最终兜底。文件树 / 审查 / 摘要里的入口不受影响。

0.1.2 把 client-runtime 的客户端半边整体拆进领域包（`slots`→ui-renderer、`sessions`→api-session-controller、`workspaces`→api-workspace-controller，`dsh-client-runtime` 包删除）。对本插件的影响与处理：

- `package.json` 的 `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime`：0.1.2 加载器对图里不存在的包名**静默跳过**，声明可保留，两代宿主都无需修改；
- **`workspaces.openPath` 本地面删除**（打开改走远端 `remote.session.openWorkspacePath`）：`chatFileOpen` 已改为特性检测——旧宿主继续包装本地 opener 拦截对话路径点击；新宿主跳过拦截（路径点击回落宿主默认行为），`openWithSystem` 自动回落远端通道，再往后还有插件自有 RPC `fs.openExternal` 兜底；
- 其余集成面在 0.1.2 源码中全部幸存：6 个槽位名（`details`、`sidebar.workspaces(.actions)`、`sidebar.footer.action`、`conversation.session.header.utilities`、`settings.plugin.item`——后者声明挪到 ui-settings-plugins 但契约不变）、`sessions.list` 形状与可选方法、`workspaces.insertBefore`、`layout`、`webServer.register`、fs 服务 API、`settings.register`、`session/event`、沙箱 `danger-full-access` 模式、载荷 fork 的钳制点位（源码未动，构建产物仍是字面量 `300, 520`）。

`pnpm run verify` 里有对应回归用例（`0.1.2 compat: apply survives missing workspaces.openPath`）。

### 接入规范符合性

按官方 `packages/client/AGENTS.md` 的接入规范核对本插件：

| 规范要求 | 状态 |
| --- | --- |
| `dsh.client` 声明（`platform: 'web'` + `./client` 导出 + `inject` 包名边） | ✅ `inject` 已从被删除的 `dsh-client-runtime` 改为真实消费的四个包：`ui-renderer`（`slots`）、`ui-layout`（`layout`）、`api-session-controller`（`sessions`）、`api-workspace-controller`（`workspaces`）。规范明确 `inject` 只是信息性依赖边，不参与激活排序 |
| 占用他人槽位走 `ctx.slots.inject(name, …)` | ✅ 六处座位全部如此（含 `settings.plugin.item`） |
| Cordis 服务 inject 名与宿主一致 | ✅ 四个客户端服务名在 0.1.2 载荷 bundle 中逐一确认仍被注册（`ui-renderer` 提供 `slots`、`ui-layout` 提供 `layout`、`api-*-controller` 提供 `sessions`/`workspaces`）。注意 `uiWorkspace` 是官方新增的 UI 高层服务，与本插件消费的 `workspaces` 并存 |
| Host 半边经 `dsh.bundle.patch` 注册 | ✅ 0.1.2 仍是树外插件的正规通道（`dsh plugin add` 会把声明的 `dsh.bundle` 包并入 profile 层栈） |
| 状态全部 JSON 兼容 | ✅ store 内数据均为纯 JSON（`sessionActive` / `termBags` 用普通对象而非 Map） |
| store 座位：`defineStore` 句柄在 apply 构造、register 以 `store:` 声明，组件读 `props.useStore`、写 `props.actions` | ⚠️ **有意偏离（经确认不做）**：官方 `ui-slots` 强制「一个句柄只能挂一个 scope」——同句柄挂到不同 scope 会在 register 时抛错（源码断言：`store handle mounted under "X" (scope "session") is already mounted under scope "root" — one handle, one scope`）。而本插件同时占用 **root** 座位（`sidebar.workspaces`、`sidebar.footer.action`、`settings.plugin.item`）与 **session** 座位（`details`、`conversation.session.header.utilities`），所以单店无法整体搬到 store 座位；需拆成 root store + session store，并为跨层事实（`filesMode` / `terminalOn` / `panelOpen` 等）加一层桥接。这是行为等价性重构，且**不能半个半个切**（组件改用 `props.useStore` 后与仍传 `store` 的 `index.tsx` 不匹配，而 `as never` 注册让 TypeScript 查不出来 —— 表现为"typecheck 绿、刷新即崩"）。**经与你确认，本项不做，作为第三项有意偏离收尾**；拆店脚手架（两个已通过 typecheck 的 `defineStore` 句柄 `storeRoot.ts` / `storeSession.ts`，**尚未接线**）与完整工序留在仓库备用，方案见 [`docs/store-seat-migration.md`](./docs/store-seat-migration.md) |

**有意偏离（README 明确标注，不做隐藏）**：

1. **右侧栏宽度**：官方 0.1.2 的 `ctx.layout` 只公开 `openDetails` / `closeDetails` / `toggleSidebar`，**没有任何宽度扩展点**，且源码注释写明 `attachPanels` 是 root-entry 专用装配钩子。因此宽度功能走的是绕开官方的两条路——`src/payloadFork.ts` 启动时把官方载荷里的 `clampWidth(details, 300, 520)` 改成 `300, 1200`；`src/client/detailsWidth.ts` 改 layout 服务原型以记住拖拽宽度。这是插件层的 fork，不是官方扩展点。
2. **`/client` 导出**：规范要求 `/client` 只导出 `apply` / `inject`（+ 类型）。本插件额外导出若干测试钩子，支撑 `scripts/smoke.mjs` 里约 300 行工作区排序 / 置顶回归断言；规范条款本身允许「用户签署豁免」，此处按保留处理。
3. **store 座位（组件读 `props.useStore` / 写 `props.actions`）**：官方强制「一个句柄只能挂一个 scope」，而本插件座位横跨 root 与 session 两类，因此必须拆成两个店 + 跨层桥接才能搬过去。该改造牵动 15 个文件且**无法安全拆分**（中途态 typecheck 绿但运行时崩），已按确认**不做**，列为第三项有意偏离。脚手架与逐文件工序见 [`docs/store-seat-migration.md`](./docs/store-seat-migration.md)。

### 0.1.2 起已删除的功能（官方已实现，故移除）

| 删除项 | 官方承担者 |
| --- | --- |
| 上下文面板里的 **ToDo** | `ui-conversation` 的 `TodoPanel`（composer dock，带状态计数与折叠） |
| 上下文面板里的 **Token 消耗** | `ui-chat` 的 `TurnUsagePanel`（回合级 usage 展开行；官方无会话级聚合） |
| **子智能体**面板 | `ui-subagent`（header lineage 面包屑 → 完整后代目录 + token/时长 + 继续会话） |
| 对话左侧 **会话大纲**（MessageRail） | `session-turn-outline` + `ui-chat` 的 turn rail / TurnNavigator |
| 对话点文件路径**拦截**进编辑器 tab | 官方 `session/openWorkspacePath`（交系统默认程序打开）+ `ui-deliverables` 产物行与行内文件链接 |

同步删掉了只为这些面板服务的 Host RPC（`todo.list`、`session.tokenUsage`、`session.subagents`、`session.transcript`）与 `src/client/faces.ts` 里的子智能体目录动作。

## 开发

```bash
pnpm install
pnpm run build       # 产出 lib/index.js + lib/client.js
pnpm run watch       # 开发时增量构建
pnpm run typecheck
pnpm run verify      # 冒烟：按运行时方式真正执行两个 bundle
pnpm run selfcheck    # Markdown 渲染 + 高亮器语法自检（104 项断言）
```

`verify` 会：

- Host：按 cordis Loader 的方式 `require('dsh-explorer')`，断言带 `inject` 的插件对象；
- 浏览器：模拟 `window.__ModuleLoader__.load`，注入真实 React 后执行工厂；
- 抽测 RPC 闸：同源回环 OPTIONS / POST 放行、跨源拒绝、无自定义头 POST 拒绝、缺 Origin 拒绝、DNS rebinding（Host 同源但非回环）拒绝；
- 断言路由挂载：`webServer.register` 实际收到 `/dsh-explorer/rpc` 与 `/dsh-explorer/pty` 的 exact 路径 / kind（防止 register 被吞掉仍全绿）；
- 抽测 `unquotePath`：C 风格八进制转义还原中文文件名（git `core.quotePath` 路径解码）；
- 抽测载荷自愈钩子：补丁 / 幂等 / 跳过 / 缺载荷 / **max 漂移按标记重打** / 半命中不写不落标 / 污染备份重打前刷新；
- 断言 `dsh.bundle.patch` 与客户端工厂内联了 `.dshx-root` 样式（不能再 `require` 独立 CSS 文件）。

客户端 bundle 的 `exports` 垫片写在 tsdown `banner` 里（`intro` 会被静默丢掉）。缺这一步时浏览器会 `exports is not defined`，整页 Failed to load plugins，所以发版前务必 `verify`。

## 架构

```
src/index.ts             Host：POST /dsh-explorer/rpc（cwd 围栏 + 写路径符号链接逐组件校验）
src/payloadFork.ts       Host：载荷自愈钩子（启动时补桌面壳 ui-layout 宽度钳制）
src/pty.ts               Host：会话 cwd 里的用户 PTY（/dsh-explorer/pty 流；有界背压泵 + 死会话差量回收）
src/settingsNs.ts        Host：schemastery 形 schema（值仍走浏览器 localStorage）
src/client/index.tsx     浏览器：apply 里建 store，插槽只注入句柄和回调
src/client/explorer.module.css  全局 `dshx-*` 样式（打进 client 工厂的 style 标签）
src/client/…             审查、摘要、文件树、编辑器、来源、终端
lib/index.js             Host bundle
lib/client.js            浏览器 bundle（window.__ModuleLoader__ 工厂）
cordis.patch.yml         `dsh.bundle` 层：插入 id/name `dsh-explorer`
scripts/install.mjs      安装器（junction 捷径）
scripts/smoke.mjs        verify 冒烟
```

浏览器半边经 `package.json` 的 `dsh.client` 由模块表扫描加载；Host 半边靠 `dsh.bundle.patch` 指向的 [`cordis.patch.yml`](./cordis.patch.yml)（`dsh plugin add` 会把本包列入 `dsh.profile.bundles`）。`pnpm plugin:install` 仍会把同一行写进 profile 的 patch。手册示例见 [`cordis.patch.example.yml`](./cordis.patch.example.yml)。

注意：`./client` 导出（`lib/client.js`）是浏览器专属产物，仅供壳的 `window.__ModuleLoader__` 以工厂形式消费，Node 侧不可直接 require / import（没有 `exports` 垫片与模块表，加载即报错）。

### 插槽

| 座位 | 用途 |
| --- | --- |
| `details`（priority -10） | 盖住官方工具详情，渲染审查 / 上下文 / 文件 tab |
| `sidebar.workspaces.actions` | 「工作区 \| 文件」，portal 进浏览区头栏；未 fork 时底部 `sidebar.footer.action` 回退 |
| `sidebar.workspaces` | 仅文件模式动态占用，离开即 dispose |
| `conversation.session.header.utilities` | 摘要、终端、右侧栏开关 |
| `settings.plugin.item` | 设置 → 插件配置：终端配色 / 字号 / 字体（Host 命名空间 `dsh-explorer`） |

### RPC（`POST /dsh-explorer/rpc`）

必须带自定义头 `x-dsh-explorer: 1`（触发浏览器 preflight，跨站过不了闸）。闸内再做**同源回环 Origin 校验**（防 DNS rebinding）：`Origin` 必须与 `Host` 同源且主机名在回环白名单（`127.0.0.1` / `localhost` / `::1`）；跨源、缺 `Origin`、「同源但非回环」一律 403。

| 方法 | 作用 |
| --- | --- |
| `fs.list` / `fs.read` / `fs.write` | 会话 cwd 内的树与读写。`fs.write` 带 CAS：携带读取时的 `expected` 版本指纹，版本不符拒绝保存；响应返回新 `version` 供基准重建；不传 `expected` 即显式确认覆盖 |
| `fs.stat` | 文件版本指纹（version + size），跟随刷新用；客户端在宿主缺失该方法时自动回退 fs.list 指纹 |
| `fs.create` | 新建文件 / 文件夹（文件树右键；文件复用 writeText 自动补父目录，目录走 shell mkdir） |
| `fs.reveal` / `fs.openExternal` | 用资源管理器打开所在目录；用系统默认程序打开文件 |
| `pty.open` / `pty.write` / `pty.resize` / `pty.close` | 终端：开进程（带初始 cols/rows）、写输入、**同步内核终端尺寸**（窗口缩放 / 拖高度 / 切标签后 fit 实测直传；旧宿主无此方法时客户端静默降级为纯本地 xterm resize）、关进程 |
| `git.status` / `git.diff` / `git.fileDiff` | 状态、变更文件列表、按文件懒加载 patch。git 失败时错误原样传播（坏仓库不再显示成「工作区干净」）；`git.fileDiff` 响应带 `truncated` 标志 |
| `git.branch` / `git.lastRound` | 相对基准分支的差异；上一回合冻结快照（`git.lastRound` 响应带 `truncated` 标志：快照期 diff 被截断时可见提示） |
| `git.summary` / `git.checkout` / `git.commit` / `git.push` | 摘要卡片上的分支与提交。`+N / -N` 计入未跟踪文件；提交说明含 `"` `` ` `` `$` `\` 字符会被显式拒绝（提示用户修改），不再静默删改 |
| `context.meta` | 模型上下文清单（System prompt 节 / 动态上下文 / 工具 / 提示词变量） |
| `session.meta` / `session.sources` | 会话元数据、来源（当前会话引用 / 搜到的页面） |

所有路径操作限制在当前会话 `cwd` 内；文件树不列出 `.git`。

## Harness fork（可选）

插件层绕不过的两处，用 fork 补座位 / 放宽列宽。文件内都有 `FORK` 标记。升级 DSH 会覆盖这些改动，再跑一次 `pnpm plugin:install --fork-ui` 即可重打。

### 右侧栏宽度

官方 `DETAILS_MAX = 520`。`--fork-width` / `--fork-ui` 改成 1200。插件本身会把拖拽宽度记到 `localStorage['dsh-explorer:details-width']`，关掉再开右侧栏会恢复；没有宽度 fork 时仍被官方 520 卡住。重建：

```bash
cd deepseek-harness
pnpm --filter @deepseek-ai/dsh-client-ui-layout run bundle
```

实际宽度仍受让步链约束（中心列 ≥ 640px），1920 屏 + 280 侧栏大约能拖到 ~1000px。

**DSH Desktop**：吃的是 npm `@deepseek-ai/dsh` 载荷，不是本机 harness 工作树。`--fork-width` 对已装的桌面壳无效。桌面壳 titlebar.js 里的运行时改写也不可靠：client-modules 系统启动时用 `target.load = …` 原地接管队列 loader，注入的模块加载包装会被冲掉，动态加载的 ui-layout 走不到改写。真正兜底的是下面的**载荷自愈钩子**。

### 载荷自愈钩子（桌面壳更新后自动重打）

`src/payloadFork.ts` 挂在插件启动上：dsh-explorer 的 host 半边在 `dsh web` / 桌面壳进程里 apply 时，趁页面还没拉任何客户端 bundle，直接把磁盘上 `@deepseek-ai/dsh-client-ui-layout/lib/client.js` 里的 `clampWidth(…, 300, 520)` 两处点位改成 `300, 1200`。服务器按内容哈希生成 bundle rev，所以重启桌面壳（或 `dsh web`）后刷新页面即可生效。

- **幂等（全有或全无）**：文件尾有 `dsh-explorer payload fork` 标记就跳过；两处钳制点位必须全部命中才写，部分命中 / 上游改形只记录不写、不落标记——不会出现「标记已落但补丁半生效」的静默无效态。
- **可回退**：留 `client.js.dshx-orig` 原始备份；检测到备份被污染（含补丁标记）或陈旧（桌面壳更新后残留旧版）时，重打前自动刷新为当前原文，按备份回退永远得到干净上游版本。
- **不阻塞**：定位 / 读写任何一步失败都只打日志（`[dsh-explorer:payload-fork]`），插件照常加载。
- **可扩展**：`ForkSpec` 结构（定位 + 文本重写），以后要补 ui-sidebar 动作条座位之类再加一条。
- 定位顺序：`DSH_EXPLORER_PAYLOAD_ROOT`（分号分隔多个根）→ `DSH_PAYLOAD_DIR`（桌面壳自己的覆盖变量）→ `require.resolve`（沿 CLI 入口）→ 从 cwd / argv / execPath 向上爬 `node_modules`。

`pnpm run verify` 的 smoke 里有整条路径的用例（补丁 / 幂等 / 跳过 / 缺载荷 / 半命中 / 备份刷新）。

### 工作区顶部动作条

官方侧栏没有 `sidebar.workspaces.actions`。`--fork-ui` 给 ui-sidebar 加这个座位，插件把 **[工作区 | 文件]** portal 进头栏同一行。重建：

```bash
pnpm --filter @deepseek-ai/dsh-client-ui-sidebar run bundle
```

空座位会整条隐藏，卸载时保留也无害。

## 行为与限制

- git 调用显式带「当前会话 + full-access」沙箱策略。不加的话，沙箱会落到 `dsh web` 启动目录；会话 cwd 在启动目录之外时，所有 git 会表现为「不是 Git 仓库」。
- 编辑器保存视为用户显式写入（full-access），仍受会话目录边界约束。写路径对符号链接做逐组件校验：断链或指向工作目录外的链接拒绝跟随写入，围栏内的正常链接（如 pnpm workspace 的 `node_modules`）放行。
- 超过 2MB 不提供编辑 / 预览；二进制读失败会提示。
- Markdown 预览是内置轻量渲染：标题（ATX / Setext）、表格（含对齐）、多级有序 / 无序 / 任务列表、嵌套引用、围栏 / 缩进代码块（**带语法高亮**与语言徽章）、front matter、脚注、引用链接、自动链接（裸 URL / `<url>` / 邮箱）、`__粗体__` `*斜体*` `~~删除~~` `==高亮==`、转义与实体透传、无属性白名单行内 HTML（`<br>` `<kbd>` 等）、`$$数学$$`。原始 HTML 一律按文本显示，URL 只放行安全协议。
- HTML 预览在 `sandbox=""` 的 iframe 里，不执行脚本。
- 终端进程闲置 10 分钟自动回收；所属会话关闭后 1 分钟内也会被差量检测回收（重开标签即新建进程）。宿主重启后旧进程不可挂回，终端面板会自动开新进程替代。

### 手动安装（排查用）

1. `pnpm install && pnpm run build && pnpm run verify`
2. 建 junction，指向本项目目录：
   - `%DSH_HOME%\profiles\node_modules\dsh-explorer`
   - `%DSH_HOME%\profiles\<profile>\node_modules\dsh-explorer`
   - `<harness>\apps\cli\node_modules\dsh-explorer`
3. 在 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 追加 `- insert: [{id: dsh-explorer, name: dsh-explorer}]`
4. 重启 `dsh web`，刷新页面
