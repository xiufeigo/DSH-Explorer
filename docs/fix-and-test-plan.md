# DSH-Explorer 修复与自测计划

> 来源：2026-07 全量代码审查（Cordis 规范核对 + Host/Client/脚本三路深读 + 冒烟实证）。
> 规范符合性部分无需动作（见审查报告第二节）；本文档只覆盖代码问题。
> 用法：按 P0 → P3 顺序执行，每项含【改动】【自测】【验收】；勾选 `- [ ]` 跟踪进度。
>
> **第二轮勾选核对（scripts-engineer / t4）**：代码改动项已经第二轮复审
>（`docs/review-round2-fix-plan.md`）逐条对照源码确认落地，相应勾选；仍为
> `- [ ]` 的是未实施子项（个别 smoke 用例补充与可选项），见行内注明。

---

## 阶段总览

| 阶段 | 目标 | 内容 | 预估 |
|---|---|---|---|
| **P0** | 止血 | S1 XSS、S2 rebinding 闸 | 半天 |
| **P1** | 正确性 | S3 编辑器丢数据、H1 inject 时序、H3 预览越界、M2 中文路径 | 1–2 天 |
| **P2** | 健壮性 | H2 卸载回退/原子写、命令面加固、内存治理、客户端生命周期与竞态 | 3–5 天 |
| **P3** | 打磨 | 低危项 + 工程细节 | 穿插进行 |
| **发布门** | 验收 | 全量回归矩阵（见文末） | 半天 |

原则：
1. 每个修复**必须**带自动化断言（smoke / md-selfcheck）或明确的手工验证步骤，否则不算完成。
2. 涉及安全闸（S1/S2）的改动，先写失败用例再修（红→绿）。
3. 不顺手重构：本计划外的重构另开分支。

---

## P0 — 安全止血（当天完成）

### P0-1 Markdown 预览 XSS：`safeUrl` 可被 tab/控制字符绕过【已实证】

- 文件：`src/client/Markdown.ts:45-55`（配合 `:127-143` 链接解析）
- 现状：`[x](java<TAB>script:alert(1))` 两种形式都能把原始 tab 带进 `href`；浏览器解析 href 时剥掉 tab → 按 `javascript:` 执行。渲染面是全项目唯一 `dangerouslySetInnerHTML`（`src/client/EditorTab.tsx:424`）。

改动：
- [x] `safeUrl` 内在 scheme 检测前先做控制字符/空白净化，并对返回值也用净化结果：
  ```ts
  function safeUrl(dest: string, image: boolean): string {
    const url = dest.trim().replace(/^<([\s\S]*)>$/, '$1').trim()
    // WHATWG URL 解析会剥掉所有 U+0000–U+0020；先剥再判，杜绝 java\tscript: 绕过
    const cleaned = url.replace(/[\u0000-\u0020]+/g, '')
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
    if (scheme !== null) {
      const id = scheme[1].toLowerCase()
      if (id === 'http' || id === 'https' || id === 'mailto') return cleaned
      if (image && id === 'data' && /^data:image\/(?:png|jpe?g|gif|webp|bmp);/i.test(cleaned)) return cleaned
      return '#'
    }
    return cleaned
  }
  ```
- [x] 复核 `safeUrl` 全部调用点（行内链接、自动链接、引用链接、图片、脚注），确认返回 `'#'` 的分支不会造成渲染异常。

自测（先写用例，应红）：
- [x] `scripts/md-selfcheck.mjs` 新增断言：
  - `[x](java\tscript:alert(1))` → href 不含 `script:` 且不以 `java` 开头
  - `[x](<java\tscript:alert(1)>)` → 同上
  - `![x](<java\tscript:alert(4)>)` → src 被中和
  - `[x](jav\u0001ascript:alert(5))` → 中和
  - `[x](vbscript:msgbox(1))`、`[x](data:text/html,<script>)` → `#`
  - 回归：`[x](https://a.com/b c)`、`<https://ok.com>`、`[x](mailto:a@b.c)`、`![i](data:image/png;base64,AAA)` 仍正常
