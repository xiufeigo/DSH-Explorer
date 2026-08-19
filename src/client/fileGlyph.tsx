/**
 * 文件树行首 16px 类型图标：按扩展名 / 文件名对应到该语言或格式自己的剪影
 *（Python 双蛇、JS/TS 色块、React 原子等），对不上的才用通用折角文件。
 */

type FileKind =
  | 'python' | 'javascript' | 'typescript' | 'react' | 'vue' | 'svelte'
  | 'html' | 'css' | 'scss' | 'markdown' | 'json' | 'yaml' | 'toml' | 'xml'
  | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'c' | 'cpp' | 'php'
  | 'ruby' | 'swift' | 'lua' | 'sql' | 'shell' | 'powershell'
  | 'docker' | 'git' | 'npm' | 'make' | 'env' | 'lock'
  | 'image' | 'svg' | 'file'

function basenameOf(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).toLowerCase()
}

function extensionOf(base: string): string {
  if (base.endsWith('.d.ts')) return 'ts'
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1)
}

const SPECIAL: Record<string, FileKind> = {
  dockerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'make',
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'bun.lock': 'lock',
  'bun.lockb': 'lock',
  'cargo.lock': 'lock',
  'poetry.lock': 'lock',
  'pipfile.lock': 'lock',
  'go.mod': 'go',
  'go.sum': 'go',
  'cargo.toml': 'rust',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  pipfile: 'python',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'tsconfig.json': 'typescript',
  'jsconfig.json': 'javascript',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.dockerignore': 'docker',
  '.editorconfig': 'toml',
  readme: 'markdown',
  'readme.md': 'markdown',
  'readme.mdx': 'markdown',
  license: 'markdown',
  licence: 'markdown',
  changelog: 'markdown',
  'changelog.md': 'markdown',
}

const EXT: Record<string, FileKind> = {
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react', jsx: 'react',
  vue: 'vue', svelte: 'svelte',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'markdown',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', conf: 'toml',
  xml: 'xml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  lua: 'lua',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', bat: 'shell', cmd: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  ico: 'image', bmp: 'image', avif: 'image',
  lock: 'lock',
}

function kindOf(name: string): FileKind {
  const base = basenameOf(name)
  const special = SPECIAL[base]
  if (special !== undefined) return special
  if (base.startsWith('.env') || base === 'env') return 'env'
  if (base.startsWith('dockerfile')) return 'docker'
  return EXT[extensionOf(base)] ?? 'file'
}

function Svg({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
      {children}
    </svg>
  )
}

function Tile({ bg, fg, label }: { bg: string; fg: string; label: string }): JSX.Element {
  return (
    <span className="dshx-file-tile" style={{ background: bg, color: fg }}>{label}</span>
  )
}

/** Python 官方双蛇剪影（蓝 + 黄，互相咬合）。 */
function PythonIcon(): JSX.Element {
  return (
    <Svg>
      <path
        fill="#3776AB"
        d="M8.05 1.15c-2.72 0-2.95.58-2.95 2.38v1.62h2.98v.4H4.22C2.28 5.55 1.4 6.72 1.4 8.62c0 1.9 1.22 2.7 3.12 2.7h.78V9.55c0-1.82 1.58-3.12 3.55-3.12h3.82V5.18C12.67 2.22 11.18 1.15 8.05 1.15zm-1.52 1.48a.72.72 0 1 1 0 1.44.72.72 0 0 1 0-1.44z"
      />
      <path
        fill="#FFD43B"
        d="M7.95 14.85c2.72 0 2.95-.58 2.95-2.38v-1.62H7.92v-.4h3.86c1.94 0 2.82-1.17 2.82-3.07 0-1.9-1.22-2.7-3.12-2.7h-.78v1.77c0 1.82-1.58 3.12-3.55 3.12H3.33v1.75c0 2.96 1.49 4.03 4.62 4.03zm1.52-1.48a.72.72 0 1 1 0-1.44.72.72 0 0 1 0 1.44z"
      />
    </Svg>
  )
}

function ReactIcon(): JSX.Element {
  return (
    <Svg>
      <g fill="none" stroke="#61DAFB" strokeWidth="1.15">
        <ellipse cx="8" cy="8" rx="6.15" ry="2.35" />
        <ellipse cx="8" cy="8" rx="6.15" ry="2.35" transform="rotate(60 8 8)" />
        <ellipse cx="8" cy="8" rx="6.15" ry="2.35" transform="rotate(120 8 8)" />
      </g>
      <circle cx="8" cy="8" r="1.15" fill="#61DAFB" />
    </Svg>
  )
}

function VueIcon(): JSX.Element {
  return (
    <Svg>
      <path fill="#41B883" d="M1.85 2.7h2.85L8 8.85 11.3 2.7h2.85L8 13.4 1.85 2.7z" />
      <path fill="#34495E" d="M4.55 2.7h2.35L8 5.85 9.1 2.7h2.35L8 10.35 4.55 2.7z" />
    </Svg>
  )
}

