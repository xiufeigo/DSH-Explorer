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
    const tagId = `dsh-explorer/${basename(fileId)}`
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
    clean: false,
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
    external: CLIENT_EXTERNALS,
    // Everything that is NOT a platform module must be inlined: a require()
    // the module table cannot answer is a guaranteed runtime throw.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
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
    banner: 'window.__ModuleLoader__.load({ id: "dsh-explorer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