- [x] `node scripts/md-selfcheck.mjs` 全绿。
- [x] 手工：造 `poc.md`（含上述载荷）→ 插件预览 → DevTools 断言无 `javascript:` href。

验收：真实浏览器中点击构造链接不执行脚本；旧链接行为不变。

### P0-2 RPC/PTY 闸对 DNS rebinding 不设防

- 文件：`src/pty.ts:412-441`（`gateExplorerRequest`），消费点 `src/index.ts:980,1189`
- 现状：POST 分支只查自定义头，不校验 Origin/Host；rebinding 时 Origin 与 Host 天然相等 → 预检放行 → `fs.write`（full-access）/`pty.*`（≈RCE）全通。

改动：
- [x] 新增回环 Host 白名单校验：
  ```ts
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
  function hostNameOf(host: string): string {
    // 兼容 [::1]:port / host:port
    const h = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
    return h.toLowerCase()
  }
  ```
- [x] `gateExplorerRequest` 三分支统一收紧：
  - OPTIONS：`sameHost` **且** `hostNameOf(host)` 在回环白名单，否则 403；
  - POST：自定义头 + `origin` 存在 + `sameHost` + 回环白名单，任一缺失 403；
  - 其它方法 405 不变。
- [x] 注释写明威胁模型：自定义头拦表单型 CSRF，回环+同源拦 rebinding；本地信任模型下 sessionId 仍是凭据（见 P3 可选令牌）。

自测：
- [x] `scripts/smoke.mjs` RPC 闸用例扩充：
  - 同源回环 OPTIONS → 204（回归）
  - 跨源 OPTIONS → 403（回归）
  - POST 无头 → 403（回归）
  - POST 带头 + 同源 → 到 dispatch（回归）
  - **新增**：POST 带头，`Origin: http://evil.com:50468` + `Host: evil.com:50468`（sameHost 成立但非回环）→ 403
  - **新增**：POST 带头、无 Origin → 403
- [x] 手工 curl 复现被拒：
  ```
  curl -X POST http://127.0.0.1:<port>/dsh-explorer/rpc -H "x-dsh-explorer: 1" -H "Origin: http://evil.com:<port>" -H "Host: evil.com:<port>" ...
  ```
  （curl 可任意伪造 Host，正是 rebinding 的模拟）
- [x] 手工回归：真实页面里文件树/审查/终端各点一轮，确认正常请求不被新闸误伤（重点：`Origin` 缺失的边界）。

验收：所有新用例绿；真实客户端功能无回归。

---

## P1 — 正确性（本周）

### P1-1 编辑器未保存内容静默丢失

- 文件：`src/client/EditorTab.tsx:181-208,347-352`、`src/client/ExplorerPanel.tsx:265`、`src/client/store.ts:274-283`、`src/client/rpc.ts:91-92`
- 现状：草稿只在组件本地 state；切 tab/页面即卸载丢稿，重开恢复旧内容但「● 未保存」角标仍在。

改动：
- [x] `onChange` 同步草稿进 store：`store.patchTab(tab.id, { dirty: true, content: next })`；`EditorTab` 的本地 `value` 初始化/重置逻辑相应改为以 store 为准（注意与外部修改跟随 `rebase` 的配合：外部载入时同时写 store）。
- [x] `closeTab` 对 `dirty` tab 弹确认（`window.confirm` 即可，文案含文件名）；调用点：`ExplorerPanel` tab 关闭、会话切换不触发（会话隔离天然保留）。
- [ ] （可选，若工时允许）草稿持久化：`localStorage['dsh-explorer:drafts']`，键 `sessionId\0path`，单稿截 2MB、总量 10 条 LRU；打开 tab 时优先草稿。——**未实施（可选项）**：store 内草稿已覆盖「切走切回不丢」；刷新页面丢稿为已知行为。
- [x] `openFileTab` 的 `!tab.loading` 早退分支保持不变（store 有草稿后自然恢复）。

自测（手工矩阵）：
- [x] 编辑 → 切到「审查」→ 切回：内容与脏标保留。
- [x] 编辑 → 点 ✕ 关闭：弹确认；取消不关、确认关闭。
- [x] 编辑 → Ctrl+S → 脏标消失 → 切走切回内容保留。
- [x] 编辑态下外部改文件（另开终端 `echo x >> file`）：出现「文件已在磁盘上被修改」条；载入/忽略两分支正确。
- [x] 刷新页面：未持久化方案下草稿丢失属预期（若做了可选持久化则恢复）。

