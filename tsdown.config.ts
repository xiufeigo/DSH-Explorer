import { defineConfig } from 'tsdown'

/**
 * Browser half externals: the frozen module table entries the shell shares.
 * react / react-dom / 原生图标组件库 stay external so the plugin reuses the
 * app's shared instances; everything else this package imports gets inlined.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

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
