/**
 * DSH-Explorer 浏览器端 Markdown 渲染器（零依赖、HTML 安全）。
 *
 * 块级：ATX / Setext 标题、hr、嵌套引用（含懒续行）、围栏代码块（接语法高亮 +
 * 语言徽章）、缩进代码块、front matter、多级有序/无序/任务列表（含 start 与
 * 松散段落）、GFM 表格（含对齐）、引用链接定义、脚注定义。
 * 行内：代码 span（多反引号）、图片、链接（行内 / 引用 / 自动链接 / 邮箱 /
 * Wiki）、强调 ** __ * _、删除线 ~~、高亮 ==、脚注引用、反斜杠转义、
 * HTML 实体透传、无属性白名单 HTML、$$ 数学块。
 *
 * 安全模型：原文先转义再生成标签；URL 只放行安全协议；
 * 原始 HTML 仅转换无属性的白名单标签，其余一律按文本显示。
 */

import { tokenizeSource, type TokenSpan } from './highlight'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 私有区哨兵（源文档几乎不可能出现）。 */
const ST_TAG = '\uE100' // 标签掩藏占位开始
const EN_TAG = '\uE101'
const ST_ESC = '\uE110' // 转义字符占位开始
const EN_ESC = '\uE111'
const STRAY_PUA = /[\uE000-\uF8FF]/g

interface RefDef {
  href: string
  title: string | null
}

interface RenderCtx {
  refs: Map<string, RefDef>
  footNotes: Map<string, string>
  footOrder: string[]
}

// ─── URL 白名单 ─────────────────────────────────────────────────────────────

function safeUrl(dest: string, image: boolean): string {
  const url = dest.trim().replace(/^<([\s\S]*)>$/, '$1').trim()
  // WHATWG URL 解析会剥掉 href 里任意位置的 tab/换行等 C0 控制字符——
  // 不先剥净就判协议，会被 `java<TAB>script:` 绕过（点击按
  // javascript: 执行）。检测与返回值都用净化后的串（空格保留，仅相对
  // 路径语义相关；控制字符对合法链接无意义）。
  const cleaned = url.replace(/[\u0000-\u001f]+/g, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
  if (scheme !== null) {
    const id = scheme[1].toLowerCase()
    if (id === 'http' || id === 'https' || id === 'mailto') return cleaned
    if (image && id === 'data' && /^data:image\/(?:png|jpe?g|gif|webp|bmp);/i.test(cleaned)) return cleaned
    return '#'
  }
  return cleaned
}

function attr(text: string): string {
  return escapeHtml(text).replace(/\n/g, ' ')
}

// ─── 缩进度量（tab 按 4 列停位） ─────────────────────────────────────────────

function indentWidth(line: string): number {
  let width = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') width++
    else if (ch === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

function cutIndent(line: string, width: number): string {
  let w = 0
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === ' ') w++
    else if (ch === '\t') w += 4 - (w % 4)
    else break
    i++
    if (w >= width) break
  }
  return line.slice(i)
}

const trimmedRight = (line: string): string => line.replace(/[ \t]+$/, '')

// ─── 行内解析基础 ────────────────────────────────────────────────────────────

function isAsciiPunct(ch: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch)
}

function countRun(src: string, at: number, ch: string): number {
  let n = 0
  while (at + n < src.length && src[at + n] === ch) n++
  return n
}

function findCodeClose(src: string, from: number, run: number): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '`') {
      const n = countRun(src, i, '`')
      if (n === run) return i
      i += n
      continue
    }
    i++
  }
  return -1
}

interface DestTitle {
  dest: string
  title: string | null
  end: number
}