验收：上述 5 条全部符合预期；无 React 受控组件告警。

### P1-2 Host inject 与实际依赖不一致（服务快照时序）

- 文件：`src/index.ts:1129-1140,1225-1229`
- 现状：实际用 7 个服务只声明 4 个硬依赖；`sandboxPolicy` 晚就绪会让 `policyFor` 恒 undefined → git 全落默认沙箱（非默认会话表现为「不是 Git 仓库」）、`fs.write/fs.create` 的 full-access 失效；全程无日志。

改动：
- [x] 可选三服务改惰性获取（不做硬 inject，避免老宿主缺服务时整插件不激活）：
  ```ts
  policyFor: (session) => (ctx.get('sandboxPolicy') as SandboxPolicyService | undefined)?.resolve({ session, mode: 'danger-full-access' })
  ```
  `systemPrompt` / `sessionPersistence` 同理在 `contextMeta` / `loadSessionLog` 内按需 `ctx.get`（每请求一次，开销可忽略）。
- [x] 必需四服务缺失时 `console.warn` 后 return（当前是静默）。
- [x] `pty` 的 `getSubprocess` 已是惰性范式，保持。

自测：
- [ ] `scripts/smoke.mjs` host 用例扩充：fake ctx 先缺 `sandboxPolicy` → apply → 之后注入 → `handleRpc` 的 `git.status` 能拿到非空 `sandboxPolicy`（断言 resolve 收到的对象含 policy）。——**未实施**：惰性获取已落地（由手工用例验证），smoke 未加该用例。
- [x] 手工：重启 `dsh web` 后，在一个**非启动目录**的会话里打开审查 → 正常出 git 状态（这是原本最容易踩雷的场景）。

验收：冒烟绿；非默认会话 git 可用且策略非空（可临时加日志确认）。

### P1-3 `previewUntracked` 绕过会话 cwd 栅栏

- 文件：`src/index.ts:300-309`（配合 `:263,286-293`）
- 现状：`fs.resolve(path)` 不带 cwd、无 contains 校验；`path` 是仓库根相对路径，会话 cwd 为仓库子目录时越界读文件（违反文件头自述）。

改动：
- [x] `previewUntracked` 增加 `sv` 与 `cwd` 参数，先过 `resolveInside(sv, cwd, ...)`；越界或解析失败返回 `null`。
- [x] `diffSnapshots` 调用点同步传入。
- [ ] （可选加固）`captureSnapshot` 收录 untracked 条目时就过滤 `contains(root, ...)` 之外的路径。——**未实施（可选项）**：读取侧已由 `resolveInside` 栅栏拦截（`fs.resolve` 带 `{cwd}`），收录侧未加过滤。

自测：
- [ ] `scripts/smoke.mjs` 增用例：fake fs 中 untracked 路径在 cwd 外 → `git.lastRound` 的该文件 `patch` 为 null 且无异常。——**未实施**：修复已落地，smoke 无 `git.lastRound` 越界用例。
- [x] 手工：仓库子目录作为会话 cwd → 制造上一回合新增文件 → 预览正常；把仓库根的未跟踪文件纳入回合 → 不出内容、不报错。

验收：冒烟绿；越界路径读不到任何内容。

### P1-4 git 中文文件名必坏（core.quotePath 八进制转义）

- 文件：`src/index.ts:186-193`（`unquotePath`）及全部 git 调用
- 现状：只解 `\\ \" \n \t`，不解 `\NNN`；默认 `core.quotePath=on` 下所有非 ASCII 路径显示乱码、后续按路径查 diff 全失败。

改动：
- [x] `runGit` 统一前置 `-c core.quotePath=false`（改一处即全覆盖）：
  ```ts
  const spec = shell.resolve({ command: `git -c core.quotePath=false ${args}`, ... })
  ```
  注意 `captureSnapshot`/`gitStatus`/`gitSummary` 等全部经由 `runGit`，确认无旁路直调。
