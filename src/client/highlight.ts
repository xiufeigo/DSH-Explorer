/**
 * 侧栏代码视图用的轻量分词：颜色走主题里的 `--shiki-*`，不把 Shiki 打进插件包。
 * 按行扫描，块注释 / 未闭合字符串会带到下一行。
 */

export type TokenKind = 'plain' | 'kw' | 'str' | 'cmt' | 'num' | 'fn' | 'type' | 'param' | 'punct'

export interface TokenSpan {
  text: string
  tok: TokenKind
}

export function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return body.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

type Family = 'js' | 'py' | 'go' | 'rs' | 'c' | 'java' | 'sh' | 'json' | 'html' | 'css' | 'yaml' | 'md' | 'sql' | 'toml' | 'docker'

const EXT_FAMILY: Record<string, Family> = {
  ts: 'js', mts: 'js', cts: 'js', tsx: 'js', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  py: 'py', pyw: 'py', pyi: 'py',
  go: 'go',
  rs: 'rs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', swift: 'java',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', psm1: 'sh', fish: 'sh',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  yml: 'yaml', yaml: 'yaml',
  md: 'md', mdx: 'md', markdown: 'md',
  sql: 'sql',
  toml: 'toml', ini: 'toml', conf: 'toml', env: 'toml',
  dockerfile: 'docker',
}

const SPECIAL_NAME: Record<string, Family> = {
  dockerfile: 'docker', makefile: 'sh', cmakelists: 'c',
  'package.json': 'json', 'tsconfig.json': 'json', 'jsconfig.json': 'json',
  'cargo.toml': 'toml', 'pyproject.toml': 'toml',
  gemfile: 'py', rakefile: 'py',
}

export function langFromPath(path: string): string {
  const base = (path.split(/[/\\]/).pop() ?? path).toLowerCase()
  if (base.endsWith('.d.ts')) return 'ts'
  const special = SPECIAL_NAME[base] ?? SPECIAL_NAME[base.replace(/\.[^.]+$/, '')]
  if (special !== undefined) return special
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return base
  return base.slice(dot + 1)
}

function familyOf(lang: string): Family | 'plain' {
  const id = lang.toLowerCase()
  if (id === 'typescript' || id === 'javascript') return 'js'
  if (id === 'python') return 'py'
  if (id === 'rust') return 'rs'
  if (id === 'shell' || id === 'shellscript' || id === 'powershell') return 'sh'
  if (id === 'markdown') return 'md'
  if (id === 'csharp' || id === 'kotlin') return 'java'
  return EXT_FAMILY[id] ?? 'plain'
}

function words(src: string): Set<string> {
  return new Set(src.split(/\s+/).filter(part => part.length > 0))
}

const KW: Record<Exclude<Family, 'json' | 'html' | 'css' | 'yaml' | 'md' | 'toml'>, Set<string>> = {
  js: words(`abstract as async await break case catch class const continue debugger declare default
    delete do else enum export extends false finally for from function get if implements import in
    infer instanceof interface is keyof let module namespace never new null of package private
    protected public readonly return satisfies set static super switch this throw true try type
    typeof undefined unique unknown var void while with yield`),
  py: words(`and as assert async await break class continue def del elif else except False finally
    for from global if import in is lambda match case None nonlocal not or pass raise return True
    try type while with yield`),
  go: words(`break case chan const continue default defer else fallthrough false for func go goto
    if import interface map nil package range return select struct switch true type var`),
  rs: words(`as async await break const continue crate dyn else enum extern false fn for if impl in
    let loop match mod move mut pub ref return self Self static struct super trait true type unsafe
    use where while`),
  c: words(`alignas alignof and and_eq asm auto bitand bitor bool break case catch char class
    compl concept const consteval constexpr constinit const_cast continue co_await co_return
    co_yield decltype default delete do double dynamic_cast else enum explicit export extern false
    float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr
    operator or or_eq private protected public register reinterpret_cast requires return short
    signed sizeof static static_assert static_cast struct switch template this thread_local throw
    true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor
    xor_eq`),
  java: words(`abstract as async await base bool boolean break byte case catch char checked class
    const continue decimal default delegate do double else enum event explicit extern false final
    finally fixed float for foreach goto if implicit in int interface internal is lock long
    namespace native new null object operator out override package params private protected public
    readonly ref return sbyte sealed short sizeof stackalloc static string struct super switch
    synchronized this throw throws true try typeof uint ulong unchecked unsafe ushort using var
    virtual void volatile while`),
  sh: words(`alias bg bind break builtin caller case cd command continue declare do done echo elif
    else esac eval exec exit export false fi for function getopts hash help history if in jobs kill
    let local logout popd printf pushd pwd read readonly return set shift shopt source suspend test
    then time times trap true type typeset ulimit umask unalias unset until wait while`),
  sql: words(`add all alter and as asc between by case cast create cross current date delete desc
    distinct drop else end exists false from full group having in inner insert into is join key left
    like limit not null on or order outer over primary references right select set table then true
    union update values view when where`),
  docker: words(`add arg cmd copy entrypoint env expose from healthcheck label maintainer onbuild
    run shell stopsignal user volume workdir as`),
}

