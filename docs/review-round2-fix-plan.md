# DSH-Explorer 第二轮审查修复计划

> 来源：第二轮 10 路并行复审（Host RPC / 安全闸 PTY / payloadFork / Client 核心 / 编辑器 / 右栏视图 / 侧栏基建 / Markdown 安全 / 脚本 / 构建规范）。
> 第一轮全部修复项经逐条复核**确认落地**；本轮发现 **6 个严重**（其中 2 个是第一轮引入的回归）、11 个高、20+ 个中低。
> 用法：按 P0 → P3 执行；每项含改动要点与自测方式；完成一道跑一次四道门（typecheck/build/verify/md-selfcheck）。

---

## 已排除的误报（不要修）

| 误报 | 排除依据 |
|---|---|
| 「payloadFork 标记清理正则缺点号」 | 实读 `src/payloadFork.ts:136`，代码是正确的 `300\.\.\d+` |
| 「编辑器折行导致行号错位」 | `explorer.module.css:294` 已有 `white-space: pre`，JSX 有 `wrap="off"` |
| 「sourcemap 无路由 404」 | `dsh-client-modules` 的 serveBundle 明确提供 `/client.js.map` |
| 构建路代理引用的「tsdown v0.15.6 / define BUILD_TIME / dsh.client.inject=slots」等证据 | 与实际文件不符（幻觉），该路 B 段结论可用、A 段引文不可信 |

---

## P0 — 严重（立即修）

