/**
 * DSH-Explorer — browser half（精简版）。
 *
 * 只剩两块：
 *  - 会话头「终端」按钮（`conversation.session.header.utilities`）：PTY 面板，
 *    开合与标签页状态在 store.ts，输出流走 Host 的 /dsh-explorer/pty；
 *  - 左侧栏工作区排序 + 置顶 / 指针拖拽：两个不是槽位的安装器，直接观察
 *    `sessions` / `workspaces` 服务（workspaceRecencyOrder / workspacePinOverlay）。
 *
 * 文件树与「工作区 | 文件」切换、右侧栏（审查 / 上下文 / 来源 / 编辑 / 预览）、
 * 摘要卡片、面板开关、通知音效、设置卡与载荷 fork 已整体删除。
 */

import { TerminalToggle } from './TerminalToggle'
import { disposeConversationHost } from './conversationHost'
import { createExplorerStore, type ExplorerStore } from './store'
import { injectStyles } from './styles'
import {
  installWorkspaceRecencyOrder,
  __resetForReload as resetWorkspaceRecencyOrderForReload,
} from './workspaceRecencyOrder'
import { installWorkspacePinOverlay } from './workspacePinOverlay'

interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: (props: any) => unknown): unknown
}

interface ExplorerClientContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
  slots: SlotsLike
  sessions: unknown
  workspaces: unknown
}

/** Required services: slot registry plus the two stores the ordering reads. */
export const inject = ['slots', 'sessions', 'workspaces']
export const name = 'dsh-explorer'

// 测试出口：冒烟脚本用假服务直测排序 / 置顶模块。
export {
  installWorkspaceRecencyOrder,
  __setPinsForTests,
  __resetForReload,
  getWorkspacePinSummary,
  resetWorkspacePinOrder,
  commitWorkspaceOrderIntent,
  beginWorkspaceDragHold,
  endWorkspaceDragHold,
} from './workspaceRecencyOrder'
export { installWorkspacePinOverlay } from './workspacePinOverlay'

export function apply(ctx: ExplorerClientContext): void {
  ctx.effect(() => () => {
    disposeConversationHost()
    // 模块单例复位：插件重载后旧实例的缓存/注册不能残留给新实例
    resetWorkspaceRecencyOrderForReload()
  }, 'dsh-explorer: host cleanup')
  if (typeof document !== 'undefined') {
    ctx.effect(() => injectStyles(), 'dsh-explorer: styles')
  }

  const store: ExplorerStore = createExplorerStore()

  ctx.effect(
    () => installWorkspaceRecencyOrder({
      sessions: ctx.sessions as never,
      workspaces: ctx.workspaces as never,
    }),
    'dsh-explorer: workspace recency order',
  )
  ctx.effect(
    () => installWorkspacePinOverlay({ workspaces: ctx.workspaces as never }),
    'dsh-explorer: workspace pin overlay',
  )

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-term',
      order: 15,
      inject: () => ({ store }),
    },
    TerminalToggle as never,
  ))
}
