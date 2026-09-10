/**
 * Markdown 预览的渲染兜底边界：renderMarkdown 抛出未预见异常（或
 * dangerouslySetInnerHTML 注入的内容触发子树渲染错误）时，降级为
 * 错误提示而不是击穿整棵插件视图（客户端此前没有任何 ErrorBoundary，
 * 一个畸形 .md 就能白屏整个面板）。
 *
 * Markdown.ts 本体保持零依赖（md-selfcheck 的 CJS 沙箱约束），故本组件
 * 单独成文件；接线（包裹预览容器）由调用方完成。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface MdErrorBoundaryProps {
  children: ReactNode
  /** 出错时展示的标题文案（默认"预览渲染失败"）。 */
  title?: string
}

interface MdErrorBoundaryState {
  error: Error | null
}

export class MdErrorBoundary extends Component<MdErrorBoundaryProps, MdErrorBoundaryState> {
  state: MdErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MdErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dshx] markdown preview crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error !== null) {
      return (
        <div className="dshx-error" role="alert">
          {this.props.title ?? '预览渲染失败'}
          <span className="dshx-error-detail">{String(error.message ?? error)}</span>
        </div>
      )
    }
    return this.props.children
  }
}
