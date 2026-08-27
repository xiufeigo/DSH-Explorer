# DSH-Explorer

> 声明：本项目是纯 vibecoding 做出来的，由 Cursor + Grok 4.6 制作。

给 DeepSeek Harness（Web / Desktop）加的 OpenCode 风格浏览与审查插件：左侧看文件，中间看会话，右侧审查变更。

## 界面

### 左侧栏 — 工作区 | 文件

头栏变成 **[工作区 | 文件]**，和原生搜索 / 筛选 / 新建同一行。

| 模式 | 做什么 |
| --- | --- |
| 工作区 | 原生会话分组、搜索、新建、打开目录。可开启**按最后会话时间排序**（设置 → 插件 → DSH-Explorer，默认开）：谁有会话活动谁顶到最前，口径与宿主 recentWorkspace 一致（取工作区里会话的最大 updatedAt，无会话回退 createdAt），通过宿主拖拽排序同一 API 落到持久注册顺序——重启后仍保留；排序期间手动拖拽会被覆盖，关闭开关即恢复原生的「新开文件夹置顶 + 手动拖拽」顺序 |
| 文件 | 以当前会话工作目录为根的文件树（惰性展开，按类型显示图标；**单层超 120 条折叠为「显示全部」**，防大目录撑爆切换帧）。树自动跟随磁盘变化（3s 指纹轮询），**展开状态按工作目录记忆**（localStorage，切会话 / 刷新页面后错峰分批恢复）；右键文件 / 文件夹 / 空白处可打开编辑、预览、**新建文件 / 新建文件夹**、复制路径。点回「工作区」即卸掉文件树，原生会话栏原样恢复 |

未 fork 顶部座位时，同一组 tab 会画在侧栏底部，切换逻辑相同。

### 中栏 — 大纲与摘要

会话头部 utilities（开合按钮始终钉在这里，不会跑到右侧 tab 上）：

- **会话大纲**：对话左侧列出每条用户消息，点击跳到对应气泡。
- **置顶摘要**：Codex 风格环境卡片，含变更（`+N / -N`，点击打开右侧**审查**）、切分支、提交 / 推送、比较分支（有 GitHub remote 时同时打开 compare）、子智能体、来源。没有「本地」项。
- **终端**：右上角底栏按钮。点开在对话列下方展开终端，默认进当前会话工作目录；支持多标签、`+` 新建、关闭标签。收起面板不断开进程。
- **面板**：开关右侧栏。

宽屏且右侧栏收起时，摘要钉在对话右侧，点窗外不收。右侧栏拉开或中栏变窄后改成悬浮窗，点窗外或 Esc **只收摘要，不关右侧栏**。

### 右侧栏 — 审查 / 上下文 / 文件

嵌入官方 details 列。右侧栏状态**全部按会话记忆**：只有你显式打开过右栏的会话，切回来才自动恢复（rAF 后直接写入宿主布局 store，宽度用 ResizeObserver 实测落盘——官方拖拽不经过任何包装层，实测是唯一可靠来源）；其他会话保持关闭不弹开；文件 tab 和当前激活页也只属于各自打开它们的会话（`localStorage: dsh-explorer:panel-sessions` 记录打开过的会话集合）。右栏收起期间文件跟随轮询自动暂停（宿主关列仍保留挂载）。常驻 **审查**、**上下文**；从摘要可打开 **子智能体**、**来源**；点文件则多出编辑 / 预览 tab。

**审查**（Git 变更 / 上一回合变更 / 分支变更）：

- 面板顺序：未跟踪文件 → Diff → 其他文件。三个面板默认折叠，开合状态记在 `localStorage`。
- 列表只拉路径；点到某个文件才拉该文件的 patch，文件列表和 diff 都虚拟滚动。
- 切到上下文 / 编辑等 tab 再回来，审查页不卸载，立刻显示上次结果，git 在后台刷新。
- **上一回合变更**：上一个 Agent 回合（`turn/start` → `turn/end`）里产生的文件变更，回合结束时冻结。
- **分支变更**：当前分支相对基准（`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`）的差异和提交列表。

**上下文**：上方 ToDo（读会话 `todo/write`），下方会话概览（Goal / 计划模式 / 工作目录 / 预设）和模型上下文清单。

**子智能体**：当前会话全部子智能体；点一条在右侧栏看该子会话，不切换中间主对话。

**来源**：当前会话引用 / 搜到的页面与内容。