### P0-1【回归】Windows 新建文件夹 100% 失败
- 位置：`src/index.ts:173-177`（`shellSafe`）+ `:524-525`（fsCreate mkdir）
- 问题：`shellSafe` 拒绝 `\`，而 Windows 绝对路径必含反斜杠 → `fs.create kind:'dir'` 全部报「路径含不安全字符」。第一轮 G5 引入。
- 改动：新增 `shellSafePath(value)`：保留 `shellSafe` 的元字符黑名单但**按平台处理分隔符**——win32 允许 `\`（仍拒 `'"`$;|&<>^%!` 与控制字符），POSIX 拒绝 `\`。fsCreate 的 mkdir 路径改走 `shellSafePath`；git 相关的标识符继续用 `shellSafe`。
- 自测：导出 `shellSafePath`，smoke 断言：`C:\a\b`（win32 语义）通过、`C:\a"b` 拒绝、`a;rm` 拒绝、POSIX 下 `\` 拒绝。手工：Windows 右键新建文件夹成功。

### P0-2【回归】ContextView 首屏 todo 必被自己的守卫丢弃
- 位置：`src/client/ContextView.tsx:87-117`
- 问题：`load()`（todo）与 `loadMeta()` 共用 `reqSeq`；挂载时先后自增，todo 响应到达时序号已失效 → ToDo 面板首屏空白，6s 后才恢复。第一轮 C3 引入。
- 改动：拆成 `todoSeq` 与 `metaSeq` 两个 ref（metaSeq 管 session.meta + context.meta 两条共用同一取号即可）。
- 自测：手工——刷新页面打开上下文页，ToDo 立即出现；快速切会话无串数据。

### P0-3 编辑器 staleDisk 告警下保存盲覆盖
- 位置：`src/client/EditorTab.tsx` save()
- 问题：外部已修改（staleDisk 提示条在）时 Ctrl+S 直接覆盖，可能冲掉 agent 刚写的代码。
- 改动（两步）：
  1. 立即：`save()` 入口若 `staleDisk !== null` → `window.confirm('磁盘文件已被外部修改，保存将覆盖外部改动。确定保存？')`，取消则中止。
  2. 加固：fs.read 返回 `version`（host `fsStatLite` 已有），打开/载入时记基准版本；保存时作为 `expected` 传给 `fs.write`（host `writeText` 支持），版本不匹配返回明确错误提示刷新。
- 自测：手工——另开终端改文件 → 编辑态出现提示条 → 保存弹确认；host 侧 mock 版本不符返回错误。

### P0-4 切会话杀掉正在运行的终端进程
- 位置：`src/client/TerminalPanel.tsx:138-146`
- 问题：TermPane 清理在卸载/`sessionId` 变化时无条件 `pty.close`；会话头插槽随会话切换卸载 → 旧会话的编译/长任务被杀，违背「收起不断开」语义。
- 改动：卸载/切会话**不发** `pty.close`（仅 abort 流、dispose xterm）；重挂载时若 `tab.ptyId` 非空则重新 `readNdjson` 挂回既有进程；仅用户点 ✕ 关 tab 时才 `pty.close`。Host 已有 10 分钟闲置回收兜底孤儿进程。
- 自测：手工——会话 A 跑 `ping -t`/长命令 → 切到 B → 切回 A：输出继续；关 tab 才杀进程（任务管理器确认）。

### P0-5 workspacePinOverlay 对 document.body 全树监听
- 位置：`src/client/workspacePinOverlay.ts:341-344`
- 问题：`subtree: true` 观察整个 body，流式输出期间每个 token 都触发回调。
- 改动：优先观察侧栏容器（`[data-slot="sidebar.workspaces"]` 或 `sidebar`）；找不到时对 body 只观察顶层 `childList`（不展开 subtree）直到容器出现再切换。
- 自测：手工——流式输出期间 DevTools Performance 无密集 observer 回调；置顶/拖拽功能回归正常。

### P0-6 SummaryCard git 动作无会话绑定
- 位置：`src/client/SummaryCard.tsx:138-178`（checkout/commit/push）
- 问题：异步动作不捕获发起时 sessionId，期间切会话 → `setNote`/`load()` 写入新会话卡片。
- 改动：动作前 `const actSession = sessionId`；resolve 后与最新 sessionId（ref）比对，不一致则丢弃后续 UI 写入。
- 自测：手工——点提交后立刻切会话，新会话卡片不出现旧提示。

---

## P1 — 高（本周）

| # | 位置 | 问题 | 改动 | 自测 |
|---|---|---|---|---|
| P1-1 | `src/index.ts:409-415` | `resolveInside` 的 `fs.resolve(path)` 缺 `{cwd}`，相对路径按宿主启动目录解析 | 传 `{ cwd }` | smoke：fake fs 断言 resolve 收到 cwd |
| P1-2 | `src/pty.ts:364-376` | open 先查数后 await，并发突破 8 上限 | 同步预占位（`pendingOpens` 计数或 live 占位），失败/完成时修正 | 并发 20 个 open 只成功 8 个（脚本直测） |
| P1-3 | `src/pty.ts:377-406,412-425` | open 后从不 attach → 闲置定时器永不启动（进程泄漏）；`write` 清定时器后不重排 | open 成功即 `scheduleIdleTimer`；write 时若无 listener 则重排 | 直测 hub：open→不 attach→假时钟 10 分钟后被回收 |
| P1-4 | `src/client/EditorTab.tsx:162-171` + `store.ts` | 每键 patchTab content → 全栏重渲染 + 大文件整串拷贝 | 脏标立即 notify；content 防抖 ~250ms 写 store；保存/切走时 flush | 手工：2MB 文件打字不卡；切走草稿不丢 |
| P1-5 | `src/client/ReviewView.tsx:75` | `reviewListCache` 模块级无界 | LRU（cap 30） | 单测式断言容量淘汰 |
| P1-6 | `src/client/ReviewView.tsx:331` | `git.fileDiff` 懒加载无序号守卫，慢 patch 覆盖新 | 按文件维护请求序号，响应不一致丢弃 | 手工：快速切换模式无错乱 |
| P1-7 | ReviewView/FileTree/EditorTab 的慢调用 | 大 diff/大目录/大文件撞 15s 默认超时 | 显式 `timeoutMs`：git 类 60s、大文件读 30s | 手工：大仓库 git.status 不超时 |
| P1-8 | ReviewView/SummaryCard/ContextView | 回前台三组件同刻 5-6 个 RPC | 唤醒刷新加 0-300ms 随机 jitter | 手工：切回前台请求错峰 |
| P1-9 | `src/client/FileTree.tsx:238-250` | 轮询对全部展开目录并发 fs.list，错误无退避 | 并发上限（如 4）+ 错误指数退避 3→6→12→30s，成功后复位 | 手工：展开 20 层目录无请求风暴 |
| P1-10 | `src/client/soundPlayer.ts:188-210` | 音效无节流，批量事件爆音 | 200ms 冷却节流 | 手工：连续触发只响一次 |
| P1-11 | `src/index.ts` handlePtyStream | 未被导出、无冒烟覆盖 | 导出 + smoke 补 3 例（闸拒绝/会话缺失/正常路径到 attach 前） | verify 绿 |
| P1-12 | `src/index.ts:1107-1118` | transcript/fs/pty 以请求方自报 sessionId 为凭据（本地信任模型已知边界） | 不改行为，在代码与 README 明确「同源回环闸内、sessionId 即凭据」的信任边界；`session.transcript` 的 targetId===sessionId 绕过属设计内 | 文档核对 |

---

## P2 — 中（下个迭代）

| # | 位置 | 问题 | 改动 |
|---|---|---|---|
| P2-1 | `src/pty.ts:457-460` | NDJSON 无背压，快输出慢客户端可 OOM | `res.write` 返回 false 时暂停输出流，drain 恢复；或限缓冲丢弃旧帧 |
| P2-2 | `src/pty.ts:329-331` | emit 监听器异常未隔离 | 循环内 try/catch |
| P2-3 | `src/payloadFork.ts:97-106` | require.resolve 抢在环境变量覆盖之前 | 先走 `bases`（env/extraBases），未命中再 require.resolve、再目录爬取 |
| P2-4 | `src/payloadFork.ts:184-187` | rename 失败降级直写可能截断被读文件；`rmSync` 绕过 io 抽象 | `PayloadForkIo` 增可选 `remove`；rename 失败时放弃写入并记录（下次启动自愈），不截断 |
| P2-5 | `src/client/store.ts:382-387` | patchTab 原地改对象，memo/依赖比较失效 | `{ ...tab, ...patch }` 浅拷贝 |
| P2-6 | `src/index.ts:953-968` | sessionSources URL 去重 O(N²) 且无上限 | Set 去重 + 每组上限 100 条 |
| P2-7 | `src/index.ts:1035-1054` | context.meta `assemble({})` 不带会话 | 传 `{ session }`（宿主接受度需核对，失败回退空上下文） |
| P2-8 | workspaceRecencyOrder/chatFileOpen 模块单例 | 插件重载后残留 | 导出复位函数并挂 ctx.effect 清理 |
| P2-9 | `ExplorerPanel.tsx` confirm | `window.confirm` 沙箱环境可能被拒 | try/catch 兜底为「允许关闭」 |
| P2-10 | `TerminalPanel.tsx:180-196` | 拖拽无 pointercancel/blur 兜底 | `setPointerCapture` + 补 `pointercancel`/`blur` 监听 |
| P2-11 | `chatFileOpen.ts:26` | 二进制扩展名不全（docx/xlsx/pptx/db/sqlite/parquet/wasm/iso…） | 补全黑名单 |
| P2-12 | `workspacePinOverlay.ts:111` | boundRows 强引用滞留孤儿节点 | sync 周期内 `!document.contains(row)` 即剔除 |
| P2-13 | `FileTree.tsx:45-56` | 展开状态 localStorage 键无上限 | try/catch + 键数量上限（如 40 个 cwd，LRU 淘汰） |
| P2-14 | `useVirtualSlice.ts:31-48` | 数据量突变白屏/跳顶 | scrollTop 按新总量夹取 |
| P2-15 | `ContextView.tsx` | RPC 错误静默吞掉 | 增 error 态 + 内联提示/重试 |
| P2-16 | `SummaryCard.tsx:126` | 子智能体双数据源闪烁 | 明确主备 + 切换迟滞 |
| P2-17 | `ReviewView.tsx:361-365` | 50 条提交截断无提示 | 列表尾部弱化文案 |
| P2-18 | `scripts/harness.mjs:63-73` | `\\?\` NT 前缀导致 junction 误判 | 比对前剥 `\\?\`/`\??\` 前缀 |
| P2-19 | install/uninstall 正则 | 行内注释破坏 `disabled:`/`- insert:` 匹配 | 放宽行尾 `(#.*)?` |
| P2-20 | `scripts/uninstall.mjs:165-176` | 破损/死链 junction 静默跳过 | 死链但目标文本指向本项目 → 允许删并提示；否则明确告警残留 |
| P2-21 | `package.json` | `prepare` 在 --prod 安装下触发构建失败 | 评估改 `prepack` 或文档声明 |

## P3 — 低（穿插）

| # | 位置 | 改动 |
|---|---|---|
| P3-1 | `Markdown.ts` createInline 入口 | 预清用户输入中的 PUA 字符（防哨兵序号碰撞导致标签重复展开，无 XSS 仅文本畸变） |
| P3-2 | `src/pty.ts` sameHost | Host 头两侧 `toLowerCase()` 比较 |
| P3-3 | git 命令 | `checkout` 补 `--` + dirty 预检提示；candidate/verify 补「`-` 开头拒绝」+ `--` 分隔 |
| P3-4 | `openNative.ts:195-200` | `openWindowsFile` 改 `-EncodedCommand`（与 folder 路径一致） |
| P3-5 | 文档 | README 5 处陈旧：闸描述补 Origin+回环、61→69 项、卸载回退范围含座位 fork、--keep-fork 语义、smoke 用例清单；`prefs.ts` 注释「系统通知」→「提示音」；本计划与一轮计划勾选状态更新 |
| P3-6 | `package.json` | `files` 补 `cordis.patch.example.yml`；`./client` 浏览器专属在注释/README 声明 |
| P3-7 | `tsconfig.json` | include 增 `tsdown.config.ts` |
| P3-8 | `install.mjs` libIsStale | mtime 比较纳入 `package.json` |
| P3-9 | `settingsNs.ts` toJSON | 补 `additionalProperties: false` |
| P3-10 | `payloadFork.ts` | `rewriteClampSites` 入口 `Number.isFinite(max/fromMax)` 防守；1200 与 `detailsWidth.ts` 互指注释 |
| P3-11 | `ReviewView.tsx:30-41` | 复合状态码（MM/AM）tooltip 完整说明 |
| P3-12 | 杂项 | 行号数组缓存；narrowPanel 恢复滚动位置；TermPane 走 `updateTermTab` 不可变更新；`args.session` 重构为显式参数 |
| P3-13 | `scripts/md-selfcheck.mjs` | 头注释声明「Markdown 依赖必须保持可 CJS 执行」约束 |

---

## 完成定义（DoD）

1. 每道阶段完成后跑四道门：`pnpm run typecheck`、`pnpm run build`、`pnpm run verify`、`node scripts/md-selfcheck.mjs` 全绿。
2. P0 各项必须带自动化断言（smoke/selfcheck）或本文所列手工验证记录。
3. 全部完成后执行一轮计划文末回归矩阵（沿用 `docs/fix-and-test-plan.md` 发布门矩阵，另加：Windows 新建文件夹、切会话终端存活、ContextView 首屏 ToDo、大仓库超时四项新增手工用例）。
4. `git diff` 复查：无调试残留、无导出面破坏（`index.tsx`/`index.ts` 导出清单与第一轮一致）。