- [x] `unquotePath` 保留（兼容用户全局配置强制 quote 的极端情况），并补 `\NNN` 八进制解码：收集连续 `\NNN` 为字节序列后 `TextDecoder('utf8')` 解码。

自测：
- [x] md/单元侧：`parsePorcelainLine` + `unquotePath` 对 `"\346\226\207\344\273\266\345\220\215"` 解码出中文（加入 smoke）。
- [x] 手工：临时仓库建中文文件名 → 修改 → `git.status`/`git.diff`/`git.fileDiff` 路径正确、点开有 patch。

验收：中文/日文/带空格路径在审查面板全链路可用。

---

## P2 — 健壮性与工程治理（下个迭代）

### P2-1 卸载不回退 `--fork-ui`；改宿主源码无备份非原子

- 文件：`scripts/uninstall.mjs:154-226`、`scripts/install.mjs:248,334-398`
- 改动：
  - [x] 抽共享工具 `scripts/atomicWrite.mjs`：复刻 `src/payloadFork.ts` 的「`.orig` 备份只写一次 + 同盘 `.tmp` + rename，失败退直写」。（落地形式：并入 `scripts/harness.mjs` 的 `atomicWrite` / `backupOnce`，未单设文件）
  - [x] `patchSource` 全量改走该工具；卸载回退同样先备份。
  - [x] `uninstall.mjs` 补 4 条 sidebar 回退规则（`contract/slots.ts`、`index.ts`、`SidebarRoot.tsx`、`SidebarRoot.module.css`），按安装器写入标记做函数体/片段匹配，仿 `stores.ts` 现有写法；命中失败宁可不动并警告。
  - [x] 卸载结尾新增残留探测：扫 `sidebar.workspaces.actions` 标记，存在即显式输出「存在未回退的 fork 残留」。
- 自测：
  - [x] 在 harness **副本**上：`install --fork-ui` → 4 文件带标记；`uninstall` → 全部还原、备份生成、无残留输出。
  - [x] 模拟中断：写入阶段手动杀进程 → `.tmp` 不覆盖原文件或可恢复。
  - [x] `--dry-run` 两种 fork 均不落盘。

### P2-2 命令面加固（拼字符串 → 统一净化）

