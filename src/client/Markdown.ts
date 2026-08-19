/**
 * DSH-Explorer browser half — a compact, dependency-free Markdown renderer.
 * Covers the common subset: headings, hr, blockquote, fenced code, ordered /
 * unordered / task lists, paragraphs, and inline emphasis / code / links /
 * images / strikethrough. Output is HTML-safe (input is escaped first).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text: string): string {
  let out = escapeHtml(text)
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img alt="$1" src="$2" loading="lazy"/>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^\s*(---|\*\*\*|___)\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*\d+[.)]\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0
  let list: 'ul' | 'ol' | null = null
  let inQuote = false

  const closeList = (): void => {
    if (list !== null) {
      html.push(list === 'ul' ? '</ul>' : '</ol>')
      list = null
    }
  }
  const closeQuote = (): void => {
    if (inQuote) {
      html.push('</blockquote>')
      inQuote = false
    }
  }

  const listItem = (text: string): string => {
    const task = TASK.exec(text)
    if (task !== null) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : ''
      return `<li class="dshx-task"><input type="checkbox" disabled${checked}/><span>${inline(task[2])}</span></li>`
    }
    return `<li>${inline(text)}</li>`
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence !== null) {
      closeList(); closeQuote()
      const marker = fence[1]
      const lang = line.slice(fence[0].length).trim()
      const buffer: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        buffer.push(lines[i])
        i++
      }
      html.push(`<pre class="dshx-code"><code${lang.length > 0 ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(buffer.join('\n'))}</code></pre>`)
      i++ // skip the closing fence
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      closeList(); closeQuote()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (HR.test(line)) {
      closeList(); closeQuote()
      html.push('<hr/>')
      i++
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      closeList()
      if (!inQuote) {
        html.push('<blockquote>')
        inQuote = true
      }
      html.push(`<p>${inline(quote[1])}</p>`)
      i++
      continue
    }
    closeQuote()

    const ul = UL.exec(line)
    if (ul !== null) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul>')
        list = 'ul'
      }
      html.push(listItem(ul[1]))
      i++
      continue
    }

    const ol = OL.exec(line)
    if (ol !== null) {
      if (list !== 'ol') {
        closeList()
        html.push('<ol>')
        list = 'ol'
      }
      html.push(listItem(ol[1]))
      i++
      continue
    }
    closeList()

    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph: gather until a blank line or a recognized block opener.
    const buffer = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '') {
      const next = lines[i]
      if (FENCE.test(next) || HEADING.test(next) || HR.test(next) || QUOTE.test(next) || UL.test(next) || OL.test(next)) break
      buffer.push(next)
      i++
    }
    html.push(`<p>${inline(buffer.join(' '))}</p>`)
  }
  closeList()
  closeQuote()
  return html.join('\n')
}
