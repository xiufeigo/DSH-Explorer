# store 座位迁移设计（接入规范 ③）

> 目标：把 DSH-Explorer 的共享 store 换成官方 `defineStore` 句柄并在 `register` 以 `store:` 声明，组件读 `props.useStore`、写 `props.actions`，`inject` 只承载纯数据与回调。
>
> **结论先行**：原先设想的「一个句柄挂到所有 register」在官方实现里是**非法的**，因此本项不是机械搬家，而是一次需要拆店的架构改造。本文记录约束、证据与可行方案。

## 一、约束：一个句柄只能挂一个 scope

官方 `packages/client/ui-slots/src/index.ts` 在 register 时校验 store 句柄的 scope 唯一性，冲突直接抛错：

```
store handle mounted under "<slot>" (scope "<scope>") is already mounted under scope "<other>" — one handle, one scope
```

（`ui-slots` 源码断言，0.1.2-rc.1。）

实例侧同样按 **句柄** 归集：`ui-renderer/src/client/registry.ts` 用 `_stores: Map<handle, { scope, refs, instances }>` 缓存，`instances` 再按 session key 分桶，`_acquire(handle, scope)` 只在首次登记时写 scope。因此：

- **同一个句柄挂多个 register → 共享同一实例**（这正是我们要的跨组件共享，`refs` 引用计数保证最后一个卸载才回收）；
- **同一个句柄挂到不同 scope → register 阶段抛错**（这是拦路的地方）。

## 二、本插件占用的座位横跨两个 scope

| 座位 | kind | scope |
| --- | --- | --- |
| `details` | single | **session** |
| `conversation.session.header.utilities` | list | **session** |
| `sidebar.workspaces` | single | **root** |
| `sidebar.footer.action` | list | **root** |
| `settings.plugin.item` | keyed | **root** |

（`ui-layout` / `ui-conversation` / `ui-sidebar` / `ui-settings-plugins` 各自的 slot 契约。）

当前 `createExplorerStore()` 返回**一个** store，被这五处共用 → 直接搬家必然触发上面的断言。

## 三、因此需要拆成两个 store

| 归属 | 字段 |
| --- | --- |
| **root store**（`sidebar.workspaces` / `sidebar.footer.action` / `settings.plugin.item`） | `filesMode`、`treeTick`、`summaryOn`、`summaryFloat`、`terminalOn`、`terminalHeight`、`currentSessionId` |
| **session store**（`details` / `conversation.session.header.utilities`） | `panelOpen`、`overlayOpen`、`tabs`、`active`、`defaultActive`、`extraPages`、`reviewMode`、`sessionActive`、`termBags` |

两者都用 `defineStore({ init, actions })` 声明，句柄在 apply 里各构造一次；**不使用 `persist`**——原文的持久化是「哪些会话被显式打开过」的 LRU 集合与终端高度，语义不属于「整店快照」，继续由模块级纯函数读写 localStorage（`readPanelIntent` / `markPanelIntent` / `persistTerminalHeight`），由 inject 回调与 action 一起调用。

## 四、拆店后的跨层读取（本项真正的难点）

有些组件坐在一个 scope 的座位上，却需要另一个 store 的事实：

| 组件 | 座位 scope | 需要的跨层事实 |
| --- | --- | --- |
| `FileTree` / `SidebarFiles` | root（`sidebar.workspaces`） | 打开文件 tab、`fs` 相关 tab 写入属于 **session store** |
| `SummaryToggle` / `SummaryCard` | session（header.utilities） | `summaryOn` / `summaryFloat` 在 **root store** |
| `TerminalToggle` / `TerminalPanel` | session | `terminalOn` / `terminalHeight` 在 **root store** |

**关键限制**：apply 世界**拿不到框架为某个 session 建的 session 实例**——`handle.create(key)` 会另建一个对象，而框架的实例按 `handle × key` 缓存在 registry 内，二者会分裂。所以「在 apply 里造一个 bridge 对象、两边 actions 都抓着用」这条路**只对 root store 可行**（root 实例是唯一的、keyless），对 session store 不可行。

可行的两条路：