function push(spans: TokenSpan[], text: string, tok: TokenKind): void {
  if (text.length === 0) return
  const last = spans[spans.length - 1]
  if (last !== undefined && last.tok === tok) last.text += text
  else spans.push({ text, tok })
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$'
}

function isIdent(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9')
}

function skipEscape(line: string, i: number): number {
  if (line[i] !== '\\') return i
  return Math.min(line.length, i + 2)
}

function readString(line: string, start: number, quote: string): { end: number; closed: boolean } {
  let i = start + 1
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') {
      i = skipEscape(line, i)
      continue
    }
    if (ch === quote) return { end: i + 1, closed: true }
    i++
  }
  return { end: line.length, closed: false }
}

function nextNonSpace(line: string, i: number): string {
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return line[i] ?? ''
}

type ScanMode = 'code' | 'block' | 'dstr' | 'sstr' | 'tstr'

function tokenizeCLike(
  source: string,
  keywords: Set<string>,
  lineComment: '//' | '#' | '--' | null,
  block: boolean,
): TokenSpan[][] {
  const lines = splitLines(source)
  const result: TokenSpan[][] = []
  let mode: ScanMode = 'code'
  let quote: '"' | "'" | '`' = '"'

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const spans: TokenSpan[] = []
    let i = 0

    const flushOpen = (tok: TokenKind, closer: string, next: ScanMode): void => {
      const at = line.indexOf(closer, i)
      if (at < 0) {
        push(spans, line.slice(i), tok)
        i = line.length
        return
      }
      push(spans, line.slice(i, at + closer.length), tok)
      i = at + closer.length
      mode = next
    }

    if (mode === 'block') {
      flushOpen('cmt', '*/', 'code')
    } else if (mode === 'dstr' || mode === 'sstr' || mode === 'tstr') {
      const found = readString(quote + line, 0, quote)
      if (!found.closed) {
        push(spans, line, 'str')
        i = line.length
      } else {
        const take = found.end - 1
        push(spans, line.slice(0, take), 'str')
        i = take
        mode = 'code'
      }
    }

    if (lineIndex === 0 && line.startsWith('#!')) {
      push(spans, line, 'cmt')
      i = line.length
    }

    while (i < line.length) {
      const ch = line[i]
      const next = line[i + 1]

      if (block && ch === '/' && next === '*') {
        const end = line.indexOf('*/', i + 2)
        if (end < 0) {
          push(spans, line.slice(i), 'cmt')
          mode = 'block'
          i = line.length
          break
        }
        push(spans, line.slice(i, end + 2), 'cmt')
        i = end + 2
        continue
      }
      if (lineComment === '//' && ch === '/' && next === '/') {
        push(spans, line.slice(i), 'cmt')
        break
      }
      if (lineComment === '#' && ch === '#') {
        push(spans, line.slice(i), 'cmt')
        break
      }
      if (lineComment === '--' && ch === '-' && next === '-') {
        push(spans, line.slice(i), 'cmt')
        break
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const found = readString(line, i, ch)
        push(spans, line.slice(i, found.end), 'str')
        i = found.end
        if (!found.closed) {
          quote = ch
          mode = ch === '"' ? 'dstr' : ch === "'" ? 'sstr' : 'tstr'
        }
        continue
      }
      if (ch >= '0' && ch <= '9') {
        let j = i + 1
        while (j < line.length && /[0-9a-fA-FxXoO_.]/.test(line[j])) j++
        push(spans, line.slice(i, j), 'num')
        i = j
        continue
      }
      if (isIdentStart(ch)) {
        let j = i + 1
        while (j < line.length && isIdent(line[j])) j++
        const ident = line.slice(i, j)
        let tok: TokenKind = 'plain'
        if (keywords.has(ident)) tok = 'kw'
        else if (nextNonSpace(line, j) === '(') tok = 'fn'
        else if (ident[0] >= 'A' && ident[0] <= 'Z') tok = 'type'
        push(spans, ident, tok)
        i = j
        continue
      }
      if (ch === ' ' || ch === '\t') {
        let j = i + 1
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++
        push(spans, line.slice(i, j), 'plain')
        i = j
        continue
      }
      push(spans, ch, 'punct')
      i++
    }

    result.push(spans.length > 0 ? spans : [{ text: '', tok: 'plain' }])
  }
  return result
}

