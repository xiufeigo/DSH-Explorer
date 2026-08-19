/**
 * 把当前文件正文和 `git diff HEAD -- <file>` 合成「整文件 + 删除行插回原位」的行表。
 */

import { splitLines } from './highlight'

export type LineKind = 'ctx' | 'add' | 'del'

export interface ViewLine {
  kind: LineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

interface HunkLine {
  op: ' ' | '+' | '-'
  text: string
}

interface Hunk {
  oldStart: number
  newStart: number
  lines: HunkLine[]
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header !== null) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      hunks.push(current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('\\')) continue
    const op = line[0]
    if (op === '+' || op === '-' || op === ' ') {
      current.lines.push({ op, text: line.slice(1) })
    }
  }
  return hunks
}

function asPlain(rows: string[], kind: LineKind): ViewLine[] {
  if (rows.length === 0) {
    return [{
      kind,
      text: '',
      oldNo: kind === 'add' ? null : 1,
      newNo: kind === 'del' ? null : 1,
    }]
  }
  return rows.map((text, index) => ({
    kind,
    text,
    oldNo: kind === 'add' ? null : index + 1,
    newNo: kind === 'del' ? null : index + 1,
  }))
}

export function buildViewLines(content: string, patch: string | null, untracked: boolean): ViewLine[] {
  const rows = splitLines(content)
  if (untracked) return asPlain(rows, 'add')
  if (patch === null || patch.length === 0) return asPlain(rows, 'ctx')
  const hunks = parseHunks(patch)
  if (hunks.length === 0) return asPlain(rows, 'ctx')

  const out: ViewLine[] = []
  let newI = 1
  let oldI = 1
  for (const hunk of hunks) {
    if (hunk.newStart > 0 && hunk.newStart < newI) return asPlain(rows, 'ctx')
    while (newI < hunk.newStart && newI <= rows.length) {
      out.push({ kind: 'ctx', text: rows[newI - 1] ?? '', oldNo: oldI, newNo: newI })
      newI++
      oldI++
    }
    for (const line of hunk.lines) {
      if (line.op === ' ') {
        const text = newI <= rows.length ? rows[newI - 1] ?? line.text : line.text
        out.push({ kind: 'ctx', text, oldNo: oldI, newNo: newI })
        newI++
        oldI++
      } else if (line.op === '+') {
        const text = newI <= rows.length ? rows[newI - 1] ?? line.text : line.text
        out.push({ kind: 'add', text, oldNo: null, newNo: newI })
        newI++
      } else {
        out.push({ kind: 'del', text: line.text, oldNo: oldI, newNo: null })
        oldI++
      }
    }
  }
  while (newI <= rows.length) {
    out.push({ kind: 'ctx', text: rows[newI - 1] ?? '', oldNo: oldI, newNo: newI })
    newI++
    oldI++
  }
  if (out.length === 0) return asPlain(rows, 'ctx')
  return out
}

export function countChanges(lines: readonly ViewLine[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') deleted++
  }
  return { added, deleted }
}
