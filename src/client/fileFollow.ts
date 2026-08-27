/**
 * 打开的文件跟随磁盘变化（预览 tab + 编辑 tab 共用）。
 *
 * 指纹探测分两级：
 *  1) `fs.stat`——返回 version+size，最便宜；但这是后加的方法，宿主没重启
 *     （还在跑旧 bundle）时会报「未知方法」；
 *  2) 任一次失败就永久切到 `fs.list(父目录)`，从 entry 里取 size/version。
 *     fs.list 是最早的接口，任何宿主都有 —— 跟随行为不依赖用户是否重启过壳。
 *
 * 基准建立规则：首次成功的探测只记录基准；之后每次指纹不同才算「外部修改」，
 * 触发 onChanged（基准同时前移）。文件消失记为 <missing>，重现再触发。
 */

import { useCallback, useEffect, useRef } from 'react'
import { parentDir } from './chatFileOpen'
import { basename, rpc } from './rpc'

interface StatLite {
  version?: string | null
  size?: number
}

interface ListEntryLite {
  name: string
  type: string
  size?: number
  version?: string
}

interface ListResultLite {
  entries?: ListEntryLite[]
  error?: string
}

export interface FollowOptions {
  sessionId: string
  path: string
  /** true 时暂停轮询（加载中 / 有未保存编辑），基准保持不变。 */
  paused?: boolean
  /** 右栏不可见（列宽 0 / 窄屏替换态）时暂停——宿主关闭列仍保留挂载，不设会空转。 */
  visible?: boolean
  /** 磁盘内容相对基准发生变化（每次变化恰好触发一次）。 */
  onChanged(): void
}

export function useExternalFollow({ sessionId, path, paused, visible, onChanged }: FollowOptions): () => void {
  const baseline = useRef<string | null>(null)
  const mode = useRef<'stat' | 'list'>('stat')
  const gen = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const cbRef = useRef(onChanged)
  cbRef.current = onChanged

  useEffect(() => {
    baseline.current = null
    mode.current = 'stat'
    let cancelled = false
    let busy = false

    const probeFp = async (): Promise<string | null> => {
      const myGen = gen.current
      if (mode.current === 'stat') {
        const res = await rpc<StatLite>(sessionId, 'fs.stat', { path })
        if (cancelled || myGen !== gen.current) return null
        if (res.error === undefined) return `${res.version ?? ''}|${res.size ?? 0}`
        // 宿主没有 fs.stat（未重启）→ 之后一直走列表回退
        mode.current = 'list'
      }
      const list = await rpc<ListResultLite>(sessionId, 'fs.list', { path: parentDir(path) })
      if (cancelled || myGen !== gen.current) return null
      if (list.error !== undefined) return null
      // envelope 是 any 索引签名，显式取回类型
      const entries = list.entries as ListEntryLite[] | undefined
      const name = basename(path)
      const entry = (entries ?? []).find((item: ListEntryLite) => item.name === name)
      if (entry === undefined || entry.type !== 'file') return '<missing>'
      return `list|${entry.size ?? ''}|${entry.version ?? ''}`
    }

    const tick = async (): Promise<void> => {
      if (cancelled || busy || pausedRef.current === true || visibleRef.current === false || document.hidden) return
      busy = true
      try {
        const fp = await probeFp()
        if (fp === null || cancelled) return
        if (baseline.current === null) {
          baseline.current = fp
          return
        }
        if (fp === baseline.current) return
        baseline.current = fp
        cbRef.current()
      } finally {
        busy = false
      }
    }

    void tick()
    const timer = setInterval(() => { void tick() }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, path])

  // 自己写过盘（保存）之后调用：丢弃旧基准与在途结果，下个 tick 重建。
  const rebase = useCallback((): void => {
    gen.current += 1
    baseline.current = null
  }, [])
  return rebase
}