/** 解析 `(dest "title")`，src[at] 必须是 '('。失败返回 null。 */
function parseDestTitle(src: string, at: number): DestTitle | null {
  let k = at + 1
  while (k < src.length && /[ \t\n]/.test(src[k])) k++
  let dest = ''
  if (src[k] === '<') {
    const close = src.indexOf('>', k + 1)
    if (close < 0) return null
    dest = src.slice(k + 1, close)
    k = close + 1
  } else {
    const start = k
    let depth = 0
    while (k < src.length) {
      const ch = src[k]
      if (ch === '\\' && k + 1 < src.length) { k += 2; continue }
      if (/[ \t\n]/.test(ch)) {
        let j = k
        while (j < src.length && /[ \t]/.test(src[j])) j++
        if (src[j] === '"' || src[j] === "'" || src[j] === '(') break // 后面是标题
        k++
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        if (depth === 0) break
        depth--
      }
      k++
    }
    if (depth !== 0) return null
    dest = src.slice(start, k)
  }
  while (k < src.length && /[ \t\n]/.test(src[k])) k++
  let title: string | null = null
  if (k < src.length && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
    const closer = src[k] === '(' ? ')' : src[k]
    const bodyStart = k + 1
    let j = bodyStart
    while (j < src.length && src[j] !== closer) {
      if (src[j] === '\\') j++
      j++
    }
    if (j >= src.length) return null
    title = src.slice(bodyStart, j).replace(/\\(.)/g, '$1').trim()
    k = j + 1
    while (k < src.length && /[ \t\n]/.test(src[k])) k++
  }
  if (src[k] !== ')') return null
  return { dest: dest.replace(/\\([()])/g, '$1'), title, end: k + 1 }
}

const normRefKey = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, ' ')

interface LinkParse {
  html: string
  next: number
}

type InlineFn = (text: string) => string

/** 方括号配对扫描预算：超出按普通文本处理（未闭合 '[' 逐个全文扫描曾是 O(n²)）。 */
const BRACKET_SCAN_MAX = 1000
/** 块嵌套深度上限（引用/列表互递归）：超出按段落文本处理，防栈溢出与超二次扫描。 */
const MAX_NEST_DEPTH = 100
/** 脚注引用 [^label]：sticky 正则避免每个 '[' 都 slice 出剩余全文。 */
const RE_FOOTNOTE_REF = /\[\^([^\]\s]+)\]/y

/**
 * 解析以 src[at]==='[' 开头的脚注引用 / 引用式或行内式链接与图片。
 * 失败返回 null（调用方按普通文本处理）。
 */
function parseBracket(
  src: string,
  at: number,
  ctx: RenderCtx,
  inline: InlineFn,
  isImage: boolean,
): LinkParse | null {
  // 脚注 [^label]（仅有定义的标签升级为脚注引用；未定义的按原文显示，
  // 避免悬空锚点与空脚注项。定义由入口预扫描先行登记，支持前向引用）
  if (!isImage) {
    RE_FOOTNOTE_REF.lastIndex = at
    const fnm = RE_FOOTNOTE_REF.exec(src)
    if (fnm !== null && ctx.footNotes.has(fnm[1])) {
      const label = fnm[1]
      let idx = ctx.footOrder.indexOf(label)
      if (idx < 0) { idx = ctx.footOrder.length; ctx.footOrder.push(label) }
      const n = idx + 1
      return {
        html: `<sup class="dshx-fnref"><a href="#dshx-fn-${n}" id="dshx-fnref-${n}">${n}</a></sup>`,
        next: at + fnm[0].length,
      }
    }
  }

  // 匹配方括号体（允许嵌套一层计数；扫描限预算防未闭合 '[' 的 O(n²)）
  let depth = 0
  let close = -1
  const limit = Math.min(src.length, at + BRACKET_SCAN_MAX)
  for (let k = at; k < limit; k++) {
    const ch = src[k]
    if (ch === '\\') { k++; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) { close = k; break }
    }
  }
  if (close < 0) return null
  const text = src.slice(at + 1, close)

  let href: string | null = null
  let title: string | null = null
  let next = close + 1

  if (src[close + 1] === '(') {
    const parsed = parseDestTitle(src, close + 1)
    if (parsed !== null) { href = parsed.dest; title = parsed.title; next = parsed.end }
  } else if (src[close + 1] === '[') {
    const endBracket = src.indexOf(']', close + 2)
    if (endBracket === close + 2) {
      // [text][] 快捷形式
      const def = ctx.refs.get(normRefKey(text))
      if (def !== undefined) { href = def.href; title = def.title; next = close + 3 }
    } else if (endBracket > close + 2) {
      const label = src.slice(close + 2, endBracket)
      const def = ctx.refs.get(normRefKey(label))
      if (def !== undefined) { href = def.href; title = def.title; next = endBracket + 1 }
    }
  } else {
    const def = ctx.refs.get(normRefKey(text))
    if (def !== undefined) { href = def.href; title = def.title }
  }

  if (href === null) {
    if (isImage) return null
    return { html: `[${inline(text)}]`, next: close + 1 }
  }

  const clean = safeUrl(href, isImage)
  const t = title !== null ? ` title="${attr(title)}"` : ''
  if (isImage) {
    return { html: `<img alt="${attr(text)}" src="${attr(clean)}"${t} loading="lazy"/>`, next }
  }
  return { html: `<a href="${attr(clean)}"${t} target="_blank" rel="noreferrer">${inline(text)}</a>`, next }
}

