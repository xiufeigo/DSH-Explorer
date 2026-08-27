/**
 * Markdown / 高亮 自检脚本：把 src/client 的 Markdown.ts + highlight.ts
 * 用 TypeScript transpile 成 CJS 后逐条断言渲染输出。
 * 用法：node scripts/md-selfcheck.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function compile(rel) {
  const file = path.join(root, rel)
  const src = fs.readFileSync(file, 'utf8')
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText
}

const tmp = path.join(root, '.tmp-mdcheck')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
// 产物用 .js + 局部 package.json 声明 commonjs，require('./highlight') 才能无后缀命中
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'commonjs' }))
fs.writeFileSync(path.join(tmp, 'highlight.js'), compile('src/client/highlight.ts'))
fs.writeFileSync(path.join(tmp, 'Markdown.js'), compile('src/client/Markdown.ts'))

function loadCjs(file) {
  const module = { exports: {} }
  // require 以产物所在目录为基准，Markdown.js 里的 require('./highlight') 才能命中
  const req = createRequire(pathToFileURL(file))
  new Function('exports', 'require', 'module', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(
    module.exports,
    req,
    module,
    file,
    tmp,
  )
  return module.exports
}

const { renderMarkdown } = loadCjs(path.join(tmp, 'Markdown.js'))
const highlight = loadCjs(path.join(tmp, 'highlight.js'))

let pass = 0
const failures = []
function check(name, actual, test) {
  const ok = typeof test === 'function' ? test(actual) : test instanceof RegExp ? test.test(actual) : actual === test
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else {
    failures.push(name)
    console.error(`  ✗ ${name}`)
    console.error(`    输出: ${JSON.stringify(actual).slice(0, 400)}`)
  }
}

console.log('\n── Markdown 渲染 ──')

// 基础
check('标题', renderMarkdown('# Hello'), '<h1>Hello</h1>')
check('六级标题', renderMarkdown('###### deep'), '<h6>deep</h6>')
check('hr 星号', renderMarkdown('***'), '<hr/>')
check('hr 下划线', renderMarkdown('---'), '<hr/>')
check('段落软换行保留', renderMarkdown('a\nb'), t => t.includes('<p>a\nb</p>'))

// Setext
check('setext h1', renderMarkdown('Title\n====='), '<h1>Title</h1>')
check('setext h2', renderMarkdown('Title\n-----'), '<h2>Title</h2>')

// 强调
check('__粗体__', renderMarkdown('__bold__'), t => t.includes('<strong>bold</strong>'))
check('_斜体_', renderMarkdown('an _em_ here'), t => t.includes('<em>em</em>'))
check('snake_case 不误判斜体', renderMarkdown('my_var_name stays'), t => !t.includes('<em>'))
check('***粗斜体***', renderMarkdown('***bi***'), t => t.includes('<strong><em>bi</em></strong>'))
check('~~删除线~~', renderMarkdown('~~gone~~'), '<p><del>gone</del></p>')
check('==高亮==', renderMarkdown('==hi=='), '<p><mark>hi</mark></p>')

// 转义与实体
check('转义星号不强调', renderMarkdown('\\*not em\\*'), t => !t.includes('<em>') && t.includes('*not em*'))
check('实体 &amp; 透传', renderMarkdown('a &amp; b'), t => t.includes('a &amp; b'))

// 表格
check(
  'GFM 表格 + 对齐',
  renderMarkdown('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |'),
  t => t.includes('<table>') && t.includes('<th class="l">a</th>') && t.includes('<th class="c">b</th>')
    && t.includes('<th class="r">c</th>') && t.includes('<td class="r">3</td>'),
)
check(
  '表格单元格行内代码含竖线',
  renderMarkdown('| x |\n| --- |\n| `a\\|b` |'),
  t => t.includes('<code>a|b</code>'),
)

// 列表
check(
  '嵌套无序列表',
  renderMarkdown('- a\n  - a1\n- b').replace(/\n/g, ''),
  t => t.includes('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>'),
)
check(
  '三层嵌套',
  renderMarkdown('- l1\n  - l2\n    - l3'),
  t => (t.match(/<ul>/g) ?? []).length === 3,
)
check(
  '有序 start 属性',
  renderMarkdown('5. five\n6. six'),
  t => t.includes('<ol start="5">') && t.includes('<li>five</li>'),
)
check(
  '任务列表勾选态',
  renderMarkdown('- [x] done\n- [ ] todo'),
  t => t.includes(' checked') && t.includes('disabled/>') && !/todo.*checked/.test(t.split('<li')[2] ?? ''),
)
check(
  '嵌套任务列表',
  renderMarkdown('- [x] p\n  - [ ] c'),
  t => (t.match(/dshx-task/g) ?? []).length === 2,
)
check(
  '松散列表包 <p>',
  renderMarkdown('- a\n\n- b'),
  t => t.includes('<li><p>a</p></li>') || t.includes('<li><p>a</p>'),
)
check(
  '列表项内代码块',
  renderMarkdown('- item:\n\n  ```js\n  let a = 1\n  ```'),
  t => t.includes('data-lang="js"') && t.includes('<li>'),
)

// 引用
check('引用块', renderMarkdown('> quoted'), t => t.includes('<blockquote>'))
check(
  '嵌套引用 >>',
  renderMarkdown('> outer\n>> inner'),
  t => (t.match(/<blockquote>/g) ?? []).length === 2 && t.includes('outer') && t.includes('inner'),
)
check('引用懒续行', renderMarkdown('> line1\nline2'), t => t.includes('line1') && t.includes('line2'))

// 链接与图片
check('行内链接', renderMarkdown('[txt](https://x.y)'), '<p><a href="https://x.y" target="_blank" rel="noreferrer">txt</a></p>')
check('链接标题', renderMarkdown('[t](https://x.y "T")'), t => t.includes('title="T"'))
check('尖括号目的地', renderMarkdown('[t](<https://x.y>)'), t => t.includes('href="https://x.y"'))
check(
  '自动链接 <https://…>',
  renderMarkdown('see <https://example.com>'),
  t => t.includes('href="https://example.com"'),
)
check('裸 URL 自动链接', renderMarkdown('go https://a.b/c now'), t => t.includes('href="https://a.b/c"'))
check('www 自动链接', renderMarkdown('go www.a.b now'), t => t.includes('href="https://www.a.b"'))
check('邮箱自动链接', renderMarkdown('mail me@a.b'), t => t.includes('mailto:me@a.b'))
check('图片', renderMarkdown('![alt](https://i.x/p.png)'), t => t.includes('<img alt="alt" src="https://i.x/p.png"'))
check(
  'javascript: 链接被拦截',
  renderMarkdown('[x](javascript:alert(1))'),
  t => t.includes('href="#"') && !t.includes('javascript:'),
)

// 引用链接与脚注
check(
  '引用链接定义',
  renderMarkdown('[text][ref]\n\n[ref]: https://example.com "T"'),
  t => t.includes('href="https://example.com"') && t.includes('title="T"'),
)
check(
  '快捷引用链接',
  renderMarkdown('[Google][]\n\n[Google]: https://google.com'),
  t => t.includes('href="https://google.com"'),
)
check(
  '脚注',
  renderMarkdown('Text[^1] note.\n\n[^1]: The footnote.'),
  t => t.includes('id="dshx-fnref-1"') && t.includes('dshx-footnotes') && t.includes('The footnote.'),
)

// Wiki 与数学
check('wiki 链接', renderMarkdown('[[Page|显示名]]'), t => t.includes('显示名</a>'))
check('$$ 行内数学', renderMarkdown('$$E=mc^2$$'), t => t.includes('dshx-math-i'))

// 行内 HTML 白名单
check('<br> 放行', renderMarkdown('a<br>b'), t => t.includes('a<br/>b'))
check('<kbd> 放行', renderMarkdown('<kbd>Ctrl</kbd>'), t => t.includes('<kbd>Ctrl</kbd>'))
check('<div> 不放行', renderMarkdown('<div>x</div>'), t => !t.includes('<div>'))
check('带属性的标签不放行', renderMarkdown('<b onclick="x">y</b>'), t => !t.includes('<b onclick'))

// XSS
check('img onerror 转义', renderMarkdown('<img src=x onerror=alert(1)>'), t => !t.includes('<img src=x'))
check('script 标签转义', renderMarkdown('<script>alert(1)</script>'), t => !t.includes('<script>'))

// 代码块
check(
  '围栏代码高亮 js 关键字',
  renderMarkdown('```ts\nconst a = 1\n```'),
  t => t.includes('data-lang="ts"') && t.includes('dshx-tok-kw'),
)
check('mermaid 徽章', renderMarkdown('```mermaid\ngraph TD\n```'), t => t.includes('data-lang="mermaid"'))
check('波浪线围栏', renderMarkdown('~~~\ncode\n~~~'), t => t.includes('<pre class="dshx-code"><code>code</code></pre>'))
check('缩进代码块', renderMarkdown('para:\n\n    indented'), t => t.includes('<pre class="dshx-code"><code>indented</code></pre>'))
check('行内代码双反引号', renderMarkdown('`` a`b ``'), t => t.includes('<code>a`b</code>'))

// front matter
check(
  'front matter',
  renderMarkdown('---\ntitle: hi\n---\n\n# T'),
  t => t.includes('dshx-frontmatter') && t.includes('dshx-tok-fn') && t.includes('<h1>T</h1>'),
)

console.log('\n── 高亮器 ──')
{
  const rows = highlight.tokenizeSource('FROM node AS base\nRUN copy', 'docker')
  const flat = rows.flat().filter(s => s.tok !== 'plain').map(s => `${s.text}:${s.tok}`).join(',')
  check('Dockerfile 大写指令命中', flat, t => t.includes('FROM:kw') && t.includes('RUN:kw'))
}
{
  const rows = highlight.tokenizeSource('.card { --main: #fff; color: red; }', 'css')
  const flat = rows.flat()
  check('CSS --变量 param', flat.some(s => s.tok === 'param' && s.text.startsWith('--')), true)
  check('CSS 十六进制色 num', flat.some(s => s.tok === 'num' && s.text === '#fff'), true)
}
{
  const rows = highlight.tokenizeSource('/* block */\nSELECT 1;', 'sql')
  check('SQL 块注释', rows[0].some(s => s.tok === 'cmt' && s.text.startsWith('/*')), true)
}
{
  const rows = highlight.tokenizeSource('{\n  // c\n  /* b */\n  "k": 1\n}', 'jsonc')
  const flat = rows.flat().filter(s => s.tok === 'cmt')
  check('JSONC 双注释', flat.length >= 2, true)
}
{
  const rows = highlight.tokenizeSource('<html>\n<script>\nconst a = 1;\n</script>\n</html>', 'html')
  const flat = rows.flat()
  check('嵌入 script 按 JS 高亮', flat.some(s => s.tok === 'kw' && s.text.includes('const')), true)
}
{
  const rows = highlight.tokenizeSource('# t\n```python\ndef f(): pass\n```\nafter', 'md')
  const flat = rows.flat()
  check('md fence 内按语言高亮', flat.some(s => s.tok === 'kw' && s.text.includes('def')), true)
}
{
  const rows = highlight.tokenizeSource('@x = 1\ndef m; end', 'rb')
  const flat = rows.flat()
  check('Ruby def 关键字 + ivar', flat.some(s => s.tok === 'kw' && s.text === 'def') && flat.some(s => s.tok === 'param' && s.text === '@x'), true)
}

console.log(`\n通过 ${pass} 项${failures.length > 0 ? `，失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}` : '，全部 OK'}`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failures.length > 0 ? 1 : 0)
