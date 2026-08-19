/**
 * 单文件代码视图：行号 + 语法高亮 + 相对 HEAD 的整文件增删着色。
 */

import { useMemo, type ReactNode } from 'react'
import { buildViewLines, countChanges, type ViewLine } from './gitViewLines'
import { langFromPath, tokenizeLine, tokenizeSource, type TokenSpan } from './highlight'
import { useVirtualSlice } from './useVirtualSlice'

export const CODE_LINE_H = 20

function renderSpans(spans: readonly TokenSpan[], fallback: string): ReactNode {
  if (spans.length === 0) return fallback.length > 0 ? fallback : ' '
  if (spans.length === 1 && spans[0].tok === 'plain') {
    return spans[0].text.length > 0 ? spans[0].text : ' '
  }
  return spans.map((span, index) => (
    span.tok === 'plain'
      ? span.text
      : <span key={index} className={`dshx-tok-${span.tok}`}>{span.text}</span>
  ))
}

function spansFor(line: ViewLine, lang: string, fileSpans: readonly TokenSpan[][]): TokenSpan[] {
  if (line.newNo !== null) {
    const aligned = fileSpans[line.newNo - 1]
    if (aligned !== undefined) return aligned
  }
  return tokenizeLine(line.text, lang)
}

export function CodeView({ path, content, patch, untracked }: {
  path: string
  content: string
  patch: string | null
  untracked: boolean
}): JSX.Element {
  const lang = langFromPath(path)
  const lines = useMemo(() => buildViewLines(content, patch, untracked), [content, patch, untracked])
  const fileSpans = useMemo(() => tokenizeSource(content, lang), [content, lang])
  const hasDiff = useMemo(() => lines.some(line => line.kind !== 'ctx'), [lines])
  const { wrapRef, from, to, onScroll } = useVirtualSlice(lines.length, CODE_LINE_H, `${path}:${lines.length}`)
  const lnDigits = Math.max(2, String(Math.max(lines.length, 1)).length)

  return (
    <div className="dshx-codeview" ref={wrapRef} onScroll={onScroll}>
      <div className="dshx-code-virt" style={{ height: Math.max(lines.length, 1) * CODE_LINE_H }}>
        <div className="dshx-code-rows" style={{ transform: `translateY(${from * CODE_LINE_H}px)` }}>
          {lines.slice(from, to).map((line, index) => (
            <div key={from + index} className={`dshx-code-line ${line.kind}`}>
              <span className="dshx-code-gutter" aria-hidden>
                {hasDiff && (
                  <span className="dshx-code-ln old" style={{ width: `${lnDigits + 1}ch` }}>
                    {line.oldNo ?? ''}
                  </span>
                )}
                <span className="dshx-code-ln" style={{ width: `${lnDigits + 1}ch` }}>
                  {line.newNo ?? ''}
                </span>
                {hasDiff && (
                  <span className="dshx-code-sign">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                )}
              </span>
              <span className="dshx-code-text">
                {renderSpans(spansFor(line, lang, fileSpans), line.text)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function gitStats(content: string, patch: string | null, untracked: boolean): {
  added: number
  deleted: number
  dirty: boolean
} {
  const lines = buildViewLines(content, patch, untracked)
  const counts = countChanges(lines)
  return { ...counts, dirty: untracked || counts.added > 0 || counts.deleted > 0 }
}