// ─── 强调 / 链接化装饰（在已转义纯文本上执行） ──────────────────────────────

function decorate(input: string, stash: string[]): string {
  let s = input

  // 裸 URL 从已转义文本中捕获，& 已是 &amp;；还原后再 attr/escapeHtml，
  // 否则 href 与可见文本都会双重转义（?a=1&b=2 曾显示并跳转到 &amp;）
  const unescapeAmp = (u: string): string => u.replace(/&amp;/g, '&')

  // 1. http(s) 自动链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>")\]}]+[^\s<>")\]},.;:!?])/g, (_m, pre: string, url: string) => {
    const link = unescapeAmp(url)
    return `${pre}<a href="${attr(link)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a>`
  })

  // 掩藏已生成的标签；后续步骤只作用于纯文本
  const mask = (v: string): string =>
    v.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<img\b[^>]*\/?>/g, m => {
      stash.push(m)
      return `${ST_TAG}${stash.length - 1}${EN_TAG}`
    })
  s = mask(s)
  const unmaskAll = (): string =>
    s.replace(new RegExp(`${ST_TAG}(\\d+)${EN_TAG}`, 'g'), (_m, idx: string) => stash[Number(idx)] ?? '')

  // 2. www 自动链接
  s = s.replace(/(^|[\s(])(www\.[^\s<>")\]}]+[^\s<>")\]},.;:!?])/g, (_m, pre: string, url: string) => {
    const link = unescapeAmp(url)
    return `${pre}<a href="${attr(`https://${link}`)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a>`
  })
  // www 产出的标签先掩藏，防止邮箱 pass 把 mailto 锚点嵌进其 href
  // （www.mail@example.com 曾产出 <a> 嵌套进 href 属性的损坏 HTML）
  s = mask(s)

  // 3. 邮箱自动链接（各段限长：无上限时超长 token 的回溯是 O(n²)，
  // 200k 字符单行实测 35s；限长后匹配失败即终止，整体线性）
  s = s.replace(/[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g, mail =>
    `<a href="mailto:${attr(mail)}">${escapeHtml(mail)}</a>`)
  // 邮箱标签同样掩藏，防止强调 pass 把 <em> 插进 mailto href
  s = mask(s)

  // 4. 强调链：粗斜体 → 粗体 → 斜体 → 删除线 → 高亮
  const passes: Array<[RegExp, string]> = [
    [/\*\*\*(?=\S)([\s\S]+?\S)\*\*\*/g, '<strong><em>$1</em></strong>'],
    [/(?<![\w\\])___(?=\S)([\s\S]+?\S)___(?!\w)/g, '<strong><em>$1</em></strong>'],
    [/\*\*(?=\S)([\s\S]+?\S)\*\*/g, '<strong>$1</strong>'],
    [/(?<![\w\\])__(?=\S)([^_]+?\S)__(?!\w)/g, '<strong>$1</strong>'],
    [/\*(?=\S)([^*\n]+?\S)\*/g, '<em>$1</em>'],
    [/(?<![\w\\])_(?=\S)([^_\n]+?\S)_(?!\w)/g, '<em>$1</em>'],
    [/~~(?=\S)([\s\S]+?\S)~~/g, '<del>$1</del>'],
    [/==(?=\S)([\s\S]+?\S)==/g, '<mark>$1</mark>'],
  ]
  for (const [re, wrap] of passes) s = s.replace(re, wrap)

  // Wiki 链接 [[目标|文本]]：由 createInline 扫描器统一处理（先于本函数，
  // 同一正则），此处不会再见到成对的 [[…]]——曾存在的兜底分支为死代码已删。

  // 5. 无属性白名单 HTML（原文已被转义成 &lt;…&gt;）
  s = s.replace(/&lt;(\/?)(br|hr)\s*\/?&gt;/g, '<$1$2/>')
  s = s.replace(
    /&lt;(\/?)(sub|sup|kbd|mark|u|s|b|i|em|strong|small|ins|del)&gt;/g,
    '<$1$2>',
  )

  return unmaskAll()
}

