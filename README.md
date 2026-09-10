# DSH-Explorer

> 声明：本项目是纯 vibecoding 做出来的，由 Cursor + Grok 4.6 制作。

给 DeepSeek Harness（Web / Desktop）加两块东西：**会话头终端** 与 **左侧栏工作区排序**。

> **2026-09 精简**：插件原本还有文件树、「工作区 | 文件」切换、右侧栏（审查 / 上下文 / 来源 /
> 编辑 / 预览）、摘要卡片、面板开关、通知音效、设置卡与载荷宽度 fork。这些已全部删除——
> 其中右栏那部分在 DSH ≥ 0.1.5 本来就不挂载（官方删掉了 `details` 槽，换成自带的
> sidebar-right 文件树）。需要旧实现见 git 历史（`git show <精简前的 commit>`）。

## 功能

### 1. 会话头「终端」按钮

对话列下方展开一个真 PTY 终端，默认进当前会话的工作目录。

- 多标签：`+` 新建、点标签切换、`×` 关闭；收起面板**不断开进程**。
- 尺寸同步：窗口缩放 / 拖高度 / 切标签后把 xterm 实测的 `cols/rows` 直传 PTY 内核
  （旧宿主没有 `pty.resize` 时静默降级为纯本地 resize）。
- 输出流被掐断时自动提示并指数退避重连（进程保活，最多 5 次，成功后补一次尺寸重同步）。
- 进程回收：闲置 10 分钟、或所属会话关闭 1 分钟内（差量检测；重开标签即新建进程）。
  宿主重启后旧进程不可挂回，面板会自动开新进程替代。
- 外观：跟随界面主题（也可读旧偏好里的 `dsh-explorer:prefs`：配色 / 字号 / 字体）。

### 2. 左侧栏工作区排序（含置顶 / 拖拽）

- **按最后会话时间排序**：谁有会话活动谁顶到最前，口径取工作区里会话的最大 `updatedAt`
  （无会话回退 `createdAt`），通过宿主 `workspaces.insertBefore` 落到持久注册顺序，重启后保留。
- **置顶分区**：拖到最顶即置顶（置顶行有左侧色条），置顶与普通两段各自跟时间排。
- **钉住 / 自定义顺序**：在普通区按住行拖动 5px 进入拖拽（ghost 跟随 + 插入指示线），
  落到某处即把该工作区钉在落点、不再跟时间流动；拖回普通区即取消置顶。
- 排序只在「有会话活动的差异」时写入宿主，幂等；同一位置不重复调用。

## 快速开始

需要 Node.js ≥ 22、pnpm，以及能跑的 `dsh web`。

```powershell
git clone <仓库地址> DSH-Explorer
cd DSH-Explorer
pnpm plugin:install        # 构建 + 自检 + junction + patch 行
```

然后 **重启 `dsh web`**（Host 半边只有重启才会加载），再刷新页面。应能看到会话头的终端按钮，
以及左侧栏按活动时间排序的工作区列表。

常用参数：`--profile <name>`（默认 `web`）、`--harness <path>`、`--rebuild`、`--dry-run`。

### 卸载

```powershell
pnpm plugin:uninstall              # 去掉 patch 行和 junction
pnpm plugin:uninstall --dry-run
```

### 改动能不能只刷新？

| 改了什么 | 怎么生效 |
| --- | --- |
| 客户端 UI（`src/client/`） | `pnpm run build` 后刷新页面 |
| Host RPC / 终端 PTY（`src/index.ts`、`src/pty.ts`） | 必须重启 `dsh web` / 桌面壳 |

## 架构