1. **root 侧跨到 session**：由插件自己 provide 一个服务（客户端插件 provide 自家服务是官方用法，如 `ui-conversation` 的 `conversation` / `uiSession`）。坐在 `details`（session）的入口在自己的 inject 里把 `(sessionId, actions)` 注册进该服务；`FileTree`（root）通过服务回调请求「给当前会话开个文件 tab」。**代价**：多一层自家服务与注册时序，且 root 侧的「当前会话」需要由 session 侧回报（现已有 `noteSession` 的等价物）。
2. **把入口搬到 session scope**：文件树目前只能落在 root 的 `sidebar.workspaces`；官方没有 session scope 的侧栏座位，所以此路不通，除非官方新增座位。

反向（session 侧读 root）**没有**这个限制：root 实例唯一且 keyless，可沿用官方 `LayoutController.attachPanels` 的做法——在 root 入口的 inject 钩子里把 bound actions 交给一个 apply 世界的持有者，session 侧组件经 inject 纯数据 + `hooks` 观测项读取。

## 五、桥接方案（已定，无需新增 Cordis 服务）

跨层的唯一一处是「左侧文件树（root 座位）打开文件 tab（session 状态）」。方向固定：**tab 属于 session 店**（会话隔离天然正确），所以只需 root → session 的**命令式**通道，不需要 session 侧反向读取 root 的响应式数据。通道用 **apply 闭包内的持有者**实现——不是模块级单例，也不是自家 Cordis 服务：

```ts
// index.tsx 的 apply 里（闭包变量）
const fileOpen = { handler: null as null | ((input: { path: string; name: string; kind: ExplorerTabKind }) => void) }
```

- session 侧（`details` 的 inject，签名 `(sessionId, actions)`）在钩子里写 `fileOpen.handler = (input) => { …actions.openTab(mint(input))…; void loadTabContent(…) }`，并返回清理函数把它置回 `null`；
- root 侧（`sidebar.workspaces` / `sidebar.footer.action` 的 inject，签名 `(actions)`）返回纯回调 `openFile: (input) => fileOpen.handler?.(input)`；
- 这与官方 `LayoutController.attachPanels` 从 root 入口 inject 钩子接管 actions 是同一手法（apply 世界持有、随注册生命周期存取）。

依据：apply 世界**不能**自行 `handle.create(key)` 取 session 实例（会与框架在 register 时按 `handle × key` 缓存的实例分裂），所以 session 侧能力只能由 session 侧入口在 inject 时交出来。

## 六、切换步骤（必须在一次连续改动内完成）

拆店不能半个半个切：只要 `details` 用新店而 header utilities 还用旧店，两边的 `openPage` / `panelOpen` 就会各写各的——typecheck 与 smoke 都不会报，但界面行为当场错乱。因此按下面顺序一次做完再跑验证：

1. `index.tsx` apply 里构造两个句柄：`createExplorerRootStore()` / `createExplorerSessionStore()`，并建上第四节的 `fileOpen` 持有者。
2. 六个 register 声明 store 座位（**同句柄同 scope，不得跨**）：
   - `details`（session）→ `store: sessionStore`
   - `conversation.session.header.utilities` ×3（session）→ `store: sessionStore`
   - `sidebar.workspaces`（root）→ `store: rootStore`
   - `sidebar.workspaces.actions`（fork 座位）/ `sidebar.footer.action`（root）→ `store: rootStore`
   - `settings.plugin.item`（root，keyed）→ 不声明 store（其偏好走自有 settings 命名空间，确认后处理）