function createInline(ctx: RenderCtx): InlineFn {
  const inline: InlineFn = src => {
    const escapes: string[] = []
    const stash: string[] = []
    const out: string[] = []
    const plain: string[] = []
    const flushPlain = (): void => {
      if (plain.length === 0) return
      const text = escapeHtml(plain.join(''))
      out.push(decorate(text, stash).replace(new RegExp(`${ST_ESC}(\\d+)${EN_ESC}`, 'g'), (_m, idx: string) => escapes[Number(idx)] ?? ''))
      plain.length = 0
    }

    let i = 0
    const n = src.length
    while (i < n) {
      const ch = src[i]

      // 反斜杠转义
      if (ch === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
        escapes.push(escapeHtml(src[i + 1]))
        plain.push(`${ST_ESC}${escapes.length - 1}${EN_ESC}`)
        i += 2
        continue
      }
      // 实体透传（走哨兵通道，避免被 escapeHtml 二次转义）
      if (ch === '&') {
        const m = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.exec(src.slice(i))
        if (m !== null) {
          escapes.push(m[0])
          plain.push(`${ST_ESC}${escapes.length - 1}${EN_ESC}`)
          i += m[0].length
          continue
        }
      }
      // 行内代码
      if (ch === '`') {
        const run = countRun(src, i, '`')
        const close = findCodeClose(src, i + run, run)
        if (close >= 0) {
          flushPlain()
          let body = src.slice(i + run, close).replace(/\n/g, ' ')
          if (body.length >= 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim().length > 0) {
            body = body.slice(1, -1)
          }
          out.push(`<code>${escapeHtml(body)}</code>`)
          i = close + run
          continue
        }
      }
      // $$ 行内数学
      if (ch === '$' && src[i + 1] === '$') {
        const end = src.indexOf('$$', i + 2)
        if (end > i + 2 && !src.slice(i + 2, end).includes('\n')) {
          flushPlain()
          out.push(`<code class="dshx-math-i">${escapeHtml(src.slice(i + 2, end))}</code>`)
          i = end + 2
          continue
        }
      }
      // 图片 ![alt](…)
      if (ch === '!' && src[i + 1] === '[') {
        const parsed = parseBracket(src, i + 1, ctx, inline, true)
        if (parsed !== null) {
          flushPlain()
          out.push(parsed.html)
          i = parsed.next
          continue
        }
        plain.push('!')
        i++
        continue
      }
      // Wiki 链接 [[目标|文本]]（先于通用方括号匹配）
      if (ch === '[' && src[i + 1] === '[') {
        const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src.slice(i))
        if (m !== null) {
          flushPlain()
          const text = (m[2] ?? m[1]).trim()
          out.push(`<a href="#${attr(encodeURIComponent(m[1].trim()))}" class="dshx-wikilink">${escapeHtml(text)}</a>`)
          i += m[0].length
          continue
        }
      }
      // 链接 [text](…) / [text][ref] / [ref]
      if (ch === '[') {
        const parsed = parseBracket(src, i, ctx, inline, false)
        if (parsed !== null) {
          flushPlain()
          out.push(parsed.html)
          i = parsed.next
          continue
        }
      }
      // 尖括号自动链接
      if (ch === '<') {
        const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*|[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/.exec(src.slice(i))
        if (m !== null) {
          flushPlain()
          const url = safeUrl(m[1], false)
          out.push(`<a href="${attr(url)}" target="_blank" rel="noreferrer">${escapeHtml(m[1])}</a>`)
          i += m[0].length
          continue
        }
      }
      plain.push(ch)
      i++
    }
    flushPlain()
    return out.join('')
  }
  return inline
}

// ─── 代码块高亮 ─────────────────────────────────────────────────────────────

