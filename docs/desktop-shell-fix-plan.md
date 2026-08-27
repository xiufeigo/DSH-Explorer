# 桌面壳侧修复计划：超长会话切换秒级卡顿（markdown 定稿渲染无缓存）

> 目标读者：在 dsh-desktop / deepseek-harness 里动手的人。
> 本计划只涉及 **deepseek-harness 一个包内的 ~35 行改动** + 可选的 CSS 辅助项，
> 提供统一 diff 与回滚方式。DSH-Explorer 插件侧无需任何配合改动。

---

## 1 · 根因（带证据链）

**症状**：切换到超长会话（如几小时的长开发会话）时 UI 冻结数秒；
切到其他会话不明显；与右侧栏开合/宽度无关。

**调用链**：

| 层 | 文件 | 事实 |
|---|---|---|
| 会话视图 | `packages/client/ui-conversation/src/client/chat/*` | 无虚拟化/窗口化（全量 mount） |
| 消息节点视图 | `chat/AssistantMarkdown.tsx` | 组件有 `memo`，但切会话是**整树重挂载**，memo 失效 |
| markdown 引擎 | `packages/client/ui-primitives/src/markdown/MarkdownText.tsx` | **定稿渲染 `renderSettled()`（L29-51）没有任何跨挂载缓存** |

关键代码（MarkdownText.tsx L156-175）：

```ts
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, ... }) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, codeLabels, fileMentions)   // ← 每次 mount 都全新解析
    }
    ...
```

- 流式路径已经有很完善的增量缓存（`StreamingRenderer`，冻结块只解析尾部）✓
- 但**定稿**路径每次组件挂载都执行 `parseGfmWithMath(text)` + 全量构建 React 元素。
- `memo` 只在同一 React 树内生效；切会话 = 新树 = 所有历史消息的 markdown **从头重算一遍**。
- 长会话几千条消息 × 大量代码块 ⇒ 纯 JS 数秒阻塞。这与“卡的就是这个长会话”完全吻合。

**为什么插件侧无法修**（避免之后重复调研）：
1. 渲染器不注册为运行时服务（服务表只有 workspaces/sessions/layout/theme/slots）；
2. 消息视图虽挂在可替换槽位 `conversation.chat.node` 上，但原组件未导出、也不作为
   children 传入——外部注册只能整体替换，无法包装；
3. `renderSettled` 在模块闭包内部，shell 的 ModuleLoader 拿不到内部符号。

⇒ 必须动 ui-primitives 源码；用下面的「补丁制品」方式把维护成本压到最低。

---

## 2 · 核心修复：renderSettled 定稿缓存（LRU）

### 设计要点

- **键**：`text` 字符串本体（精确）＋ `codeLabels` / `fileMentions` 对象身份。
  这两个对象分别按 locale 代际 / 消息自身创建且稳定复用（见 MarkdownText.tsx L146-148
  的注释），作为二级 WeakMap 键即可保证：
  - 切语言（labels 换对象）→ 自动 miss 重渲染 ✓
  - 不同消息的 mentions 对象不同 → 各自独立桶，互不串扰 ✓
- **值**：`renderSettled` 返回的 ReactNode[]。这些元素把 copy/mention 处理器固化了——
  所以两个输入对象**必须进键**，这正是上面选择 WeakMap 身份键的原因。
- **容量**：每桶 LRU 40 条。元素树本身轻（主要是对象与字符串），40 条封顶足以覆盖
  「来回切几个会话」的热集；内存上限受控。
- **绝对不碰流式路径**：`StreamingRenderer` 一行不改，流式语义（冻结块偏差自愈等）
  完全保持。

### 补丁（对 deepseek-harness 应用）