function tokenizeJson(source: string): TokenSpan[][] {
  return splitLines(source).map(line => {
    const spans: TokenSpan[] = []
    let i = 0
    while (i < line.length) {
      const ch = line[i]
      if (ch === ' ' || ch === '\t') {
        let j = i + 1
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++
        push(spans, line.slice(i, j), 'plain')
        i = j
        continue
      }
      if (ch === '"') {
        const found = readString(line, i, '"')
        const body = line.slice(i, found.end)
        const after = nextNonSpace(line, found.end)
        push(spans, body, after === ':' ? 'fn' : 'str')
        i = found.end
        continue
      }
      if (ch === '/' && line[i + 1] === '/') {
        push(spans, line.slice(i), 'cmt')
        break
      }
      if ((ch >= '0' && ch <= '9') || ch === '-') {
        let j = i + 1
        while (j < line.length && /[0-9.eE+-]/.test(line[j])) j++
        push(spans, line.slice(i, j), 'num')
        i = j
        continue
      }
      if (isIdentStart(ch)) {
        let j = i + 1
        while (j < line.length && isIdent(line[j])) j++
        const ident = line.slice(i, j)
        push(spans, ident, ident === 'true' || ident === 'false' || ident === 'null' ? 'kw' : 'plain')
        i = j
        continue
      }
      push(spans, ch, 'punct')
      i++
    }
    return spans.length > 0 ? spans : [{ text: '', tok: 'plain' }]
  })
}

function tokenizeMarkup(source: string): TokenSpan[][] {
  const lines = splitLines(source)
  const result: TokenSpan[][] = []
  let inComment = false
  for (const line of lines) {
    const spans: TokenSpan[] = []
    let i = 0
    if (inComment) {
      const at = line.indexOf('-->')
      if (at < 0) {
        result.push([{ text: line, tok: 'cmt' }])
        continue
      }
      push(spans, line.slice(0, at + 3), 'cmt')
      i = at + 3
      inComment = false
    }
    while (i < line.length) {
      if (line.startsWith('<!--', i)) {
        const at = line.indexOf('-->', i + 4)
        if (at < 0) {
          push(spans, line.slice(i), 'cmt')
          inComment = true
          break
        }
        push(spans, line.slice(i, at + 3), 'cmt')
        i = at + 3
        continue
      }
      if (line[i] === '<') {
        const gt = line.indexOf('>', i)
        const end = gt < 0 ? line.length : gt + 1
        const tag = line.slice(i, end)
        let k = 0
        while (k < tag.length) {
          const ch = tag[k]
          if (ch === '<' || ch === '/' || ch === '>' || ch === '=') {
            push(spans, ch, 'punct')
            k++
          } else if (isIdentStart(ch)) {
            let j = k + 1
            while (j < tag.length && /[\w:-]/.test(tag[j])) j++
            const ident = tag.slice(k, j)
            const prev = tag[k - 1]
            push(spans, ident, prev === '<' || prev === '/' ? 'kw' : 'param')
            k = j
          } else if (ch === '"' || ch === "'") {
            const found = readString(tag, k, ch)
            push(spans, tag.slice(k, found.end), 'str')
            k = found.end
          } else {
            push(spans, ch, 'plain')
            k++
          }
        }
        i = end
        continue
      }
      let j = i + 1
      while (j < line.length && line[j] !== '<' && !line.startsWith('<!--', j)) j++
      push(spans, line.slice(i, j), 'plain')
      i = j
    }
    result.push(spans.length > 0 ? spans : [{ text: '', tok: 'plain' }])
  }
  return result
}

function tokenizeCss(source: string): TokenSpan[][] {
  return tokenizeCLike(source, words(`from to and or not only important root`), null, true).map(spans =>
    spans.map(span => {
      if (span.tok === 'fn') return span
      if (span.tok === 'plain' && span.text.startsWith('--')) return { ...span, tok: 'param' }
      if (span.tok === 'plain' && span.text.startsWith('#')) return { ...span, tok: 'num' }
      return span
    }))
}