function HtmlIcon(): JSX.Element {
  return (
    <Svg>
      <path fill="#E44D26" d="M2.4 1.5h11.2l-1 11.3L8 14.5l-4.6-1.7L2.4 1.5z" />
      <path fill="#F16529" d="M8 2.7v10.5l3.7-1.35.85-9.15H8z" />
      <path fill="#EBEBEB" d="M8 7.15H5.72l-.16-1.7H8V3.85H4.28l.48 5.15H8V7.15z" />
      <path fill="#FFF" d="M8 7.15v1.6h2.12l-.2 2.15L8 11.4v1.55l3.55-1.3.4-4.5H8z" />
    </Svg>
  )
}

function CssIcon(): JSX.Element {
  return (
    <Svg>
      <path fill="#1572B6" d="M2.4 1.5h11.2l-1 11.3L8 14.5l-4.6-1.7L2.4 1.5z" />
      <path fill="#33A9DC" d="M8 2.7v10.5l3.7-1.35.85-9.15H8z" />
      <path fill="#EBEBEB" d="M8 7.2H5.7l-.15-1.7H8V3.9H4.3l.47 5.1H8V7.2z" />
      <path fill="#FFF" d="M8 7.2v1.55h2.15l-.12 1.35L8 10.55v1.55l2.55-.9.5-5H8z" />
    </Svg>
  )
}

function MarkdownIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="1.4" y="2.6" width="13.2" height="10.8" rx="1.4" fill="#083FA1" />
      <path
        fill="#FFF"
        d="M3.3 5.1h1.45l1.35 2.55L7.45 5.1H8.9v5.8H7.55V7.55L6.1 10.05 4.65 7.55v3.35H3.3V5.1zm7.35 0h1.4l2.05 3.05V5.1H15v5.8h-1.4L11.55 7.9v3H10.2V5.1h.45z"
      />
    </Svg>
  )
}

function GitIcon(): JSX.Element {
  return (
    <Svg>
      <path
        fill="#F05032"
        d="M14.55 7.35 8.65 1.45a1.55 1.55 0 0 0-2.2 0L5.18 2.72l1.76 1.76a1.17 1.17 0 0 1 1.51 1.5l1.7 1.7a1.17 1.17 0 1 1-.7.7l-1.58 1.58a1.17 1.17 0 1 1-.85-.4.4.4 0 0 0 0-.08V7.72a1.17 1.17 0 0 1-.64-1.54L4.5 4.4 1.45 7.45a1.55 1.55 0 0 0 0 2.2l5.9 5.9a1.55 1.55 0 0 0 2.2 0l5-5a1.55 1.55 0 0 0 0-2.2z"
      />
    </Svg>
  )
}

function DockerIcon(): JSX.Element {
  return (
    <Svg>
      <path fill="#2496ED" d="M1.7 8.35h1.85V6.6H1.7v1.75zm2.1 0h1.85V6.6H3.8v1.75zm2.1 0h1.85V6.6H5.9v1.75zm0-1.95h1.85V4.65H5.9v1.75zm2.1 1.95h1.85V6.6H8v1.75zm0-1.95h1.85V4.65H8v1.75zm0-1.95h1.85V2.7H8v1.75zm2.1 3.9h1.85V6.6H10.1v1.75z" />
      <path fill="#2496ED" d="M14.7 8.05c-.35-.22-1.18-.28-1.68-.14-.07-.55-.4-1.04-.98-1.4l-.2-.12-.14.2c-.27.4-.34.97-.3 1.44.06.35.22.7.5.96-1.12.6-2.82.5-4.4.28-1.7-.24-3.28-.24-3.28-.24s.18.95 1.28 1.62c1.55.95 4.28 1.08 6.55.28 1.18.3 2.42.1 3.12-.55.48-.42.78-1.05.85-1.7.3.02.72-.08.96-.35.18-.2.28-.48.22-.78-.22.08-.5.12-.8.1z" />
    </Svg>
  )
}

function ImageIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="1.7" y="3.1" width="12.6" height="9.8" rx="1.4" fill="#A074C4" />
      <path fill="#FFF" d="M3.2 10.85 6.1 7.7l2.15 2.2 1.55-1.55 2.95 2.5H3.2z" />
      <circle cx="11.05" cy="6.15" r="1.05" fill="#FFE08A" />
    </Svg>
  )
}

function FileIcon(): JSX.Element {
  return (
    <Svg>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.35 1.6A1.75 1.75 0 0 0 2.6 3.35v9.3A1.75 1.75 0 0 0 4.35 14.4h7.3A1.75 1.75 0 0 0 13.4 12.65V6.12L9.88 2.6H4.35Zm-.45 1.75c0-.25.2-.45.45-.45H9.2v3.05h3.05v8.3c0 .25-.2.45-.45.45h-7.3c-.25 0-.45-.2-.45-.45v-9.3Zm6.5.64 1.41 1.41H10.4V3.99Z"
      />
    </Svg>
  )
}