**文件 tab**：编辑器（Ctrl+S 保存、脏标记）、Markdown 预览、HTML 沙箱预览。**打开中的 tab 都自动跟随文件更新**（约 2 秒轮询：优先 `fs.stat` 指纹，宿主未升级时自动回退 `fs.list` 父目录条目，两种宿主都能跟随）：预览 / 查看态静默重读；编辑态无未保存修改也自动套用，有未保存修改则显示「文件已在磁盘上被修改」提示条，由你决定载入或忽略，绝不覆盖正在写的内容；自己保存后基准重建，不会把保存误判为外部修改。对话里点 Read / Write / Edit 等工具行上的文件路径，会在右侧栏打开（图片等二进制仍走系统打开）。

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

应能看到：左侧 **[工作区 | 文件]**、会话头 **摘要 / 终端 / 面板**、对话左侧消息大纲、右侧 **审查 / 上下文**。

常用参数：`--profile <name>`（默认 `web`）、`--harness <path>`、`--rebuild`、`--dry-run`。

### 卸载

```powershell
pnpm plugin:uninstall                # 去掉 patch 行和 junction，并回退宽度 fork
pnpm plugin:uninstall --keep-fork    # 保留宽度 fork
pnpm plugin:uninstall --dry-run
```

卸载后建议再重启一次 `dsh web`。

### 改动能不能只刷新？

| 改了什么 | 怎么生效 |
| --- | --- |
| 客户端 UI（`src/client/`） | `pnpm run build` 后刷新页面 |
| Host RPC / 终端 PTY（`src/index.ts`、`src/pty.ts`） | 必须重启 `dsh web` / 桌面壳。运行中的进程会缓存已加载的插件模块 |

## 开发

```bash
pnpm install
pnpm run build       # 产出 lib/index.js + lib/client.js
pnpm run watch       # 开发时增量构建
pnpm run typecheck
pnpm run verify      # 冒烟：按运行时方式真正执行两个 bundle
node scripts/md-selfcheck.mjs   # Markdown 渲染 + 高亮器语法自检（61 项断言）
```

`verify` 会：

- Host：按 cordis Loader 的方式 `require('dsh-explorer')`，断言带 `inject` 的插件对象；
- 浏览器：模拟 `window.__ModuleLoader__.load`，注入真实 React 后执行工厂；
- 顺带抽测 RPC 跨站闸（同源 OPTIONS、跨源拒绝、无自定义头 POST 拒绝）；
- 断言 `dsh.bundle.patch` 与客户端工厂内联了 `.dshx-root` 样式（不能再 `require` 独立 CSS 文件）。

客户端 bundle 的 `exports` 垫片写在 tsdown `banner` 里（`intro` 会被静默丢掉）。缺这一步时浏览器会 `exports is not defined`，整页 Failed to load plugins，所以发版前务必 `verify`。

## 架构

```
src/index.ts             Host：POST /dsh-explorer/rpc
src/payloadFork.ts       Host：载荷自愈钩子（启动时补桌面壳 ui-layout 宽度钳制）
src/pty.ts               Host：会话 cwd 里的用户 PTY（/dsh-explorer/pty 流）
src/settingsNs.ts        Host：schemastery 形 schema（值仍走浏览器 localStorage）
src/client/index.tsx     浏览器：apply 里建 store，插槽只注入句柄和回调
src/client/explorer.module.css  全局 `dshx-*` 样式（打进 client 工厂的 style 标签）
src/client/…             审查、摘要、文件树、编辑器、子智能体、来源、终端
lib/index.js             Host bundle
lib/client.js            浏览器 bundle（window.__ModuleLoader__ 工厂）
cordis.patch.yml         `dsh.bundle` 层：插入 id/name `dsh-explorer`
scripts/install.mjs      安装器（junction 捷径）
scripts/smoke.mjs        verify 冒烟
```

浏览器半边经 `package.json` 的 `dsh.client` 由模块表扫描加载；Host 半边靠 `dsh.bundle.patch` 指向的 [`cordis.patch.yml`](./cordis.patch.yml)（`dsh plugin add` 会把本包列入 `dsh.profile.bundles`）。`pnpm plugin:install` 仍会把同一行写进 profile 的 patch。手册示例见 [`cordis.patch.example.yml`](./cordis.patch.example.yml)。

### 插槽

| 座位 | 用途 |
| --- | --- |
| `details`（priority -10） | 盖住官方工具详情，渲染审查 / 上下文 / 文件 tab |
| `sidebar.workspaces.actions` | 「工作区 \| 文件」，portal 进浏览区头栏；未 fork 时底部 `sidebar.footer.action` 回退 |
| `sidebar.workspaces` | 仅文件模式动态占用，离开即 dispose |
| `conversation.session.header.utilities` | 摘要、终端、右侧栏开关、会话大纲 |
| `settings.plugin.item` | 设置 → 插件配置：终端配色 / 字号 / 字体（Host 命名空间 `dsh-explorer`） |