```diff
*** a/packages/client/ui-primitives/src/markdown/MarkdownText.tsx
--- b/packages/client/ui-primitives/src/markdown/MarkdownText.tsx
@@
 export type { MarkdownCodeLabels, MarkdownFileMentions } from './render.tsx'
+
+/**
+ * Settled-render LRU cache. Session switches remount every message's
+ * MarkdownText, and renderSettled re-parsed each history block from scratch;
+ * for very long conversations this is seconds of pure scripting on the main
+ * thread. Cache keyed by exact text within (codeLabels, fileMentions) buckets
+ * — those objects are identity-stable per locale revision / per message and
+ * their handlers are baked into the elements, so they must be part of the key.
+ */
+const SETTLED_CACHE_LIMIT = 40
+const SETTLED_NO_LABELS = Symbol('markdown-settled:no-labels')
+const SETTLED_NO_MENTIONS = Symbol('markdown-settled:no-mentions')
+const settledBuckets = new WeakMap<object, WeakMap<object, Map<string, ReactNode[]>>>()
+
+function settledBucketFor(
+  codeLabels: MarkdownCodeLabels | undefined,
+  fileMentions: MarkdownFileMentions | undefined,
+): Map<string, ReactNode[]> | null {
+  if (typeof codeLabels !== 'object' && typeof codeLabels !== 'function' && codeLabels !== undefined) return null
+  if (typeof fileMentions !== 'object' && typeof fileMentions !== 'function' && fileMentions !== undefined) return null
+  const labelKey = codeLabels ?? SETTLED_NO_LABELS
+  let inner = settledBuckets.get(labelKey)
+  if (inner === undefined) {
+    inner = new WeakMap()
+    settledBuckets.set(labelKey, inner)
+  }
+  const mentionKey = fileMentions ?? SETTLED_NO_MENTIONS
+  let bucket = inner.get(mentionKey)
+  if (bucket === undefined) {
+    bucket = new Map()
+    inner.set(mentionKey, bucket)
+  }
+  return bucket
+}
+
+function renderSettledCached(
+  text: string,
+  codeLabels: MarkdownCodeLabels | undefined,
+  fileMentions: MarkdownFileMentions | undefined,
+): ReactNode[] {
+  const bucket = settledBucketFor(codeLabels, fileMentions)
+  if (bucket === null) return renderSettled(text, codeLabels, fileMentions)
+  const hit = bucket.get(text)
+  if (hit !== undefined) {
+    bucket.delete(text)
+    bucket.set(text, hit) // LRU refresh
+    return hit
+  }
+  const fresh = renderSettled(text, codeLabels, fileMentions)
+  bucket.set(text, fresh)
+  if (bucket.size > SETTLED_CACHE_LIMIT) {
+    const oldest = bucket.keys().next()
+    if (oldest.done !== true) bucket.delete(oldest.value)
+  }
+  return fresh
+}

 /** One settled full render: parse with math, resolve references, append the footnote section. */
 function renderSettled(
@@
   const children = useMemo(() => {
     if (!streaming) {
       streamRef.current = null
-      return renderSettled(text, codeLabels, fileMentions)
+      return renderSettledCached(text, codeLabels, fileMentions)
     }
```

### 应用方式（建议固化为脚本，升级后一条命令重放）

1. 把上面的 diff 存为 dsh-desktop 仓库里的
   `patches/deepseek-harness-markdown-settled-cache.patch`。
2. 提供 `scripts/apply-patches.ps1`（或 .mjs）：对 harness checkout 执行
   `git apply --3way <patch>`；插入点极小，跨版本自动合入的概率非常高，
   真冲突也只需手贴那两行。
3. README 记一句：「升级 deepseek-harness 后运行 apply-patches」。
4. 强烈建议同时向上游提 PR（renderSettled 加 LRU 是通用收益）——合并后此补丁退役。

### 回归检查单（一次过完）

- [ ] 流式输出：增量渲染、冻结块自愈、中断停止标记不变
- [ ] 消息工具条「复制」按钮可用（handler 固化但 labels 进了键）
- [ ] 文件提及链接（fileMentions）逐消息正确（mentions 进了键）
- [ ] 脚注节、KaTeX 公式正常
- [ ] 切换语言后文案变化（labels 换对象 → miss 重渲染）
- [ ] 编辑/重新生成后同消息重渲染正确（文本变 → 键变）
- [ ] 内存：来回切 3 个超长会话 × 多次，DevTools Memory 无异常增长（LRU 40 封顶）

---

## 3 · 辅助修复（可选，CSS 一层）：视口外消息跳过排版绘制

JS 解析修掉后，剩余成本通常还剩巨量 DOM 的 layout/paint。给消息节点加
`content-visibility` 让浏览器跳过视口外部分：

```css
/* 先用 DevTools 找到消息列表滚动容器的真实类名/data-* 后替换选择器 */
.dsh-chat-list > * {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px; /* 占位高度取典型消息高，减少滚动条跳动 */
}
```

- 放置位置二选一：harness 的会话样式文件里，或沿用 dsh-desktop 已有的
  titlebar.js 注入通道注入 `<style>`（后者同样升级免疫）。
- 注意与现有毛玻璃 hook 的关系：`content-visibility` 只影响排版/绘制，不影响背景。
- 收益要先测量再决定留不留：Performance 录制对比加与不加时的 Rendering 时间。

---

## 4 · 验证方法（改前先录基线，改后对照）

1. DevTools → Performance → 录制「从空会话切到超长会话」各 10s。
2. 关注 Summary：**Scripting** 时长与最宽火焰（应为 parseGfm/renderBlocks 相关栈）。
3. 预期：打补丁后第二次及以后切入同一会话，Scripting 时间下降一个数量级级别；
   首次进入仍需完整解析（属预期）。
4. 控制台长任务探针（DSH-Explorer 自带）：改前会出现
   `[dsh-explorer] 长任务 XXXXms`，改后应基本消失。

---

## 5 · 明确的分工边界

- 本计划由 DSH-Explorer 侧产出；deepseek-harness 仓库我未做改动（按约定外部仓库不动）。
- 把 §2 diff 交给桌面壳侧应用后重启 shell 即可验证。
- 后续若要我把补丁文件 + 重放脚本正式收进 dsh-desktop 仓库并接好构建流程，说一声即可。
