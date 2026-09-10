/**
 * 「用系统默认程序打开」的宿主通道：插件自己不发起系统调用，只借用宿主
 * opener（Explorer 里用资源管理器打开文件夹同理）。
 *
 * 宿主两代打开通道（特性检测，永不裸引用）：
 * - DSH ≤ 0.1.1（rc.2 及更早）：客户端本地服务 `workspaces.openPath(path)`。
 * - DSH ≥ 0.1.2-alpha：本地服务面随 client-runtime 重组被删除，打开改走
 *   Typert 远端 `remote.session.openWorkspacePath({ path })`。
 * 两代通道都缺失时 openWithSystem 抛错，调用方（EditorTab）再回落插件自有
 * RPC `fs.openExternal`。
 */

interface WorkspacesFace {
  /** 0.1.2 起删除；旧宿主（≤0.1.1）才有。缺省时 openWithSystem 走远端回退。 */
  openPath?(path: string): Promise<void>
}

/** 0.1.2 的远端打开命名空间（`ctx.get('remote')?.session`）。 */
interface RemoteSessionLike {
  /** 0.1.2-alpha.1 的线端方法：`@Remote('openWorkspacePath')`，请求体 `{ path }`。 */
  openWorkspacePath?(request: { path: string }): Promise<unknown>
}

/** Parent directory of a POSIX or Windows path (browser-safe, no node:path). */
export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const sepIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (sepIndex < 0) return trimmed
  const parent = trimmed.slice(0, sepIndex)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent.length > 0 ? parent : trimmed
}

let hostOpenPath: ((path: string) => Promise<void>) | null = null
let remoteSession: RemoteSessionLike | null = null

/** Capture the platform opener（旧宿主）。0.1.2 起该成员不存在——静默不捕获，
 *  由远端回退兜底。服务是宿主对象，属性访问包一层 try，宿主侧任何异常都不能
 *  拖垮插件加载。 */
export function rememberHostOpenPath(workspaces: WorkspacesFace): void {
  if (hostOpenPath !== null) return
  try {
    if (typeof workspaces?.openPath === 'function') {
      hostOpenPath = workspaces.openPath.bind(workspaces)
    }
  } catch {
    // Proxy/守卫型服务拒绝属性访问：视为旧通道不可用。
  }
}

/** 捕获 0.1.2 的远端打开命名空间；旧宿主没有 `remote.session` 就保持 null。 */
export function rememberRemoteOpenPath(remote: unknown): void {
  if (remoteSession !== null) return
  try {
    const ns = (remote as { session?: RemoteSessionLike } | null | undefined)?.session
    if (ns !== undefined && ns !== null && typeof ns === 'object') remoteSession = ns
  } catch {
    // 远端命名空间未就绪或访问被拒：留空，openWithSystem 走自有 RPC 回退。
  }
}

/** 插件重载复位：清掉模块单例缓存的宿主打开器，由新实例重新捕获。 */
export function resetHostOpenPath(): void {
  hostOpenPath = null
  remoteSession = null
}

/** Open a path with the OS default handler (Explorer for a folder).
 *  通道优先级：旧宿主本地 opener → 0.1.2 远端 openWorkspacePath → 抛错
 *  （调用方 EditorTab 会再回落插件自有 RPC `fs.openExternal`）。 */
export async function openWithSystem(path: string): Promise<void> {
  if (hostOpenPath !== null) return hostOpenPath(path)
  const ns = remoteSession
  if (ns !== null && typeof ns.openWorkspacePath === 'function') {
    await ns.openWorkspacePath({ path })
    return
  }
  throw new Error('系统打开不可用（宿主未提供本地打开通道）')
}