function highlightBlock(code: string, lang: string): string {
  // 行数上限（8000）由 tokenizeSource 的 HIGHLIGHT_MAX 统一强制：超限返回空
  // 数组 → 下面 rows.length === 0 分支即 escapeHtml，结果等价，无需重复检查。
  if (lang.length === 0 || code.length > 60000) {
    return escapeHtml(code)
  }
  try {
    const rows = tokenizeSource(code, lang)
    if (rows.length === 0) return escapeHtml(code)
    return rows
      .map(row =>
        row
          .map(span =>
            span.tok === 'plain'
              ? escapeHtml(span.text)
              : `<span class="dshx-tok-${span.tok}">${escapeHtml(span.text)}</span>`)
          .join(''))
      .join('\n')
  } catch {
    return escapeHtml(code)
  }
}

// ─── 块级解析 ────────────────────────────────────────────────────────────────

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const RE_ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const RE_QUOTE = /^ {0,3}> ?(.*)$/
const RE_UL = /^[ \t]*[-*+][ \t]+/
const RE_OL = /^[ \t]*\d{1,9}[.)][ \t]+/
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/
const RE_FN_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/
const RE_REF_DEF = /^ {0,3}\[(?!\^)([^\]]+)\]:[ \t]?(.*)$/

/** 解析引用定义的目的地部分：「dest 可选标题」。 */
function tryRefDef(rest: string): RefDef | null {
  // 无空白时补一个空格：尾部反斜杠（x\）在裸目的地扫描里会吞掉闭括号，
  // 补空格让 '\\' 转义落在空格上（两条路径对其余输入等价）
  const wrapped = rest.includes(' ') || rest.includes('\t') ? `(${rest})` : `(${rest} )`
  const parsed = parseDestTitle(wrapped, 0)
  // 必须整串消费完：'[r]: x)' 的 ')' 曾被当包装括号吞掉（end< len → 非法）
  if (parsed !== null && parsed.end === wrapped.length) return { href: parsed.dest, title: parsed.title }
  const angle = /^<([^<>]*)>[ \t]*$/.exec(rest)
  if (angle !== null) return { href: angle[1], title: null }
  return null
}