- 文件：`src/index.ts`（runGit/mkdir/candidate 插值）、`src/openNative.ts:189-195`
- 背景约束：宿主 `shell.resolve` 只收命令字符串，无法真 argv 化；策略改为「单一净化入口 + 全插值点过闸」。
- 改动：
  - [x] 新增 `shellSafe(value): string | null`：拒绝含 ``[\\'"`$;|&<>^%!\u0000-\u001f]`` 的值；所有插值点（git 输出来源的 `candidate`/`merge`、`mkdir` 的 `abs`、分支名、提交消息）统一过闸，失败即报错不执行。（注：二轮 P0-1 已把文件路径插值演进为按平台的 `shellSafePath`，见二轮计划）
  - [x] `fsCreate` 的 `mkdir` 路径：对 `abs` 过 `shellSafe`；Windows 分支改 `mkdir` 单参数直给（已是），POSIX 分支同样校验。
  - [x] `openNative.ts` cmd 回退改为直接 `spawnDetached(explorerExe(), [winPath(folder)])`，删除 `cmd /c start` 链（消灭 `&` 注入面）。
  - [x] `safeCommitMessage` 追加剥 `%`（cmd 展开）；`fsCreate` 名称黑名单补 `&`、`%`、控制字符、Windows 保留名（CON/NUL/COM1…/AUX）与结尾点空格。
- 自测：
  - [ ] smoke：构造含 `"`、`$`、`&`、`%` 的分支名/路径/消息输入 → 全部被拒（返回错误而非执行）。——**未实施**：`shellSafe` 函数已落地，smoke 未加元字符拒绝用例。
  - [x] 手工：目录名含空格/中文/括号 → mkdir、reveal、openExternal 正常。

### P2-3 Host 内存治理与回合快照竞态

- 文件：`src/index.ts:1142-1166`、`src/pty.ts:299-394`
- 改动：
  - [x] `lastRounds` LRU：上限 32 会话（含补丁总量考虑），`pendingStarts` 同步清理；若宿主有会话卸载事件则订阅清理（无则只靠 LRU）。
  - [x] turn/start 的快照 Promise 入 `pendingStarts`（存 Promise 而非只存结果）；turn/end 先 `await` 在途 start 快照，消除「end 先于 start 完成」丢回合。
  - [x] `runGit` 检查 `stdout.truncated`：截断时该快照标记不可靠（`git.status` 返回 `truncated: true`，前端可提示）。
  - [x] PTY：每会话上限 8（超出拒绝并提示）；最后一个 attach 断开后 10 分钟无人重连自动 `terminate`；POSIX 管道回退用 `detached` + 进程组 kill。（注：二轮 P1-2/P1-3 修掉了 open 并发破限与「open 后不 attach 定时器不启动」两处残留缺陷）
- 自测：
  - [ ] smoke：fake 事件序列 start/end 乱序（end 先到）→ lastRound 仍生成。——**未实施**：修复已落地，smoke 无 start/end 乱序用例。
  - [x] 手工：开 9 个终端标签 → 第 9 个被拒；关面板 10 分钟后进程回收（任务管理器确认）。

### P2-4 Client 生命周期例外与宿主残留

- 文件：`src/client/index.tsx:117-143`、`src/client/detailsWidth.ts:84-97`、`src/client/conversationHost.ts:22-68`、`src/client/soundPlayer.ts:32-43`
- 改动：
  - [x] 文件模式动态注册纳入生命周期：`activateFiles` 内 `ctx.effect(() => { fileTreeEntry = ctx.slots.register(...); return () => fileTreeEntry?.() })`，或至少在 apply 作用域的总清理里兜底注销。
  - [x] `installDetailsWidthMemory` 返回还原函数（保存原 `attachPanels`），挂进 `ctx.effect`；同时把 `attachedPanelActions` 置空逻辑放进还原。
  - [x] `conversationHost` 建模块级节点/observer 注册表，apply 内一个 `ctx.effect` 统一 disconnect/移除（含 `dshx-has-chrome` class 与 CSS 变量）。
  - [x] `topSeatActive` 复位：顶部座位 inject 回调返回的 disposer 里 `topSeatActive = false`。
  - [x] AudioContext 在 apply 清理里 `close()`。
- 自测（手工为主）：
  - [ ] 设置 → 插件 → 禁用/启用 dsh-explorer（若宿主支持运行时重载）：宿主原型方法还原、注入 DOM 清空、无重复样式标签。——**不可执行**：宿主当前不支持插件运行时重载。
  - [ ] 无法运行时重载时：至少代码审读 + 在 `apply` 外包一层手动 dispose 演练（smoke 里对 client 插件跑 apply→dispose→apply，断言无重复注册/节点）。——**未实施**：smoke 未加 apply→dispose→apply 用例；清理逻辑经二轮代码审读验证。

### P2-5 Client 竞态与轮询治理

- 文件：`src/client/ReviewView.tsx:269-287`、`SummaryCard.tsx:90-100`、`SourcesView.tsx:14-24`、`ContextView.tsx:86-107`、`SubagentsView.tsx:91-103`、`rpc.ts:13-33`、`FileTree.tsx:210-263`、`TerminalPanel.tsx:179-191`
- 改动：
  - [x] 统一请求令牌模式：每个视图的加载闭包捕获 `cacheKey`（sessionId+模式+目标）或自增序号，resolve 后不一致即丢弃；`SubagentsView.loadTranscript` 补 cancelled 标志（最急）。（注：二轮 P0-2/P1-6 修掉了序号共用与 fileDiff 无守卫两处残留缺陷）
  - [x] `rpc` 增加 `signal` 参数与默认超时（`AbortSignal.timeout(15000)`；PTY attach 流除外，需传不超时选项）。
  - [x] `FileTree` 3s 轮询加 `busy` 互斥（对齐 `fileFollow` 的写法）。
  - [x] 终端高度拖拽：`pointermove` 只改内存，`pointerup` 落盘（或 ≥150ms 节流持久化）。
  - [x] 轮询可见性标准统一：`SubagentsView` 1s `setNow`、`SummaryCard` 8s、`ContextView` 6s 均加 `document.hidden` 门控。
- 自测：
  - [x] 手工：快速切换会话 A↔B（审查/子智能体/来源各页）→ 无串数据（旧请求晚到被丢）。
  - [x] 手工：临时把 host 挂起（断点）→ 打开文件 15s 后 tab 显示超时错误而非永久转圈。
  - [x] 手工：拖拽终端高度 → 过程流畅、松手后刷新页面高度保留。

### P2-6 安装器健壮性

- 文件：`scripts/install.mjs`、`scripts/uninstall.mjs`、`scripts/harness.mjs`
- 改动：
  - [x] `opt()` 支持 `--profile=web` 形式；未知 `--xxx` 参数直接报错退出。
  - [x] `DSH_HOME` 缺失且 `~/.dsh` 无 `profiles/<name>` 结构时报错退出（不再落相对路径）。
  - [x] patch 行正则放宽：`/^\s*-\s*id:\s*["']?dsh-explorer["']?\s*(#.*)?$/`；卸载对空 `insert:` 块做有界向上扫描（跳过注释/空行）后整块删除。
  - [x] 写前基线校验：读 → 改 → 写前重读比对，变化则中止（防并发丢写）。
  - [x] 陈旧产物检测：比较 `src/**` 与 `lib/**` 最新 mtime，src 更新则强制重建或明显警告。（二轮 t4 补：`package.json` 也纳入比较）
  - [x] 保留用户换行符（探测主 EOL 并复用）。
  - [x] `harness.mjs` 的 `shellLine` 对 `& ^ %` 等 cmd 元字符转义或校验拒绝。
- 自测：
  - [x] 手工：`--profile=web2`（`= `形式）→ 生效；`--unknown` → 报错；`--profile`（漏值）→ 报错。
  - [x] 手工：手写 `id: "dsh-explorer"` 变体后跑 install → 不叠块；uninstall → 一次删净。
  - [x] 手工：删掉 `DSH_HOME` 环境变量、rename `~/.dsh` → install 明确报错。

---

## P3 — 低危与打磨（穿插）

| # | 位置 | 一句话改动 |
|---|---|---|
| L1 | `src/index.ts:1074-1075` | cols/rows 用 `Number.isFinite` 校验 |
| L2 | `src/index.ts:941-967` | 超限后 `req.destroy()`；大体积解析前让出一帧（可选） |
| L3 | `src/index.ts:969-976` | RPC 路径 `res.on('error', noop)` 兜底 |
| L4 | `src/index.ts:223-236,207` | diff 头正则支持引号形式；` -> ` 用 porcelain rename 语义切分 |
| L5 | `src/index.ts:294-296` | 起点 untracked→终点 tracked 判为已提交新增而非 `untracked-removed` |
| L6 | `src/payloadFork.ts:151,158-160` | marker 内嵌 `max` 与源文件 hash；不匹配视为需重打 |
| L7 | `src/pty.ts:109-130` | node-pty 探测加调试日志开关，魔法路径注释 |
| L8 | `src/pty.ts:164-200` | 管道回退注入 `chcp 65001` / `[Console]::OutputEncoding=[Text.Encoding]::UTF8` |
| L9 | `scripts/md-selfcheck.mjs:11` | 改 `fileURLToPath(import.meta.url)`（路径含空格/中文会 ENOENT）；`.gitignore` 加 `.tmp-mdcheck/` |
| L10 | `package.json` | 加 `"engines": { "node": ">=22.12" }`；注释 `./client` 仅供壳 ModuleLoader |
| L11 | `src/client/ExplorerSettingsCard.tsx` / `soundPlayer.ts` | 「系统通知」文案改为音效语义，或实现 `new Notification` |
| L12 | `src/client/SummaryCard.tsx:86-88` 等 | 可选 `useSessions` 用稳定包装消除条件调用 hook |
| L13 | `src/client/SourcesView.tsx:56-63`、`SummaryCard.tsx:269-271` | 外链过一遍同源 `safeUrl` 规则（只放行 http/https） |
| L14 | `src/client/EditorTab.tsx:70,84-86` | `startsWith('未知方法')` 改显式错误码协商（需宿主配合，先记债） |
| L15 | `src/client/FileTree.tsx:478-516,399-459` | 右键菜单视口收边；「显示全部」后设渲染上限（如 2000） |
| L16 | `tsdown.config.ts:66,77,39,82` | `clean: true`；CSS tagId 掺路径哈希；`noExternal` 显式 `return false` |
| L17 | `scripts/smoke.mjs` | 断言 `webServer.register` 收到的 path/kind；固定 sleep 改轮询断言；测试钩子条件导出（可选） |
| L18 | `src/client/workspacePinOverlay.ts:325-327` | 行级 mousedown 监听保存句柄，卸载摘除 |

> **P3 核对备注（二轮 t4）**：L1–L13、L15、L16、L18 已实施。个别偏差：
> L6 marker 只内嵌 `max`、未嵌源文件 hash（漂移以标记 max 为准重打，二轮
> smoke 有 max 漂移用例）；L10 的 `./client` 说明落在 README（package.json
> 无注释位）；L11 UI 文案已改「提示音」，`prefs.ts` 注释遗留由二轮 P3-5 跟进。
> **未实施**：L14（需宿主错误码契约，记债保留）；L17 部分实施
>（`webServer.register` path/kind 断言已落地，「固定 sleep 改轮询断言」未改）。

---

## 发布前全量回归矩阵（手工，半天）

前置：干净环境装 `pnpm plugin:install --fork-ui`，重启 `dsh web`，刷新。

| 域 | 步骤 | 预期 |
|---|---|---|
| 启动 | 观察 console | 无 error；payload-fork 日志为 patched/already |
| 文件树 | 展开/折叠/切会话/刷新页面 | 展开状态恢复；>120 条目录出「显示全部」 |
| 文件树写操作 | 右键新建文件/文件夹（含中文名）、重命名场景 | 成功且树刷新；非法名被拒 |
| 编辑器 | 打开→编辑→切走切回→保存→外部修改提示 | 按 P1-1 验收 |
| 预览 | md（含表格/代码块/数学/脚注）、html | 渲染正常；html 无脚本执行 |
| 审查 | 三个面板、虚拟滚动、切 tab 回来不重拉 | 顺序/折叠记忆正确 |
| 上一回合 | 让 agent 改文件后看面板 | 冻结快照正确；中文文件可见 |
| 分支变更 | 建分支提交 → 比较 → compareUrl | 基准探测正确，GitHub 链接可点 |
| 终端 | 多标签、中文输出（Win 管道回退另测）、拖高度、收起不断进程 | 无乱码（P2 后）、关标签杀进程 |
| 工作区 | 按时间排序、置顶、拖拽钉住、设置卡恢复 | 与现有冒烟一致 |
| 右栏记忆 | 仅打开过的会话自动恢复；宽度记忆 | 与现有一致 |
| 卸载 | `pnpm plugin:uninstall` | patch 行/junction 清除；（P2-1 后）fork 无残留 |
| 安全 | P0 的全部用例 | 全绿 |

发布门：`typecheck` + `build` + `verify` + `md-selfcheck` 四绿 ∧ 回归矩阵无红 ∧ P0/P1 全部勾选。

> 核对备注（二轮 t4）：本矩阵已随一轮发布门执行；二轮收尾按
> `docs/review-round2-fix-plan.md` DoD 复跑，并另加四项新增手工用例
>（Windows 新建文件夹、切会话终端存活、ContextView 首屏 ToDo、大仓库超时）。

---

## 备注

- 宿主内部 API 易碎点（DOM 属性选择器、`'未知方法'` 文案契约、layout 原型、xterm 内部类名）不做代码改动，建议在对应位置统一加 `// FRAGILE(host):` 注释标记，宿主升级时按注释清单回归。
- `docs/desktop-shell-fix-plan.md` 的 LRU 方案中 `settledBucketFor` 对 `null` 键会抛 `TypeError`（`WeakMap.set(null,…)`），提交给宿主前先改 `== null` 兜底。
