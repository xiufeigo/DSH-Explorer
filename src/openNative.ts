/**
 * Hand a fenced filesystem path to the desktop.
 *
 * Folders on Windows go through Explorer (`Shell.Application.Explore`) and
 * then the window is forced to the foreground. A background Host cannot
 * steal focus by merely spawning explorer.exe — the window lands in the
 * taskbar until the user clicks it.
 * Files still use PowerShell `Invoke-Item` (the registered default program).
 */

import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { release } from 'node:os'

export type DesktopOpenKind = 'folder' | 'file'

function powershellLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function runExec(command: string, args: readonly string[], timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    }, error => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/** Fire-and-forget GUI spawn. Do not wait for exit: explorer.exe hands off and often exits 1. */
function spawnDetached(
  command: string,
  args: readonly string[],
  windowsHide: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide,
    })
    const timer = setTimeout(() => {
      child.unref()
      resolve()
    }, 3000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('spawn', () => {
      clearTimeout(timer)
      child.unref()
      resolve()
    })
  })
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  const env = process.env
  if ((env.WSL_DISTRO_NAME ?? '').length > 0 || (env.WSL_INTEROP ?? '').length > 0) return true
  return release().toLowerCase().includes('microsoft')
}

async function toWindowsPath(path: string): Promise<string> {
  const translated = await new Promise<string>((resolve, reject) => {
    execFile('wslpath', ['-w', path], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout.replace(/[\r\n]+$/, ''))
    })
  })
  if (translated.length === 0) throw new Error('wslpath returned no Windows path')
  return translated
}

function winPath(path: string): string {
  return path.replace(/\//g, '\\')
}

function explorerExe(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
}

function comspec(): string {
  return process.env.ComSpec || 'cmd.exe'
}

/**
 * Open a folder in Explorer and raise that window above the DSH UI.
 * A background Host is not allowed to steal focus with a bare explorer.exe
 * spawn, so the window otherwise sits behind the app (taskbar flash only).
 * HWND_TOPMOST + AttachThreadInput is the usual way past that lock.
 */
function revealFolderScript(folder: string): string {
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$path = ${powershellLiteral(winPath(folder))}`,
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class Fg {',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);',
    '  const int SW_RESTORE = 9;',
    '  const uint SWP_NOSIZE = 0x0001;',
    '  const uint SWP_NOMOVE = 0x0002;',
    '  const uint SWP_SHOWWINDOW = 0x0040;',
    '  const byte VK_MENU = 0x12;',
    '  const uint KEYUP = 2;',
    '  public static void Activate(IntPtr hWnd) {',
    '    if (hWnd == IntPtr.Zero) return;',
    '    ShowWindow(hWnd, SW_RESTORE);',
    '    SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);',
    '    uint pid;',
    '    uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out pid);',
    '    uint self = GetCurrentThreadId();',
    '    if (fore != self) AttachThreadInput(fore, self, true);',
    '    BringWindowToTop(hWnd);',
    '    SetForegroundWindow(hWnd);',
    '    if (fore != self) AttachThreadInput(fore, self, false);',
    '    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);',
    '    SetForegroundWindow(hWnd);',
    '    keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);',
    '    SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);',
    '  }',
    '}',
    '\'@',
    'function Get-ExplorerHwnd([string]$want) {',
    '  $bs = [char]92',
    '  $norm = $want.TrimEnd($bs).ToLowerInvariant()',
    '  $shell = New-Object -ComObject Shell.Application',
    '  foreach ($w in @($shell.Windows())) {',
    '    try {',
    '      $p = [string]$w.Document.Folder.Self.Path',
    '      if ($p -and ($p.TrimEnd($bs).ToLowerInvariant() -eq $norm)) {',
    '        return [int64]$w.HWND',
    '      }',
    '    } catch {}',
    '  }',
    '  return [int64]0',
    '}',
    '$shell = New-Object -ComObject Shell.Application',
    '$shell.Explore($path)',
    '$ErrorActionPreference = \'Continue\'',
    '$hwnd = [int64]0',
    'for ($i = 0; $i -lt 40; $i++) {',
    '  $hwnd = Get-ExplorerHwnd $path',
    '  if ($hwnd -ne 0) { break }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'if ($hwnd -ne 0) {',
    '  [Fg]::Activate([IntPtr]$hwnd)',
    '  try { (New-Object -ComObject WScript.Shell).AppActivate($hwnd) | Out-Null } catch {}',
    '}',
  ].join('\n')
}

async function revealWindowsFolder(folder: string): Promise<void> {
  try {
    await runExec('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedCommand(revealFolderScript(folder)),
    ], 30000)
  } catch {
    await spawnDetached(
      comspec(),
      ['/c', 'start', '', explorerExe(), winPath(folder)],
      true,
    )
  }
}

async function openWindowsFile(path: string): Promise<void> {
  await runExec('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Invoke-Item -LiteralPath ${powershellLiteral(winPath(path))}`,
  ])
}

/** Open `path` in the file manager (`folder`) or the default application (`file`). */
export async function openOnDesktop(path: string, kind: DesktopOpenKind): Promise<void> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('缺少路径')
  }
  const platform = process.platform
  if (platform === 'win32') {
    if (kind === 'folder') {
      await revealWindowsFolder(path)
      return
    }
    await openWindowsFile(path)
    return
  }
  if (platform === 'darwin') {
    await runExec('open', [path])
    return
  }
  if (platform === 'linux') {
    if (isWsl()) {
      const translated = await toWindowsPath(path)
      if (kind === 'folder') {
        await revealWindowsFolder(translated)
        return
      }
      await openWindowsFile(translated)
      return
    }
    await runExec('xdg-open', [path])
    return
  }
  throw new Error(`当前系统不支持打开本地路径 (${platform})`)
}
