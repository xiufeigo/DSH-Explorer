import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'

/**
 * Browser half externals: the frozen module table entries the shell shares.
 * react / react-dom / the native icon library stay external so the plugin
 * reuses the app's shared instances; everything else this package imports
 * gets inlined.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches
 * ids ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-explorer-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Inline `.module.css` as a style-tag injector, matching official UI plugins.
 *  Class names stay the authored `dshx-*` globals (no hash); the shell
 *  unloads `style[data-plugin]` when the factory is disposed. */
const cssModulesInline = {
  name: 'dsh-explorer-css-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(this: { addWatchFile(id: string): void }, virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const css = await readFile(fileId, 'utf8')
    // tagId 掺入路径哈希：不同目录的同名 .module.css 不会互抢同一个
    // style[data-plugin-css] 标签（当前仓库只有一个，防撞于未来）。
    const hash = createHash('sha1').update(fileId).digest('hex').slice(0, 8)
    const tagId = `dsh-explorer/${basename(fileId)}-${hash}`
    return [
      `const css = ${JSON.stringify(css)};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      '  tag.dataset.plugin = \'dsh-explorer\';',
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      'export default {};',
    ].join('\n')
  },
}

export default defineConfig([
  // ── Node (host) half ────────────────────────────────────────────────────
  {
    name: 'dsh-explorer',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    // 清掉陈旧产物（改名/换入口后的残留）。client 半边在同一 lib 目录
    // 随后构建且 clean:false，不会误删 host 产物。
    clean: true,
    sourcemap: true,
  },
  // ── Browser (client) half ───────────────────────────────────────────────
  {
    name: 'dsh-explorer/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    // tsdown 0.22+：external/noExternal 已弃用，改由 deps.* 表达
    //（数组语义不变——CLIENT_EXTERNALS 仍是唯一的「除外」清单）。
    // Everything that is NOT a platform module must be inlined: a require()
    // the module table cannot answer is a guaranteed runtime throw.
    // alwaysBundle 显式排除（而非依赖 undefined 的隐式语义），上游默认
    // 行为变化也不会把 react 误内联。
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? false : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    plugins: [cssModulesInline],
    outputOptions: {
      entryFileNames: 'client.js',
    },
    // NOTE: the CJS `module`/`exports` shim MUST live inside the banner.
    // tsdown 0.22 silently drops the top-level `intro` option, so a shim
    // placed there never reaches the artifact and the factory body throws
    // `exports is not defined` when the shell module loader evaluates it
    // (took down the whole plugin graph once — see README).
    // 升级 tsdown 前必读本注：任何版本升级后跑 `pnpm run verify`——
    // 冒烟会真实执行 client.js 工厂，banner/footer 若被新版丢弃会当场红。
    banner: 'window.__ModuleLoader__.load({ id: "dsh-explorer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