### RPC（`POST /dsh-explorer/rpc`）

必须带自定义头 `x-dsh-explorer: 1`（触发浏览器 preflight，跨站过不了闸）。

| 方法 | 作用 |
| --- | --- |
| `fs.list` / `fs.read` / `fs.write` | 会话 cwd 内的树与读写 |
| `fs.stat` | 文件版本指纹（version + size），跟随刷新用；客户端在宿主缺失该方法时自动回退 fs.list 指纹 |
| `fs.create` | 新建文件 / 文件夹（文件树右键；文件复用 writeText 自动补父目录，目录走 shell mkdir） |
| `fs.reveal` / `fs.openExternal` | 用资源管理器打开所在目录；用系统默认程序打开文件 |
| `git.status` / `git.diff` / `git.fileDiff` | 状态、变更文件列表、按文件懒加载 patch |
| `git.branch` / `git.lastRound` | 相对基准分支的差异；上一回合冻结快照 |
| `git.summary` / `git.checkout` / `git.commit` / `git.push` | 摘要卡片上的分支与提交 |
| `todo.list` / `context.meta` | ToDo 与模型上下文清单 |
| `session.meta` / `session.sources` / `session.subagents` / `session.transcript` | 会话元数据、来源、子智能体、子会话内容 |

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

- **幂等**：文件尾有 `dsh-explorer payload fork` 标记就跳过；找不到 520 点位（源码 fork 已在、上游改形）也只记录不写。
- **可回退**：首补时留 `client.js.dshx-orig` 原始备份；卸载插件后可手工还原。
- **不阻塞**：定位 / 读写任何一步失败都只打日志（`[dsh-explorer:payload-fork]`），插件照常加载。
- **可扩展**：`ForkSpec` 结构（定位 + 文本重写），以后要补 ui-sidebar 动作条座位之类再加一条。
- 定位顺序：`DSH_EXPLORER_PAYLOAD_ROOT`（分号分隔多个根）→ `DSH_PAYLOAD_DIR`（桌面壳自己的覆盖变量）→ `require.resolve`（沿 CLI 入口）→ 从 cwd / argv / execPath 向上爬 `node_modules`。

`pnpm run verify` 的 smoke 里有整条路径的用例（补丁 / 幂等 / 跳过 / 缺载荷）。

### 工作区顶部动作条

官方侧栏没有 `sidebar.workspaces.actions`。`--fork-ui` 给 ui-sidebar 加这个座位，插件把 **[工作区 | 文件]** portal 进头栏同一行。重建：

```bash
pnpm --filter @deepseek-ai/dsh-client-ui-sidebar run bundle
```

空座位会整条隐藏，卸载时保留也无害。

## 行为与限制

- git 调用显式带「当前会话 + full-access」沙箱策略。不加的话，沙箱会落到 `dsh web` 启动目录；会话 cwd 在启动目录之外时，所有 git 会表现为「不是 Git 仓库」。
- 编辑器保存视为用户显式写入（full-access），仍受会话目录边界约束。
- 超过 2MB 不提供编辑 / 预览；二进制读失败会提示。
- Markdown 预览是内置轻量渲染：标题（ATX / Setext）、表格（含对齐）、多级有序 / 无序 / 任务列表、嵌套引用、围栏 / 缩进代码块（**带语法高亮**与语言徽章）、front matter、脚注、引用链接、自动链接（裸 URL / `<url>` / 邮箱）、`__粗体__` `*斜体*` `~~删除~~` `==高亮==`、转义与实体透传、无属性白名单行内 HTML（`<br>` `<kbd>` 等）、`$$数学$$`。原始 HTML 一律按文本显示，URL 只放行安全协议。
- HTML 预览在 `sandbox=""` 的 iframe 里，不执行脚本。

### 手动安装（排查用）

1. `pnpm install && pnpm run build && pnpm run verify`
2. 建 junction，指向本项目目录：
   - `%DSH_HOME%\profiles\node_modules\dsh-explorer`
   - `%DSH_HOME%\profiles\<profile>\node_modules\dsh-explorer`
   - `<harness>\apps\cli\node_modules\dsh-explorer`
3. 在 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 追加 `- insert: [{id: dsh-explorer, name: dsh-explorer}]`
4. 重启 `dsh web`，刷新页面
