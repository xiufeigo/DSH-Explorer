import { useEffect, useRef, useState } from 'react'

const DEFAULT_OVERSCAN = 16

/** 虚拟窗口：按行高切可见区间。display:none 时高度为 0，不能冲掉已测到的视口。 */
export function useVirtualSlice(count: number, itemH: number, resetKey: string, overscan = DEFAULT_OVERSCAN) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const startRef = useRef(0)
  const [start, setStart] = useState(0)
  const [viewH, setViewH] = useState(240)

  useEffect(() => {
    startRef.current = 0
    setStart(0)
    const wrap = wrapRef.current
    if (wrap !== null) wrap.scrollTop = 0
  }, [resetKey])

  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const measure = (): void => {
      raf = 0
      const next = wrap.clientHeight
      if (next < 8) return
      setViewH(current => (Math.abs(current - next) < 2 ? current : next))
    }
    const observer = new ResizeObserver(() => {
      if (raf !== 0) return
      raf = requestAnimationFrame(measure)
    })
    observer.observe(wrap)
    measure()
    return () => {
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [resetKey])

  // 数据量突变（如切换文件/列表缩短）时把 scrollTop 夹取到新总量内，
  // 否则滚动条停在旧位置 → 可视区落在空白里（白屏/跳顶）。
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const maxScroll = Math.max(0, count * itemH - viewH)
    if (wrap.scrollTop > maxScroll) wrap.scrollTop = maxScroll
  }, [count, itemH, viewH])

  const visible = Math.ceil(Math.max(viewH, 1) / itemH) + overscan * 2
  const last = Math.max(0, count - 1)
  const from = Math.min(start, last)
  const to = Math.min(count, from + visible)

  const onScroll = (): void => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const next = Math.max(0, Math.floor(wrap.scrollTop / itemH) - overscan)
    if (next === startRef.current) return
    startRef.current = next
    setStart(next)
  }

  return { wrapRef, from, to, onScroll }
}