function tokenizeYaml(source: string): TokenSpan[][] {
  return splitLines(source).map(line => {
    const hash = line.indexOf('#')
    const body = hash >= 0 && (hash === 0 || line[hash - 1] === ' ') ? line.slice(0, hash) : line
    const comment = hash >= 0 && body !== line ? line.slice(hash) : ''
    const spans: TokenSpan[] = []
    let i = 0
    while (i < body.length) {
      const ch = body[i]
      if (ch === ' ' || ch === '\t') {
        let j = i + 1
        while (j < body.length && (body[j] === ' ' || body[j] === '\t')) j++
        push(spans, body.slice(i, j), 'plain')
        i = j
        continue
      }
      if (ch === '"' || ch === "'") {
        const found = readString(body, i, ch)
        push(spans, body.slice(i, found.end), 'str')
        i = found.end
        continue
      }
      if (ch === ':' || ch === '-' || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ',') {
        push(spans, ch, 'punct')
        i++
        continue
      }
      let j = i + 1
      while (j < body.length && body[j] !== ':' && body[j] !== ' ' && body[j] !== '#' && body[j] !== ',') j++
      const ident = body.slice(i, j)
      const after = nextNonSpace(body, j)
      if (ident === 'true' || ident === 'false' || ident === 'null' || ident === 'yes' || ident === 'no') {
        push(spans, ident, 'kw')
      } else if (/^-?\d/.test(ident)) {
        push(spans, ident, 'num')
      } else if (after === ':') {
        push(spans, ident, 'fn')
      } else {
        push(spans, ident, 'plain')
      }
      i = j
    }
    if (comment.length > 0) push(spans, comment, 'cmt')
    return spans.length > 0 ? spans : [{ text: '', tok: 'plain' }]
  })
}

function tokenizeMd(source: string): TokenSpan[][] {
  return splitLines(source).map(line => {
    const spans: TokenSpan[] = []
    if (/^\s*#+\s/.test(line)) {
      const m = line.match(/^(\s*#+)/)
      if (m !== null) {
        push(spans, m[1], 'kw')
        push(spans, line.slice(m[1].length), 'fn')
        return spans
      }
    }
    if (/^\s*```/.test(line)) return [{ text: line, tok: 'punct' }]
    let i = 0
    while (i < line.length) {
      if (line[i] === '`') {
        const end = line.indexOf('`', i + 1)
        if (end < 0) {
          push(spans, line.slice(i), 'str')
          break
        }
        push(spans, line.slice(i, end + 1), 'str')
        i = end + 1
        continue
      }
      push(spans, line[i], 'plain')
      i++
    }
    return spans.length > 0 ? spans : [{ text: '', tok: 'plain' }]
  })
}

const EMPTY: TokenSpan[][] = []
const HIGHLIGHT_MAX = 8000

export function tokenizeSource(source: string, lang: string): TokenSpan[][] {
  const lines = splitLines(source)
  if (lines.length > HIGHLIGHT_MAX) return EMPTY
  const family = familyOf(lang)
  switch (family) {
    case 'plain':
      return EMPTY
    case 'json':
      return tokenizeJson(source)
    case 'html':
      return tokenizeMarkup(source)
    case 'css':
      return tokenizeCss(source)
    case 'yaml':
      return tokenizeYaml(source)
    case 'md':
      return tokenizeMd(source)
    case 'toml':
      return tokenizeCLike(source, words(`true false`), '#', false)
    case 'js':
      return tokenizeCLike(source, KW.js, '//', true)
    case 'py':
      return tokenizeCLike(source, KW.py, '#', false)
    case 'go':
      return tokenizeCLike(source, KW.go, '//', true)
    case 'rs':
      return tokenizeCLike(source, KW.rs, '//', true)
    case 'c':
      return tokenizeCLike(source, KW.c, '//', true)
    case 'java':
      return tokenizeCLike(source, KW.java, '//', true)
    case 'sh':
      return tokenizeCLike(source, KW.sh, '#', false)
    case 'sql':
      return tokenizeCLike(source, KW.sql, '--', false)
    case 'docker':
      return tokenizeCLike(source, KW.docker, '#', false)
  }
}

export function tokenizeLine(text: string, lang: string): TokenSpan[] {
  const rows = tokenizeSource(text, lang)
  return rows[0] ?? [{ text, tok: 'plain' }]
}
