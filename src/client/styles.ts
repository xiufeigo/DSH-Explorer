/**
 * DSH-Explorer browser half — stylesheet.
 * Colors ride the app's alias tokens (--dsw-alias-*) so light/dark follow
 * the active theme; every selector is prefixed dshx- to stay collision-free.
 */

export const EXPLORER_CSS = `
.dshx-root, .dshx-root * { box-sizing: border-box; }
.dshx-root {
  --dshx-bg: var(--dsw-alias-bg-base, #ffffff);
  --dshx-layer: var(--dsw-alias-bg-layer-1, #f6f6f7);
  --dshx-layer2: var(--dsw-alias-bg-layer-2, #ececee);
  --dshx-border: var(--dsw-alias-border-l1, rgba(20, 20, 30, 0.10));
  --dshx-border2: var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  --dshx-text: var(--dsw-alias-label-primary, #1b1b1f);
  --dshx-text2: var(--dsw-alias-label-secondary, #62626b);
  --dshx-accent: var(--dsw-alias-brand-primary, #3f6df5);
  --dshx-error: var(--dsw-alias-state-error-primary, #d5433e);
  --dshx-ok: var(--dsw-alias-state-success-primary, #2e9e5b);
  --dshx-warn: var(--dsw-alias-state-warn-primary, #b9790f);
  --dshx-add-bg: rgba(46, 158, 91, 0.12);
  --dshx-del-bg: rgba(213, 67, 62, 0.12);
  --dshx-hunk-bg: rgba(63, 109, 245, 0.10);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dshx-bg);
  color: var(--dshx-text);
  font-size: 13px;
  line-height: 1.5;
  contain: layout;
}
/* 宿主 AppFrame 给 grid-template-columns 做了 300ms 过渡：开合右侧栏时
   整列对话 + 审查 diff 每帧重排，必卡。插件在场时改为瞬时开合。 */
div[style*="grid-template-columns"]:has(.dshx-root) {
  transition: none !important;
}
div[style*="grid-template-columns"]:has(.dshx-root) > [data-side] {
  transition: none !important;
}
.dshx-scroll { overflow: auto; min-height: 0; flex: 1 1 auto; }
.dshx-page { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.dshx-page[hidden] { display: none !important; }

/* ── 上下文使用率仪表 ───────────────────────────────────────────────────── */
.dshx-meter-track {
  height: 8px; border-radius: 4px; background: var(--dshx-layer2);
  border: 1px solid var(--dshx-border); overflow: hidden;
}
.dshx-meter-fill {
  height: 100%; border-radius: 4px; background: var(--dshx-accent);
  transition: width 0.25s ease; min-width: 2px;
}
.dshx-meter-fill.hot { background: var(--dshx-warn); }

/* ── 顶部 tab 栏 ─────────────────────────────────────────────────────────── */
.dshx-tabbar {
  display: flex; align-items: stretch; gap: 2px;
  border-bottom: 1px solid var(--dshx-border);
  background: var(--dshx-layer);
  padding: 4px 6px 0 6px; overflow-x: auto; flex: none;
}
.dshx-tab {
  appearance: none; border: 1px solid var(--dshx-border); background: transparent;
  color: var(--dshx-text2); padding: 5px 10px; font-size: 12px; cursor: pointer;
  border-radius: 6px 6px 0 0; border-bottom: none; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
}
.dshx-tab:hover { color: var(--dshx-text); background: var(--dshx-layer2); }
.dshx-tab.active {
  color: var(--dshx-text); background: var(--dshx-bg);
  border-color: var(--dshx-border2); position: relative;
}
.dshx-tab.active::after {
  content: ''; position: absolute; left: 0; right: 0; top: -1px; height: 2px;
  background: var(--dshx-accent); border-radius: 2px 2px 0 0;
}
.dshx-tab-label { overflow: hidden; text-overflow: ellipsis; }
.dshx-tab-close {
  border: none; background: transparent; color: var(--dshx-text2); cursor: pointer;
  padding: 0 2px; font-size: 12px; border-radius: 4px; line-height: 1;
}
.dshx-tab-close:hover { color: var(--dshx-error); }
.dshx-tab-preview { opacity: 0.75; font-size: 10px; border: 1px solid var(--dshx-border); border-radius: 4px; padding: 0 4px; }

/* ── 面板主体 / 工具行 ───────────────────────────────────────────────────── */
.dshx-panel-header {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--dshx-border); flex: none;
}
.dshx-panel-title { font-weight: 600; font-size: 13px; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-btn {
  appearance: none; border: 1px solid var(--dshx-border); border-radius: 6px;
  background: var(--dshx-layer); color: var(--dshx-text); padding: 4px 10px;
  font-size: 12px; cursor: pointer;
}
.dshx-btn:hover { border-color: var(--dshx-border2); background: var(--dshx-layer2); }
.dshx-btn.primary { background: var(--dshx-accent); border-color: var(--dshx-accent); color: #fff; }
.dshx-btn.danger { color: var(--dshx-error); }
.dshx-btn.small { padding: 2px 8px; font-size: 11px; }
.dshx-seg {
  display: inline-flex; border: 1px solid var(--dshx-border); border-radius: 6px; overflow: hidden;
}
.dshx-seg button {
  appearance: none; border: none; background: var(--dshx-layer); color: var(--dshx-text2);
  padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.dshx-seg button + button { border-left: 1px solid var(--dshx-border); }
.dshx-seg button.active { background: var(--dshx-layer2); color: var(--dshx-text); font-weight: 600; }
.dshx-empty { color: var(--dshx-text2); padding: 24px 16px; text-align: center; }
.dshx-error { color: var(--dshx-error); padding: 16px; white-space: pre-wrap; word-break: break-all; }
.dshx-muted { color: var(--dshx-text2); font-size: 12px; }
.dshx-spin { animation: dshx-rotate 0.9s linear infinite; display: inline-block; }
@keyframes dshx-rotate { to { transform: rotate(360deg); } }

/* ── 审查视图 ────────────────────────────────────────────────────────────── */
.dshx-review { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; contain: layout; }
.dshx-review-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dshx-border); flex: none; flex-wrap: wrap; }
.dshx-review-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dshx-file-pane {
  display: flex; flex-direction: column; min-height: 0; flex: none;
  border-bottom: 1px solid var(--dshx-border);
}
.dshx-review-body > :last-child { border-bottom: none; }
.dshx-file-pane:last-child { border-bottom: none; }
.dshx-file-pane.open { flex: 1 1 0; min-height: 72px; }
.dshx-file-pane.open.empty { flex: 0 0 auto; min-height: 0; }
.dshx-file-pane-head {
  appearance: none; border: none; width: 100%;
  flex: none; display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; cursor: pointer; user-select: none; text-align: left;
  background: var(--dshx-layer); color: var(--dshx-text2);
  font: inherit; font-size: 12px; font-weight: 600;
}
.dshx-file-pane-head:hover { background: var(--dshx-layer2); color: var(--dshx-text); }
.dshx-file-pane-chevron {
  flex: none; display: inline-block; width: 0; height: 0;
  border-style: solid; border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent currentColor;
  transition: transform 150ms ease;
}
.dshx-file-pane-chevron.open { transform: rotate(90deg); }
.dshx-file-pane-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-file-pane-count { flex: none; font-weight: 500; font-size: 11px; opacity: 0.8; }
.dshx-file-pane-body { flex: 1 1 auto; overflow: auto; min-height: 0; contain: layout paint; overflow-anchor: none; }
.dshx-file-pane-empty { color: var(--dshx-text2); padding: 14px 10px; font-size: 12px; text-align: center; }
.dshx-file-virt { position: relative; width: 100%; }
.dshx-file-item {
  display: flex; align-items: center; gap: 6px; padding: 0 10px; cursor: pointer;
  height: 28px; box-sizing: border-box;
  border-bottom: 1px solid var(--dshx-border); font-size: 12px; overflow: hidden;
  contain: layout paint;
}
.dshx-file-item:hover { background: var(--dshx-layer); }
.dshx-file-item.active { background: var(--dshx-layer2); }
.dshx-file-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dshx-badge {
  flex: none; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px;
  border: 1px solid var(--dshx-border2); color: var(--dshx-text2);
}
.dshx-badge.A { color: var(--dshx-ok); border-color: var(--dshx-ok); }
.dshx-badge.M { color: var(--dshx-warn); border-color: var(--dshx-warn); }
.dshx-badge.D, .dshx-badge.U { color: var(--dshx-error); border-color: var(--dshx-error); }
.dshx-badge.R { color: var(--dshx-accent); border-color: var(--dshx-accent); }
.dshx-badge.\?\?, .dshx-badge.\?\?\~ { color: #8a5cf6; border-color: #8a5cf6; }
.dshx-diff-pane {
  display: flex; flex-direction: column; min-height: 0; flex: none;
  border-bottom: 1px solid var(--dshx-border);
}
.dshx-diff-pane.open { flex: 2 1 0; min-height: 96px; }
.dshx-diffwrap { flex: 1 1 auto; overflow: auto; min-width: 0; min-height: 0; contain: layout paint; overflow-anchor: none; }
.dshx-diff-virt { position: relative; min-width: max-content; width: 100%; }
.dshx-diff {
  margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; line-height: 19px;
}
.dshx-diff-line {
  padding: 0 10px; height: 19px; line-height: 19px;
  white-space: pre; overflow: hidden;
}
.dshx-diff-line.add { background: var(--dshx-add-bg); color: var(--dshx-text); }
.dshx-diff-line.del { background: var(--dshx-del-bg); color: var(--dshx-text); }
.dshx-diff-line.hunk { background: var(--dshx-hunk-bg); color: var(--dshx-accent); }
.dshx-diff-line.meta { color: var(--dshx-text2); }
.dshx-diff-header { padding: 8px 10px; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--dshx-border); word-break: break-all; }
.dshx-commit-item { display: flex; gap: 8px; padding: 4px 10px; font-size: 12px; font-family: ui-monospace, monospace; border-bottom: 1px solid var(--dshx-border); }
.dshx-commit-hash { color: var(--dshx-accent); flex: none; }

/* ── 上下文视图 ──────────────────────────────────────────────────────────── */
.dshx-ctx { padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; }
.dshx-section { border: 1px solid var(--dshx-border); border-radius: 8px; overflow: hidden; }
.dshx-section-title {
  padding: 7px 12px; background: var(--dshx-layer); font-weight: 600; font-size: 12px;
  border-bottom: 1px solid var(--dshx-border); display: flex; align-items: center; gap: 8px;
}
.dshx-section-body { padding: 8px 12px; }
.dshx-todo-item { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 13px; }
.dshx-todo-item input { margin-top: 3px; accent-color: var(--dshx-accent); }
.dshx-todo-item.done span { text-decoration: line-through; color: var(--dshx-text2); }
.dshx-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.dshx-kv dt { color: var(--dshx-text2); }
.dshx-kv dd { margin: 0; word-break: break-all; }
.dshx-chip {
  display: inline-block; border: 1px solid var(--dshx-border); border-radius: 10px;
  padding: 1px 8px; font-size: 11px; margin: 2px 3px 2px 0; color: var(--dshx-text2);
  font-family: ui-monospace, monospace;
}
.dshx-goal-phase { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 8px; }
.dshx-goal-phase.active { color: var(--dshx-ok); border: 1px solid var(--dshx-ok); }
.dshx-goal-phase.blocked { color: var(--dshx-error); border: 1px solid var(--dshx-error); }
.dshx-goal-phase.paused { color: var(--dshx-warn); border: 1px solid var(--dshx-warn); }
.dshx-goal-phase.complete { color: var(--dshx-text2); border: 1px solid var(--dshx-border2); }
.dshx-manifest-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; border-bottom: 1px dashed var(--dshx-border); }
.dshx-manifest-row:last-child { border-bottom: none; }
.dshx-manifest-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 编辑器 / 预览 ───────────────────────────────────────────────────────── */
.dshx-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dshx-editor-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dshx-border); flex: none; }
.dshx-editor-toolbar .path { flex: 1 1 auto; font-size: 11px; color: var(--dshx-text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dshx-btn.on { background: var(--dshx-layer2); color: var(--dshx-text); border-color: var(--dshx-border2); }
.dshx-code-stat { flex: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; font-weight: 600; display: inline-flex; gap: 6px; }
.dshx-code-stat .add { color: var(--dshx-ok); }
.dshx-code-stat .del { color: var(--dshx-error); }
.dshx-codeview {
  flex: 1 1 auto; overflow: auto; min-width: 0; min-height: 0;
  contain: layout paint; overflow-anchor: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px; line-height: 20px; tab-size: 2;
  background: var(--dshx-bg); color: var(--shiki-foreground, var(--dshx-text));
}
.dshx-code-virt { position: relative; min-width: max-content; width: 100%; }
.dshx-code-rows { will-change: transform; }
.dshx-code-line {
  display: flex; height: 20px; line-height: 20px; white-space: pre;
  background: var(--dshx-bg);
}
.dshx-code-line.add { background: var(--dshx-add-bg); box-shadow: inset 3px 0 0 var(--dshx-ok); }
.dshx-code-line.del { background: var(--dshx-del-bg); box-shadow: inset 3px 0 0 var(--dshx-error); }
.dshx-code-gutter {
  display: flex; flex: none; position: sticky; left: 0; z-index: 1;
  background: inherit; user-select: none;
}
.dshx-code-ln {
  flex: none; text-align: right; padding: 0 8px 0 6px; color: var(--dshx-text2);
}
.dshx-code-line.add .dshx-code-ln { color: var(--dshx-ok); }
.dshx-code-line.del .dshx-code-ln { color: var(--dshx-error); }
.dshx-code-sign {
  flex: none; width: 14px; text-align: center; color: var(--dshx-text2);
}
.dshx-code-line.add .dshx-code-sign { color: var(--dshx-ok); }
.dshx-code-line.del .dshx-code-sign { color: var(--dshx-error); }
.dshx-code-text { flex: 1 1 auto; padding-right: 12px; min-width: 0; }
.dshx-tok-kw { color: var(--shiki-token-keyword); }
.dshx-tok-str { color: var(--shiki-token-string); }
.dshx-tok-cmt { color: var(--shiki-token-comment); font-style: italic; }
.dshx-tok-num { color: var(--shiki-token-constant); }
.dshx-tok-fn { color: var(--shiki-token-function); }
.dshx-tok-type { color: var(--shiki-token-constant); }
.dshx-tok-param { color: var(--shiki-token-parameter); }
.dshx-tok-punct { color: var(--shiki-token-punctuation); }
.dshx-editor-edit { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
.dshx-editor-gutter {
  flex: none; margin: 0; padding: 8px 0; overflow: hidden;
  text-align: right; color: var(--dshx-text2); user-select: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px; line-height: 20px; background: var(--dshx-layer);
  border-right: 1px solid var(--dshx-border);
}
.dshx-editor-textarea {
  flex: 1 1 auto; width: 100%; resize: none; border: none; outline: none;
  padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px; line-height: 20px; background: var(--dshx-bg); color: var(--dshx-text);
  tab-size: 2; white-space: pre; overflow: auto;
}
.dshx-preview { padding: 14px 16px; overflow: auto; height: 100%; }
.dshx-preview h1, .dshx-preview h2, .dshx-preview h3, .dshx-preview h4 { margin: 1.1em 0 0.5em; line-height: 1.3; }
.dshx-preview h1 { font-size: 1.6em; border-bottom: 1px solid var(--dshx-border); padding-bottom: 6px; }
.dshx-preview h2 { font-size: 1.35em; border-bottom: 1px solid var(--dshx-border); padding-bottom: 4px; }
.dshx-preview h3 { font-size: 1.15em; }
.dshx-preview p { margin: 0.6em 0; }
.dshx-preview ul, .dshx-preview ol { padding-left: 1.6em; margin: 0.5em 0; }
.dshx-preview li { margin: 0.15em 0; }
.dshx-preview li.dshx-task { list-style: none; margin-left: -1.4em; display: flex; gap: 8px; align-items: flex-start; }
.dshx-preview li.dshx-task input { margin-top: 4px; }
.dshx-preview blockquote { border-left: 3px solid var(--dshx-border2); margin: 0.6em 0; padding: 2px 12px; color: var(--dshx-text2); }
.dshx-preview code { background: var(--dshx-layer2); border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, monospace; font-size: 0.92em; }
.dshx-preview pre.dshx-code { background: var(--dshx-layer); border: 1px solid var(--dshx-border); border-radius: 8px; padding: 10px 12px; overflow: auto; }
.dshx-preview pre.dshx-code code { background: transparent; padding: 0; }
.dshx-preview img { max-width: 100%; }
.dshx-preview a { color: var(--dshx-accent); }
.dshx-preview hr { border: none; border-top: 1px solid var(--dshx-border); margin: 1em 0; }
.dshx-preview table { border-collapse: collapse; }
.dshx-preview-frame { width: 100%; height: 100%; border: none; background: #fff; }

/* ── 左侧栏：文件模式（样式逐项对齐原生 WorkspaceBrowser） ──────────────── */
.dshx-sidebar {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  box-sizing: border-box;
  padding-right: var(--dsh-sidebar-inline-padding, 8px);
  background: var(--dshx-bg); color: var(--dshx-text);
}
/* 头栏 = 原生 sectionHeader 规格：36px、右对齐动作簇、12px 圆角。 */
.dshx-sidebar-header {
  flex: none; display: flex; align-items: center; justify-content: flex-end;
  gap: 4px; height: 36px; padding-left: 4px; margin: 2px -4px 4px 0;
  box-sizing: border-box; border-radius: 12px; overflow: hidden;
  color: var(--dsw-alias-label-tertiary, var(--dshx-text2));
}
/* 顶部座位的锚点：占位行隐藏，tab 经 portal 画进下方头栏。
   只按座位名藏父级，禁止用 :has(锚点) 藏 footer.action —— Cordis 等也可能占那个 list 槽。 */
.dshx-sidebar-tabs-anchor { display: none !important; }
div:has(> [data-slot="sidebar.workspaces.actions"]) { display: none !important; }
/* 底部回退槽：tab 已 portal 走后如果没有任何按钮，把空动作条收掉。 */
div:has(> [data-slot="sidebar.footer.action"]):not(:has(button)):not(:has(a)):not(:has(input)) {
  display: none !important;
}
/* 桌面亚克力侧栏会清掉实心底，但清不到列表底部的 fade 渐变（background-image），
   不透明的 sidebar-fill 叠在玻璃上就是设置上方那条白带。 */
[data-dsh-frosted-sidebar] span[class*="fade"] {
  background: none !important;
  background-image: none !important;
}
.dshx-sidebar-tabs-host,
.dshx-sidebar-tabs-slot {
  flex: none; display: flex; align-items: center;
  min-width: 0; margin-right: auto; height: 100%;
}
/* 藏起原生「工作区」标题，避免和 tab 叠字。 */
.dshx-sidebar-tabs-host + span { display: none !important; }
/* 原生搜索展开时把头栏让出来（host 的下下个兄弟是 searchSlot）。 */
.dshx-sidebar-tabs-host:has(+ * + [class*="searchSlotExpanded"]) {
  max-width: 0; margin: 0; opacity: 0; overflow: hidden; pointer-events: none;
}
/* 官方收起轨（WorkspaceBrowser.rail）是图标列：不要把 tab 挤成竖排字。 */
[class*="rail"] > [class*="sectionHeader"] > [data-dshx-tabs-host],
[class*="rail"] > [class*="sectionHeader"] .dshx-sidebar-tabs {
  display: none !important;
}
.dshx-sidebar-tabs {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; height: 36px; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, var(--dshx-text2));
  line-height: 20px;
}
.dshx-sidebar-tab {
  appearance: none; border: none; background: transparent; padding: 0;
  cursor: pointer; font: inherit; color: inherit; line-height: 20px;
}
.dshx-sidebar-tab:hover { color: var(--dsw-alias-label-primary, var(--dshx-text)); }
.dshx-sidebar-tab.on {
  color: var(--dsw-alias-label-primary, var(--dshx-text));
  cursor: default;
}
.dshx-sidebar-tab-sep { opacity: 0.45; user-select: none; }
/* 图标按钮 = 原生 iconButton 规格：28px 圆形 ghost、secondary 色、hover 圆底。 */
.dshx-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 50%; padding: 0;
  background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, var(--dshx-text2));
}
.dshx-icon-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dshx-layer2));
  color: var(--dsw-alias-label-primary, var(--dshx-text));
}
.dshx-sidebar-body { flex: 1 1 auto; overflow: auto; min-height: 0; }

/* ── 文件树（行规格照抄 WorkspaceBrowser Rows.module.css） ───────────────── */
.dshx-tree { padding: 4px 0; }
.dshx-tree-row {
  display: flex; align-items: center; gap: 0; box-sizing: border-box;
  border-radius: 8px; padding: 0 8px; cursor: pointer; user-select: none;
  color: var(--dsw-alias-label-primary, var(--dshx-text));
}
.dshx-tree-row.dir { height: 34px; }
.dshx-tree-row.file { height: 32px; }
.dshx-tree-row:hover,
.dshx-tree-row.selected {
  background: var(--dsw-alias-interactive-bg-hover, var(--dshx-layer2));
}
/* 16px 图标槽 + 4px 标题间距（每级缩进 22px，由行内 paddingLeft 驱动）。 */
.dshx-tree-slot {
  flex: none; width: 16px; height: 20px; display: inline-flex;
  align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary, var(--dshx-text2));
}
/* 目录默认显示文件夹图标；hover 切换为三角箭头（原生 project 行行为）。 */
.dshx-tree-chevron {
  display: none;
  color: var(--dsw-alias-label-caption, var(--dshx-text2));
  transition: transform 150ms var(--ds-ease-in-out, ease);
}
.dshx-tree-folder { display: inline-flex; }
.dshx-tree-file-icon { color: var(--dsw-alias-label-tertiary, var(--dshx-text2)); }
.dshx-tree-file-icon svg { display: block; flex: none; }
.dshx-file-tile {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 3px; box-sizing: border-box;
  font-size: 7px; font-weight: 800; letter-spacing: -0.35px; line-height: 1;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
}
.dshx-tree-row:hover .dshx-tree-chevron { display: inline-flex; }
.dshx-tree-row:hover .dshx-tree-folder { display: none; }
.dshx-tree-row.open .dshx-tree-chevron { transform: rotate(90deg); }
.dshx-tree-name {
  flex: 1; min-width: 0; margin-left: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; line-height: 20px;
}
.dshx-tree-size {
  flex: none; margin-left: 6px;
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary, var(--dshx-text2));
}

/* ── 右键菜单（对齐原生菜单质感） ────────────────────────────────────────── */
.dshx-menu {
  position: fixed; z-index: 10000; min-width: 150px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, var(--dshx-border2));
  border-radius: 8px; padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
}
.dshx-menu-item {
  padding: 6px 10px; border-radius: 6px; cursor: pointer;
  font-size: 14px; line-height: 20px;
  color: var(--dsw-alias-label-primary, var(--dshx-text));
}
.dshx-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dshx-layer2)); }
.dshx-menu-item.disabled { opacity: 0.4; cursor: default; }

/* ── 会话头部右上角：右侧栏开关（原生 iconButton 规格） ─────────────────── */
.dshx-panel-toggle {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 50%; padding: 0;
  background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, var(--dshx-text2));
}
.dshx-panel-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dshx-layer2));
  color: var(--dsw-alias-label-primary, var(--dshx-text));
}
.dshx-panel-toggle.on { color: var(--dsw-alias-state-business-primary, var(--dshx-accent)); }
/* 原生面板图标水平镜像 → 右侧面板语义。 */
.dshx-panel-toggle-icon { transform: scaleX(-1); }

/* ── 中栏会话大纲 / 置顶摘要（portal 到对话滚动容器，需自带色板） ───────── */
.dshx-msg-rail-host, .dshx-summary-host, .dshx-summary-float, .dshx-msg-rail, .dshx-summary, .dshx-msg-card {
  --dshx-bg: var(--dsw-alias-bg-base, #ffffff);
  --dshx-layer: var(--dsw-alias-bg-layer-1, #f6f6f7);
  --dshx-layer2: var(--dsw-alias-bg-layer-2, #ececee);
  --dshx-border: var(--dsw-alias-border-l1, rgba(20, 20, 30, 0.10));
  --dshx-border2: var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  --dshx-text: var(--dsw-alias-label-primary, #1b1b1f);
  --dshx-text2: var(--dsw-alias-label-secondary, #62626b);
  --dshx-accent: var(--dsw-alias-brand-primary, #3f6df5);
  --dshx-error: var(--dsw-alias-state-error-primary, #d5433e);
  --dshx-ok: var(--dsw-alias-state-success-primary, #2e9e5b);
}
.dshx-msg-rail-host, .dshx-summary-host {
  position: sticky; top: 0; height: 0; z-index: 6;
  pointer-events: none; overflow: visible; flex: none;
}
.dshx-msg-rail-host { align-self: flex-start; width: 0; }
.dshx-summary-host { align-self: flex-end; width: 0; margin-left: auto; }
/* 会话大纲只 portal 到对话列，头部不留锚点。
   禁止再用 :has() 藏父级：utilities 是 list 槽，父级 [data-slot] 里还有
   Session log / 摘要 / 面板，藏父级会把右上角整排控件一起干掉。 */
.dshx-msg-rail {
  pointer-events: auto;
  position: absolute;
  left: 8px;
  /* 宿主 height:0，百分比 top 无效；用滚动视口减去输入区后垂直居中。 */
  top: calc((var(--dshx-scrollport-h, 60vh) - var(--dsh-composer-height, 152px)) / 2);
  transform: translateY(-50%);
  width: 28px; height: auto;
  max-height: calc(var(--dshx-scrollport-h, 60vh) - var(--dsh-composer-height, 152px) - 24px);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 4px 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: none;
}
.dshx-msg-rail::-webkit-scrollbar { width: 0; height: 0; }
.dshx-msg-tick {
  appearance: none; border: none; background: transparent; padding: 0;
  width: 22px; height: 11px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-primary, var(--dshx-text));
}
.dshx-msg-tick-bar {
  display: block; height: 1px; border-radius: 1px;
  background: currentColor; opacity: 0.28;
  transition: width 140ms ease, height 140ms ease, opacity 140ms ease;
}
.dshx-msg-tick.on .dshx-msg-tick-bar,
.dshx-msg-tick:hover .dshx-msg-tick-bar {
  height: 2px; opacity: 0.92;
}
.dshx-msg-card {
  position: fixed; z-index: 50; width: 280px;
  box-sizing: border-box; padding: 12px 14px 10px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, var(--dshx-bg, #fff));
  color: var(--dsw-alias-label-primary, #1b1b1f);
  box-shadow: 0 8px 28px rgba(16, 16, 24, 0.12), 0 1px 2px rgba(16, 16, 24, 0.04);
  border: 1px solid var(--dsw-alias-border-l1, rgba(20, 20, 30, 0.08));
  cursor: pointer;
}
.dshx-msg-card, .dshx-msg-card * { box-sizing: border-box; }
.dshx-msg-card-title {
  font-size: 14px; font-weight: 600; line-height: 20px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dshx-msg-card-body {
  margin-top: 6px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, #62626b);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.dshx-msg-card-foot {
  margin-top: 10px; display: flex; align-items: center; justify-content: flex-end; gap: 4px;
  font-size: 12px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #8a8a93);
}
.dshx-msg-card-go { font-size: 14px; line-height: 1; transform: translateY(-0.5px); }
[data-chat-anchor-key].dshx-msg-flash {
  outline: 2px solid var(--dsw-alias-brand-primary, #3f6df5);
  outline-offset: 4px; border-radius: 8px;
}

.dshx-summary-pin {
  pointer-events: auto; position: absolute; right: 12px; top: 8px; width: 280px;
  max-height: calc(var(--dshx-scrollport-h, 60vh) - var(--dsh-composer-height, 140px) - 16px);
  overflow: auto;
}
.dshx-summary-float {
  position: fixed; z-index: 40; width: 300px; max-height: min(72vh, 640px); overflow: auto;
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.18);
}
.dshx-summary {
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base, var(--dshx-bg, #fff));
  border: 1px solid var(--dshx-border2); border-radius: 12px;
  padding: 10px 10px 8px; color: var(--dshx-text); font-size: 13px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
}
.dshx-summary, .dshx-summary * { box-sizing: border-box; }
.dshx-summary-kicker {
  font-size: 12px; font-weight: 600; color: var(--dshx-text2);
  padding: 2px 6px 8px;
}
.dshx-summary-row {
  appearance: none; border: none; background: transparent; width: 100%;
  display: flex; align-items: center; gap: 8px; padding: 7px 6px;
  border-radius: 8px; cursor: pointer; color: var(--dshx-text); font: inherit; text-align: left;
}
.dshx-summary-row:hover { background: var(--dshx-layer); }
.dshx-summary-row:disabled { opacity: 0.55; cursor: default; }
.dshx-summary-ico { width: 18px; flex: none; color: var(--dshx-text2); text-align: center; }
.dshx-summary-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-summary-stat { flex: none; font-variant-numeric: tabular-nums; font-size: 12px; }
.dshx-summary-stat .add { color: var(--dshx-ok); }
.dshx-summary-stat .del { color: var(--dshx-error); }
.dshx-summary-caret {
  width: 0; height: 0; border-style: solid; border-width: 4px 4px 0 4px;
  border-color: currentColor transparent transparent transparent; opacity: 0.55;
}
.dshx-summary-ext { flex: none; opacity: 0.55; font-size: 12px; }
.dshx-summary-menu {
  margin: 0 6px 6px; padding: 4px; border: 1px solid var(--dshx-border);
  border-radius: 8px; background: var(--dshx-layer); max-height: 180px; overflow: auto;
}
.dshx-summary-menu-item {
  appearance: none; border: none; background: transparent; width: 100%;
  text-align: left; padding: 5px 8px; border-radius: 6px; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--dshx-text);
}
.dshx-summary-menu-item:hover, .dshx-summary-menu-item.on { background: var(--dshx-layer2); }
.dshx-summary-commit { padding: 0 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.dshx-summary-input {
  width: 100%; resize: vertical; min-height: 56px; border-radius: 8px;
  border: 1px solid var(--dshx-border); background: var(--dshx-bg); color: var(--dshx-text);
  padding: 6px 8px; font: inherit; font-size: 12px;
}
.dshx-summary-commit-actions { display: flex; gap: 6px; }
.dshx-summary-note { color: var(--dshx-text2); font-size: 12px; padding: 4px 8px 8px; white-space: pre-wrap; }
.dshx-summary-section { padding: 8px 6px 4px; border-top: 1px solid var(--dshx-border); margin-top: 4px; }
.dshx-summary-section-title { font-size: 11px; font-weight: 600; color: var(--dshx-text2); padding: 0 2px 6px; }
.dshx-summary-agents {
  appearance: none; border: none; background: transparent; width: 100%;
  display: flex; align-items: center; gap: 8px; padding: 4px 2px; cursor: pointer;
  color: inherit; font: inherit; text-align: left; border-radius: 8px;
}
.dshx-summary-agents:hover { background: var(--dshx-layer); }
.dshx-summary-dots { display: inline-flex; align-items: center; }
.dshx-summary-dot {
  width: 18px; height: 18px; border-radius: 50%; display: inline-block;
  border: 2px solid var(--dshx-bg); margin-left: -6px;
}
.dshx-summary-dots .dshx-summary-dot:first-child { margin-left: 0; }
.dshx-summary-dot.lg { width: 22px; height: 22px; margin: 0; border-width: 0; flex: none; }
.dshx-summary-agent-stat {
  margin-left: auto; display: flex; flex-direction: column; align-items: flex-end;
  font-size: 11px; color: var(--dshx-text2); line-height: 1.3;
}
.dshx-summary-source { padding: 4px 2px 6px; display: flex; flex-direction: column; gap: 2px; }
.dshx-summary-source-title { font-size: 13px; }
.dshx-summary-source-sub { font-size: 11px; color: var(--dshx-text2); }
.dshx-summary-all {
  appearance: none; border: none; background: transparent; color: var(--dshx-accent);
  cursor: pointer; font: inherit; font-size: 12px; padding: 6px 2px;
}
.dshx-summary-empty { color: var(--dshx-text2); font-size: 12px; padding: 4px 2px 8px; }

.dshx-subpage { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dshx-subpage-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--dshx-border); flex: none;
}
.dshx-agent-row {
  appearance: none; border: none; background: transparent; width: 100%;
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  cursor: pointer; color: inherit; font: inherit; text-align: left;
  border-bottom: 1px solid var(--dshx-border);
}
.dshx-agent-row:hover { background: var(--dshx-layer); }
.dshx-agent-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshx-agent-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-agent-status { font-size: 11px; color: var(--dshx-text2); }
.dshx-agent-time { flex: none; font-size: 11px; color: var(--dshx-text2); }
.dshx-transcript { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.dshx-bubble {
  border: 1px solid var(--dshx-border); border-radius: 10px; padding: 8px 10px;
  background: var(--dshx-layer);
}
.dshx-bubble.user { background: var(--dshx-bg); }
.dshx-bubble-meta { font-size: 11px; color: var(--dshx-text2); margin-bottom: 4px; }
.dshx-bubble-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.dshx-sources { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.dshx-source-card { border: 1px solid var(--dshx-border); border-radius: 10px; overflow: hidden; }
.dshx-source-head {
  appearance: none; border: none; background: var(--dshx-layer); width: 100%;
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  cursor: pointer; color: inherit; font: inherit; text-align: left;
}
.dshx-source-icon { flex: none; opacity: 0.55; }
.dshx-source-page {
  display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 8px 36px;
  border-top: 1px solid var(--dshx-border); color: var(--dshx-text);
  text-decoration: none; font-size: 12px;
}
.dshx-source-page:hover { background: var(--dshx-layer); }
.dshx-source-page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-source-page-snip { color: var(--dshx-text2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
`

export function injectStyles(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-explorer'
  tag.textContent = EXPLORER_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