/** 按管道切分表格行，容忍 \| 转义与行内代码里的竖线。 */
function splitTableRow(line: string): string[] | null {
  let t = trimmedRight(line.trim())
  if (t.length === 0 || !t.includes('|')) return null
  const holes: string[] = []
  t = t.replace(/`[^`]*`|\\\||\\\\/g, m => { holes.push(m); return `\uE120${holes.length - 1}\uE121` })
  const cells = t.split('|')
  if (cells[0]?.trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  if (cells.length === 0) return null
  return cells.map(cell =>
    cell.trim().replace(/\uE120(\d+)\uE121/g, (_m, idx: string) => holes[Number(idx)] ?? ''))
}

function isDelimRow(line: string): boolean {
  if (!line.includes('-')) return false
  const cells = splitTableRow(line)
  if (cells === null || cells.length === 0) return false
  return cells.every(cell => /^:?-{1,}:?$/.test(cell))
}

function isBlockOpener(line: string): boolean {
  // RE_SETEXT：setext 下划线（=== / ---）不能作为引用/列表的懒续行
  // （CommonMark 规定；曾把 '> q\ntext\n===' 误吞成引用内 h1）
  return RE_FENCE_OPEN.test(line) || RE_HR.test(line) || RE_ATX.test(line) ||
    RE_UL.test(line) || RE_OL.test(line) || RE_QUOTE.test(line) || RE_SETEXT.test(line)
}

interface ListItem {
  lines: string[]
  checked: boolean | null
  startNum: number | null
}

function pushItemFirstLine(item: ListItem, content: string): void {
  const task = RE_TASK.exec(content)
  if (task !== null) {
    item.checked = task[1].toLowerCase() === 'x'
    item.lines.push(task[2])
    return
  }
  item.lines.push(trimmedRight(content))
}

function parseList(
  lines: string[],
  start: number,
  html: string[],
  ctx: RenderCtx,
  inline: InlineFn,
  depth: number,
): number {
  const firstLine = lines[start]
  const ol = /^[ \t]*(\d{1,9})([.)])([ \t]+)/.exec(firstLine)
  const ul = /^[ \t]*([-*+])([ \t]+)/.exec(firstLine)
  const ordered = ol !== null
  const baseIndent = indentWidth(firstLine)
  const markerCore = ordered ? ol![1].length + 1 : 1
  const gapRaw = ordered ? ol![3] : ul![2]
  const gapWidth = gapRaw.includes('\t')
    ? 4 - ((baseIndent + markerCore) % 4)
    : gapRaw.length
  const contentIndent = baseIndent + markerCore + Math.max(1, Math.min(Math.max(gapWidth, 1), 4))

  const items: ListItem[] = []
  let loose = false
  let i = start

  /** 返回 undefined=非条目行；null=无序；数字=有序起始号。 */
  const itemStartNum = (line: string): number | null | undefined => {
    if (ordered) {
      const m = /^[ \t]*(\d{1,9})[.)][ \t]+/.exec(line)
      return m === null ? undefined : Number(m[1])
    }
    if (/^[ \t]*[-*+][ \t]+/.test(line)) {
      if (ol !== null) return undefined // 有序列表里的无序符号按内容处理
      return null
    }
    return undefined
  }

  const beginItem = (line: string, num: number | null): void => {
    const item: ListItem = { lines: [], checked: null, startNum: num }
    items.push(item)
    const rest = ordered
      ? line.replace(/^[ \t]*\d{1,9}[.)][ \t]+/, '')
      : line.replace(/^[ \t]*[-*+][ \t]+/, '')
    pushItemFirstLine(item, rest)
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && items.length > 0) {
        const ind = indentWidth(lines[j])
        if ((itemStartNum(lines[j]) !== undefined && ind >= baseIndent) || ind >= contentIndent) {
          loose = true
          items[items.length - 1].lines.push('')
          i = j
          continue
        }
      }
      break
    }
    const ind = indentWidth(line)
    const num = itemStartNum(line)

    if (num !== undefined) {
      if (items.length === 0) {
        beginItem(line, num)
        i++
        continue
      }
      if (ind >= contentIndent) {
        // 缩进到内容列的条目起始 = 当前条目的嵌套内容
        items[items.length - 1].lines.push(cutIndent(line, contentIndent))
        i++
        continue
      }
      if (ind >= baseIndent) {
        beginItem(line, num) // 同级新条目
        i++
        continue
      }
      break // 比本层更浅 → 交还上层
    }

    if (items.length > 0 && ind >= contentIndent) {
      items[items.length - 1].lines.push(cutIndent(line, contentIndent))
      i++
      continue
    }
    // 懒续行：紧跟条目文本的无缩进行仍属于该条目段落
    const lastLines = items[items.length - 1]?.lines ?? []
    if (
      items.length > 0 &&
      ind < contentIndent &&
      lastLines.length > 0 &&
      lastLines[lastLines.length - 1].trim() !== '' &&
      !isBlockOpener(line) &&
      !line.includes('|') // 可能是表格，别吞
    ) {
      items[items.length - 1].lines.push(trimmedRight(line))
      i++
      continue
    }
    break
  }

  if (items.length === 0) return start + 1
  const tag = ordered ? 'ol' : 'ul'
  const first = items[0]!
  const startAttr = ordered && first.startNum !== null && first.startNum !== 1
    ? ` start="${first.startNum}"`
    : ''
  html.push(`<${tag}${startAttr}>`)
  for (const item of items) {
    // 深度超限时不再递归块解析，条目内容按段落文本收敛（防栈溢出/超二次）
    const inner = depth >= MAX_NEST_DEPTH
      ? inline(item.lines.join('\n'))
      : parseBlocks(item.lines, ctx, inline, !loose, depth + 1)
    if (item.checked === null) {
      html.push(`<li>${inner}</li>`)
    } else {
      const checked = item.checked ? ' checked' : ''
      html.push(`<li class="dshx-task"><input type="checkbox" disabled${checked}/><span>${inner}</span></li>`)
    }
  }
  html.push(`</${tag}>`)
  return i
}

function collectIndentedCode(lines: string[], start: number, html: string[]): number {
  const buf: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && indentWidth(lines[j]) >= 4) { buf.push(''); i++; continue }
      break
    }
    if (indentWidth(line) < 4) break
    buf.push(cutIndent(line, 4))
    i++
  }
  while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop()
  html.push(`<pre class="dshx-code"><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
  return i
}

function renderFence(info: string, code: string): string {
  const lang = (info.split(/\s+/)[0] ?? '').toLowerCase()
  const langAttr = lang.length > 0 ? ` data-lang="${attr(lang)}"` : ''
  return `<pre class="dshx-code"${langAttr}><code>${highlightBlock(code, lang)}</code></pre>`
}