```
src/index.ts             Host：POST /dsh-explorer/rpc（pty.*）+ /dsh-explorer/pty 输出流
src/pty.ts               Host：会话 cwd 里的用户 PTY（有界背压泵 + 差量回收 + 请求闸）
src/client/index.tsx     浏览器：apply 里建 store，注册终端座位 + 两个排序安装器
src/client/TerminalToggle.tsx / TerminalPanel.tsx   终端开关与面板（xterm）
src/client/store.ts      终端标签页状态（按会话分桶）+ 面板高度
src/client/conversationHost.ts  找对话列滚动区与终端座位
src/client/prefs.ts      终端外观（只读旧偏好）+ 排序开关默认值
src/client/workspaceRecencyOrder.ts  时间排序 / 置顶 / 钉住（纯状态机 + 假服务可测）
src/client/workspacePinOverlay.ts    指针拖拽层（DOM 覆盖 + 拖拽手势）
src/client/explorer.module.css       终端样式（打进 client 工厂的 style 标签）
lib/index.js             Host bundle
lib/client.js            浏览器 bundle（window.__ModuleLoader__ 工厂）
cordis.patch.yml         `dsh.bundle` 层：插入 id/name `dsh-explorer`
scripts/install.mjs      安装器（junction 捷径）
scripts/smoke.mjs        verify 冒烟
```

浏览器半边经 `package.json` 的 `dsh.client` 由模块表扫描加载；Host 半边靠 `dsh.bundle.patch`
指向的 [`cordis.patch.yml`](./cordis.patch.yml)（`dsh plugin add` 会把本包列入 `dsh.profile.bundles`）。

### 插槽

| 座位 | 用途 |
| --- | --- |
| `conversation.session.header.utilities` | 终端开关（`id: dsh-explorer-term`） |

排序 / 置顶不占槽位：它们直接观察 `sessions` 与 `workspaces` 两个客户端服务，
在左侧栏的工作区列表上工作。需要的服务：`slots`、`sessions`、`workspaces`。

### RPC（`POST /dsh-explorer/rpc`）

必须带自定义头 `x-dsh-explorer: 1`（触发浏览器 preflight，跨站过不了闸）。闸内再做**同源回环
Origin 校验**（防 DNS rebinding）：`Origin` 必须与 `Host` 同源且主机名在回环白名单
（`127.0.0.1` / `localhost` / `::1`）；跨源、缺 `Origin`、「同源但非回环」一律 403。

| 方法 | 作用 |
| --- | --- |
| `pty.open` | 在会话 cwd 起一个 PTY（带初始 cols/rows / 用户 shell） |
| `pty.write` / `pty.close` | 写输入、关进程 |
| `pty.resize` | 同步内核终端尺寸；畸形尺寸直接拒绝（不默认） |
| （流）`POST /dsh-explorer/pty` | 同一道闸；按 `sessionId + 终端 id` 挂输出流 |

## 行为与限制

- 所有路径操作限制在当前会话 `cwd` 内；PTY 也在该目录里启动。
- 终端输出有背压上限，超限丢帧时面板顶部给轻提示（不会静默丢）。
- 会话不存在 / 未挂载时 RPC 返回「会话不存在或已卸载」，终端面板会自行重试开新进程。

## 开发

```bash
pnpm install
pnpm run build       # 产出 lib/index.js + lib/client.js
pnpm run watch       # 开发时增量构建
pnpm run typecheck
pnpm run verify      # 冒烟：按运行时方式真正执行两个 bundle
```

`verify` 会：

- Host：按 cordis Loader 的方式 `require('dsh-explorer')`，断言带 `inject` 的插件对象，
  并核对 `webServer.register` 实际收到 `/dsh-explorer/rpc` 与 `/dsh-explorer/pty` 的 exact 路径；
- 浏览器：模拟 `window.__ModuleLoader__.load`，注入真实 React 后执行工厂，断言 `apply`/`inject`
  与终端座位的注册；
- 抽测 RPC 闸：同源回环 OPTIONS / POST 放行、跨源拒绝、无自定义头拒绝、缺 Origin 拒绝、
  DNS rebinding（Host 同源但非回环）拒绝；
- 走一遍排序状态机：基线就绪后按会话时间降序、幂等、置顶分区、拖拽钉位与手动定位清除。

客户端 bundle 的 `exports` 垫片写在 tsdown `banner` 里（`intro` 会被静默丢掉）。缺这一步时
浏览器会 `exports is not defined`，整页 Failed to load plugins，所以改完客户端务必 `verify`。

### 手动安装（排查用）

1. `pnpm install && pnpm run build && pnpm run verify`
2. 建 junction，指向本项目目录：`%DSH_HOME%\profiles\<profile>\node_modules\dsh-explorer`
3. 在 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 追加 `- insert: [{id: dsh-explorer, name: dsh-explorer}]`
4. 重启 `dsh web`，刷新页面