3. 每个 register 的 `inject` 只留纯数据与回调（删掉 `store` 字段）；session 侧 inject 收到 `(sessionId, actions)`、root 侧收到 `(actions)`。
4. 组件改造——**用下面这套替换法，逐文件的改动量极小**（这是本项能从「大重构」降到「机械替换」的关键）：
   - **prop 类型**：组件原本是 `store: ExplorerStore`。改成把 store 座位那份 props 交叉进来：
     `export type XProps = ExplorerSessionStoreProps & { …原有其余 props… }`
     （**必须是 type alias 交叉，不能写成 `interface XProps extends ExplorerSessionStoreProps`**：`PropsStore<H>` 是条件类型，interface 不能 extends 条件类型。）
   - **读**：把组件里的局部变量仍命名为 `store`，只把取数那一行换成整店快照订阅：
     `const store = useStore(s => s)`（原来是 `const store = useExplorer(storeHandle)`）。
     这样**所有字段读取原地不动**（`store.panelOpen` / `store.tabs` / `store.filesMode` …全都不改），并且保持旧实现「任何变化都整组件重渲染」的语义，行为零变化。
   - **写**：`store.foo(` → `actions.foo(`（仅写调用点，见下面清单）。
   - **读 helper**：`store.sessionTabs(sid)` → `sessionTabsOf(store)`；`store.activeFor(sid)` → `activeFor(store)`；`store.termBag(sid)` → `termBagOf(store)`（新店按会话隔离，不再需要传 sessionId）。
   - **可整块删掉**：`noteSession` / `useSessionHint` / `currentSessionId`（session 入口的 inject 本来就拿到 sessionId）、`touch()`（新店产出新状态，选择器自会重渲染）。
   - 父组件把 store 相关 props 往下传时，传的是框架给的 `useStore` / `actions`（官方同样把 `useSession` 这类框架 hook 往下传）。
   - 每个文件的写调用点清单见 §8。
5. `rpc.ts` 的 `openFileTab` 改签名：`(io: { tabs; actions; sessionId; path; name; kind })`。`props.actions` **无返回值**，所以去重/重试判定改由调用方用自己 `useStore(s => s.tabs)` 的快照做，tab id 由调用方铸好传入，后续 `actions.patchTab(id, …)` 用同一个 id。
6. `narrowPanel.ts` 与 `PanelToggle` / `ExplorerPanel` 的窄屏状态机改成基于 session 快照 + actions（`store.subscribe` 的采样移到 `ExplorerPanel` 的 effect）。
7. 持久化纯函数独立成模块：`readPanelIntent` / `markPanelIntent`（会话 LRU 集合）与 `readTermHeight` / `persistTermHeight` 不进店；id 计数器（tab / 终端）保留为模块级纯计数器（不是 store 句柄）。
8. 删除旧 `store.ts`（`createExplorerStore` / `useExplorer` / `useSessionHint` / 旧类型）与其全部引用。
9. 验证：`pnpm run typecheck`、`pnpm run build`、`node scripts/smoke.mjs`、`node scripts/md-selfcheck.mjs` 全绿；随后刷新页面人工确认：右栏开合按会话记忆、文件 tab 只在打开它的会话可见、终端高度与标签、窄屏替换、置顶摘要宽窄切换。

## 七、逐文件写调用点清单（grep 全仓所得，行号为改造前）

引用旧 `./store` 的文件共 15 个：`index.tsx`、`store.ts`、`rpc.ts`、`narrowPanel.ts`、`ExplorerPanel.tsx`、`EditorTab.tsx`、`FilesToggle.tsx`、`FileTree.tsx`、`PanelToggle.tsx`、`ReviewView.tsx`、`SidebarFiles.tsx`、`SummaryCard.tsx`、`SummaryToggle.tsx`、`TerminalToggle.tsx`、`TerminalPanel.tsx`。