function parseBlocks(
  lines: string[],
  ctx: RenderCtx,
  inline: InlineFn,
  tight: boolean,
  depth = 0,
): string {
  const html: string[] = []
  let para: string[] | null = null
  const flushPara = (): void => {
    if (para === null) return
    const body = inline(para.join('\n'))
    html.push(tight ? body : `<p>${body}</p>`)
    para = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { flushPara(); i++; continue }

    const width = indentWidth(line)

    // 围栏代码
    if (width <= 3) {
      const fence = RE_FENCE_OPEN.exec(line)
      if (fence !== null) {
        flushPara()
        const marker = fence[1]
        const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`)
        const buf: string[] = []
        i++
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++ }
        html.push(renderFence(fence[2], buf.join('\n')))
        i++
        continue
      }
    }

    // 引用（支持懒续行）
    if (width <= 3 && RE_QUOTE.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i])
        if (q !== null) { buf.push(q[1]); i++; continue }
        // 含 '|' 的行可能是表格，别吞（与列表懒续行规则一致）
        if (lines[i].trim() !== '' && buf.length > 0 && !isBlockOpener(lines[i]) && !lines[i].includes('|')) {
          buf.push(lines[i]); i++; continue
        }
        break
      }
      // 深度超限时内容按段落文本收敛，不再递归（防 '>'×N 栈溢出）
      const inner = depth >= MAX_NEST_DEPTH
        ? `<p>${inline(buf.join('\n'))}</p>`
        : parseBlocks(buf, ctx, inline, true, depth + 1)
      html.push(`<blockquote>${inner}</blockquote>`)
      continue
    }

    // Setext 标题（段落开启时优先于 hr）
    if (para !== null && width <= 3 && RE_SETEXT.test(line)) {
      const level = line.trim().charAt(0) === '=' ? 1 : 2
      const body = inline(para.join('\n'))
      html.push(`<h${level}>${body}</h${level}>`)
      para = null
      i++
      continue
    }

    // hr
    if (width <= 3 && RE_HR.test(line)) { flushPara(); html.push('<hr/>'); i++; continue }

    // ATX 标题
    if (width <= 3) {
      const h = RE_ATX.exec(line)
      if (h !== null) {
        flushPara()
        const lv = h[1].length
        html.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
        i++
        continue
      }
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      flushPara()
      const headerCells = splitTableRow(line)
      const delimCells = splitTableRow(lines[i + 1])
      if (headerCells !== null && delimCells !== null) {
        const alignOf = (idx: number): string => {
          const d = (delimCells[idx] ?? delimCells[delimCells.length - 1] ?? '').trim()
          const left = d.startsWith(':')
          const right = d.endsWith(':')
          return left && right ? 'c' : right ? 'r' : 'l'
        }
        const cellHtml = (cell: string, idx: number, tag: 'th' | 'td'): string => {
          const cls = alignOf(idx)
          return `<${tag} class="${cls}">${inline(cell.replace(/\\\|/g, '|'))}</${tag}>`
        }
        const thead = headerCells.map((cell, idx) => cellHtml(cell, idx, 'th')).join('')
        i += 2
        const rows: string[] = []
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          const cells = splitTableRow(lines[i])
          if (cells === null) break
          rows.push(`<tr>${cells.map((cell, idx) => cellHtml(cell, idx, 'td')).join('')}</tr>`)
          i++
        }
        html.push(`<table><thead><tr>${thead}</tr></thead><tbody>${rows.join('')}</tbody></table>`)
        continue
      }
    }

    // 脚注定义
    if (width <= 3) {
      const fnd = RE_FN_DEF.exec(line)
      if (fnd !== null) {
        flushPara()
        const buf = [fnd[2]]
        i++
        while (i < lines.length) {
          const l = lines[i]
          if (l.trim() === '') {
            let j = i + 1
            while (j < lines.length && lines[j].trim() === '') j++
            if (j < lines.length && indentWidth(lines[j]) >= 4) { buf.push(''); i++; continue }
            break
          }
          if (indentWidth(l) < 4) break
          buf.push(cutIndent(l, 4))
          i++
        }
        ctx.footNotes.set(fnd[1], buf.join('\n'))
        continue
      }
    }

    // 引用链接定义
    if (width <= 3) {
      const rd = RE_REF_DEF.exec(line)
      if (rd !== null) {
        const def = tryRefDef(rd[2])
        if (def !== null) {
          ctx.refs.set(normRefKey(rd[1]), def)
          flushPara()
          i++
          continue
        }
      }
    }

    // 列表（深度超限时按段落处理，防嵌套列表递归失控）
    if (depth < MAX_NEST_DEPTH && width <= 3 && (RE_UL.test(line) || RE_OL.test(line))) {
      flushPara()
      i = parseList(lines, i, html, ctx, inline, depth)
      continue
    }

    // 缩进代码块（不能吃掉段落的缩进续行）
    if (width >= 4 && para === null) {
      i = collectIndentedCode(lines, i, html)
      continue
    }

    // 段落
    if (para === null) para = []
    para.push(line)
    i++
  }
  flushPara()
  return html.join('\n')
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

export function renderMarkdown(markdown: string): string {
  // 预清私有区（PUA）字符：内部哨兵（\uE1xx 段）占用该区段，用户输入若携带
  // PUA 字符会与哨兵序号碰撞，导致占位被错误展开（标签重复展开的文本畸变，
  // 无 XSS）。只在最上游总入口清一次，覆盖 front matter / 代码块 / 行内全部
  // 文本路径，不漏不重。
  const normalized = markdown.replace(/[\uE000-\uF8FF]/g, '').replace(/\r\n?/g, '\n')
  try {
    return renderNormalized(normalized)
  } catch {
    // 兜底：任何未预见的解析异常都降级为纯文本（调用方在 useMemo 内裸调，
    // 抛错会击穿无 ErrorBoundary 的整棵插件视图）
    return `<p>${escapeHtml(normalized).replace(/\n/g, '<br/>')}</p>`
  }
}

function renderNormalized(normalized: string): string {
  let lines = normalized.split('\n')

  const head: string[] = []

  // front matter（文件头 --- … --- / …）
  if (lines.length > 1 && /^---[ \t]*$/.test(lines[0])) {
    let end = -1
    const limit = Math.min(lines.length, 202)
    for (let k = 1; k < limit; k++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[k])) { end = k; break }
    }
    if (end > 0) {
      const fm = lines.slice(1, end).join('\n')
      head.push(`<div class="dshx-frontmatter">${highlightBlock(fm, 'yaml')}</div>`)
      lines = lines.slice(end + 1)
    }
  }

  const ctx: RenderCtx = {
    refs: new Map(),
    footNotes: new Map(),
    footOrder: [],
  }

  // 预扫描：先收走全部引用链接定义，支持前向引用（跳过围栏代码内部）。
  // 同时登记顶层脚注定义（仅登记不删行——块级解析随后会以完整多行体重写；
  // 行内脚注引用据此判定"是否有定义"，未定义的按原文显示）
  {
    let fence: string | null = null
    const drop = new Set<number>()
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k]
      if (fence !== null) {
        if (new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null
        continue
      }
      const f = RE_FENCE_OPEN.exec(line)
      if (f !== null) { fence = f[1]; continue }
      if (indentWidth(line) > 3) continue
      const fd = RE_FN_DEF.exec(line)
      if (fd !== null) { ctx.footNotes.set(fd[1], fd[2]); continue }
      const rd = RE_REF_DEF.exec(line)
      if (rd === null) continue
      const def = tryRefDef(rd[2])
      if (def !== null) {
        ctx.refs.set(normRefKey(rd[1]), def)
        drop.add(k)
      }
    }
    if (drop.size > 0) lines = lines.filter((_, idx) => !drop.has(idx))
  }

  const inline = createInline(ctx)
  const body = parseBlocks(lines, ctx, inline, false)

  const parts = [...head, body]
  if (ctx.footOrder.length > 0) {
    const items = ctx.footOrder.map((label, idx) => {
      const n = idx + 1
      const raw = ctx.footNotes.get(label)
      const content = raw !== undefined ? inline(raw) : ''
      return `<li id="dshx-fn-${n}">${content}<a href="#dshx-fnref-${n}" class="dshx-fnback" aria-label="返回">↩</a></li>`
    })
    parts.push(`<section class="dshx-footnotes"><ol>${items.join('')}</ol></section>`)
  }
  return parts.join('\n').replace(STRAY_PUA, '')
}