function LockIcon(): JSX.Element {
  return (
    <Svg>
      <path fill="#C9A227" d="M8 2.4a2.7 2.7 0 0 0-2.7 2.7v1.4H6.5V5.1a1.5 1.5 0 1 1 3 0v1.4h1.2V5.1A2.7 2.7 0 0 0 8 2.4z" />
      <rect x="3.6" y="7.2" width="8.8" height="6.4" rx="1.3" fill="#C9A227" />
      <circle cx="8" cy="10.15" r="1.05" fill="#FFF" />
      <path fill="#FFF" d="M7.55 10.5h.9v1.7h-.9z" />
    </Svg>
  )
}

function JsonIcon(): JSX.Element {
  return (
    <Svg>
      <path
        fill="#CBCB41"
        d="M5.2 2.6c.95 0 1.5.45 1.5 1.2v1.25c0 .4.14.66.54.66h.42v1.1h-.42c-.92 0-1.6-.5-1.6-1.5V4c0-.2-.1-.3-.32-.3H4.7v8.6h.62c.22 0 .32-.1.32-.3v-1.45c0-1 .68-1.5 1.6-1.5h.42v1.1h-.42c-.4 0-.54.26-.54.66V12.2c0 .75-.55 1.2-1.5 1.2H3.55V2.6H5.2zm5.6 0c-.95 0-1.5.45-1.5 1.2v1.25c0 .4-.14.66-.54.66h-.42v1.1h.42c.92 0 1.6-.5 1.6-1.5V4c0-.2.1-.3.32-.3h.62v8.6h-.62c-.22 0-.32-.1-.32-.3v-1.45c0-1-.68-1.5-1.6-1.5h-.42v1.1h.42c.4 0 .54.26.54.66V12.2c0 .75.55 1.2 1.5 1.2h1.65V2.6H10.8z"
      />
    </Svg>
  )
}

function ShellIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="1.5" y="2.6" width="13" height="10.8" rx="1.5" fill="#3D3D3D" />
      <path fill="#4EAA25" d="M3.4 6.05 5.7 8 3.4 9.95l.85.85L7.2 8 4.25 5.2l-.85.85zm4.3 4.35h4.5v1.15H7.7V10.4z" />
    </Svg>
  )
}

const ICONS: Record<FileKind, () => JSX.Element> = {
  python: PythonIcon,
  javascript: () => <Tile bg="#F7DF1E" fg="#222" label="JS" />,
  typescript: () => <Tile bg="#3178C6" fg="#fff" label="TS" />,
  react: ReactIcon,
  vue: VueIcon,
  svelte: () => <Tile bg="#FF3E00" fg="#fff" label="Sv" />,
  html: HtmlIcon,
  css: CssIcon,
  scss: () => <Tile bg="#CF649A" fg="#fff" label="Sc" />,
  markdown: MarkdownIcon,
  json: JsonIcon,
  yaml: () => <Tile bg="#CB171E" fg="#fff" label="Y" />,
  toml: () => <Tile bg="#9C4221" fg="#fff" label="T" />,
  xml: () => <Tile bg="#E0792A" fg="#fff" label="X" />,
  go: () => <Tile bg="#00ADD8" fg="#fff" label="Go" />,
  rust: () => <Tile bg="#DEA584" fg="#1a1a1a" label="Rs" />,
  java: () => <Tile bg="#EA2D2E" fg="#fff" label="J" />,
  kotlin: () => <Tile bg="#7F52FF" fg="#fff" label="Kt" />,
  csharp: () => <Tile bg="#239120" fg="#fff" label="C#" />,
  c: () => <Tile bg="#555555" fg="#fff" label="C" />,
  cpp: () => <Tile bg="#00599C" fg="#fff" label="C+" />,
  php: () => <Tile bg="#777BB4" fg="#fff" label="P" />,
  ruby: () => <Tile bg="#CC342D" fg="#fff" label="Rb" />,
  swift: () => <Tile bg="#F05138" fg="#fff" label="Sw" />,
  lua: () => <Tile bg="#000080" fg="#fff" label="Lu" />,
  sql: () => <Tile bg="#E38C00" fg="#fff" label="Q" />,
  shell: ShellIcon,
  powershell: () => <Tile bg="#012456" fg="#fff" label="PS" />,
  docker: DockerIcon,
  git: GitIcon,
  npm: () => <Tile bg="#CB3837" fg="#fff" label="N" />,
  make: () => <Tile bg="#427819" fg="#fff" label="Mk" />,
  env: () => <Tile bg="#ECD53F" fg="#333" label=".e" />,
  lock: LockIcon,
  image: ImageIcon,
  svg: () => <Tile bg="#FFB13B" fg="#333" label="vg" />,
  file: FileIcon,
}

export function FileGlyph({ name }: { name: string }): JSX.Element {
  const Icon = ICONS[kindOf(name)]
  return (
    <span className="dshx-tree-slot dshx-tree-file-icon" aria-hidden>
      <Icon />
    </span>
  )
}