| 文件 | 座位 scope | 需要替换的写调用点 |
| --- | --- | --- |
| `FilesToggle.tsx` | root | 无（只用注入的 `toggleFiles`）；仅 prop + `useStore(s=>s)` |
| `SidebarFiles.tsx` | root | `refreshTree(68)`、`setPanelOpen(78)`（后者是 session 状态 → 走 §5 桥接） |
| `FileTree.tsx` | root | `openFileTab(440,501)`（session 状态 → 桥接）；`useExplorer(147)` + prop(96) |
| `PanelToggle.tsx` | session | `setPanelOpen(34,38)`；`setPanelIntent(24,26,33)` 改调模块级 `markPanelIntent` |
| `SummaryToggle.tsx` | session | `setSummaryOn(115,119)`、`setSummaryFloat(72,73,96,120,123,134)`；`useSessionHint(37)` 删除 |
| `SummaryCard.tsx` | session | `openPage(70)`；props(39,46) |
| `TerminalToggle.tsx` | session | `setTerminalOn(43)` |
| `TerminalPanel.tsx` | session | `addTermTab(300,329)`、`setTerminalHeight(306)`、`closeTermTab(342)`、`setTermActive(368)`、`setTermDropped(408)`；`termBag(294,336)` → `termBagOf`；`commitTerminalHeight(312)` 改模块级落盘函数；`touch(407)` 删除 |
| `EditorTab.tsx` | session | `patchTab` ×9（205,233,301,398,430,435,474,493,497）；`openFileTab(323,508)` |
| `ReviewView.tsx` | session | `setReviewMode(289)`；`useReviewMode(130)` 内的 `store.subscribe(134)` 改成 `useStore` 选择器 |
| `ExplorerPanel.tsx` | session | `setPanelOpen(150)`、`activate(196,202,210)`、`closePage(220,225)`、`closeTab(252,260)`；`sessionTabs(67)`/`activeFor(68)` → 纯 helper；`noteSession(77)` 删除 |
| `narrowPanel.ts` | session | `setOverlayOpen(67,76,111,131)`、`setPanelOpen(78,104,114,118,132,150,156)`；`subscribe(95)` 的采样改由组件 effect 承担；`setPanelIntent(79)` 改模块级函数 |
| `rpc.ts` | 共享 | `openFileTab` 签名改造（§6 第 5 步） |
| `index.tsx` | 两者 | 两个句柄 + 桥接持有者 + 六个 register 声明 `store:` |

## 八、本轮试做记录（第 5 轮）

- 委托的执行者连续三轮 `running` 但**零写入**，已中止；改由我接手的这一次只完成到 `FilesToggle.tsx` 就发现：**在红树状态下无法收尾**（组件 prop 改了、`index.tsx` 还没跟上，`typecheck` 立刻变红；而这类改造又不能半个半个留到下一轮，因为行为会错）。
- 因此已把 `FilesToggle.tsx` **从快照回滚**，`typecheck` 恢复干净，仓库保持在可用的绿状态。
- 净收益是上面第 4 步的替换法与第八节的调用点清单——它把「13 个组件的深度改写」压缩成「每文件 1 行取数替换 + 若干 `store.` → `actions.` 的机械替换」，下一次可以在一次连续改动内收口。
- 尚未动 register：两个句柄仍未接到任何 `store:` 座位，旧 `store.ts` 仍在服役，插件行为与上一版一致。

## 九、状态

- 拆店所需的类型桩已就位：`src/client/dshStore.d.ts`（逐字对齐上游 `packages/client/store/src/contract.ts`），`@deepseek-ai/dsh-client-store` 已在 `tsdown.config.ts` 登记为 baseline 外部化（它在官方 `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 里，由 shell 播种进模块表）。
- **两个店已写好并通过 typecheck**（尚未接线，故 bundle 与行为不变）：`src/client/storeRoot.ts`、`src/client/storeSession.ts`。session 店利用「一店一实例/会话」把旧结构简化了：`sessionActive` → 直接就是 `active`，`termBags` → `termTabs` + `termActive`。
- 注意 actions 表必须写成 **type alias**（不是 interface）：`ActionsDecl<T>` 是 `Record<string, …>`，TS 只为对象字面量类型别名推断隐式索引签名。
- **最终决定（结项）**：经与用户确认，③ 作为**第三项「有意偏离」**收尾，与「右侧栏宽度」「`/client` 测试导出」并列 —— 本项不做。本文保留完整工序与调用点清单，供未来真要搬店时直接照做；`storeRoot.ts` / `storeSession.ts` 作为未接线脚手架留在仓库（文件头已标注未接线）。
- 当前仓库状态：旧 `store.ts` 继续服役，插件行为与 0.1.2 升级后一致；`typecheck` / `build` / `smoke` / `selfcheck` 四项全绿。
- 若未来重启本项，务必先读 §6 的「必须在一次连续改动内完成」与 §8 的失败记录：**中途态是"typecheck 绿但运行时崩"**（`index.tsx` 用 `Component as never` 注册，TS 不校验组件 props 与注入面），需要一次不被打断的执行窗口。

