/**
 * @deepseek-ai/dsh-client-store 的本地类型桩。
 *
 * 该包是平台模块（`PLATFORM_MODULES` 由 shell 播种进冻结模块表，bundle 外部化），
 * 与 ui-primitives / ui-slots 同属 baseline，不随宿主载荷单独安装，因此这里只声明
 * 本项目用到的编译期形状——与上游 `packages/client/store/src/contract.ts` 的
 * 公开契约逐字对应，升级宿主时按该文件核对。
 */

declare module '@deepseek-ai/dsh-client-store' {
  /** 可观察快照源：store 引擎产物与控制器共用的最小形状。 */
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }

  /** typed selector hook：由 render 机制在绑定处合成（业务侧只消费形状）。 */
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

  /** 写入声明表：对 immer draft 的纯变换，构成 store 的完整写集合。 */
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

  /** draft 剥离后的回调形态：组件 `actions` 与 inject 工厂收到的形状。 */
  export type BakedActions<T, A extends ActionsDecl<T>> = {
    [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
  }

  /** store 声明：初值工厂（每次实例化取新值）+ 可选持久化键 + 写入表。 */
  export interface StoreSpec<T, A extends ActionsDecl<T>> {
    init: () => T
    persist?: string
    actions: A
  }

  /** 引擎实例：裸快照源 + 已烘焙写集合（不含 React hook）。 */
  export interface EngineStoreInstance<T, A extends ActionsDecl<T>> extends ObservableSnapshot<T> {
    readonly actions: BakedActions<T, A>
    clearPersisted(): void
  }

  /** store 句柄：spec + 实例工厂；在 apply 世界构造并在多个 register 间共享。 */
  export interface EngineStoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: StoreSpec<T, A>
    /** @param scopeKey - session 作用域实例传会话 id（持久化键按其加后缀）。 */
    create(scopeKey?: string): EngineStoreInstance<T, A>
  }

  /** 把 store 声明归一成句柄类型（工厂形式取其返回）。 */
  export type HandleOf<H> = H extends () => infer R ? R : H

  /** 声明了 store 的 register，其 inject 工厂收到的 actions 参数。 */
  export type BoundActions<H> = H extends EngineStoreHandle<infer T, infer A> ? BakedActions<T, A> : never

  /** store props 份：typed selector hook + 烘焙写集合（组件永远看不到实例本身）。 */
  export type PropsStore<H> = H extends EngineStoreHandle<infer T, infer A>
    ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
    : object

  /**
   * 声明一个 store。
   * @param decl - init 工厂 + 可选持久化键 + actions 表。
   * @returns store 句柄。
   */
  export function defineStore<T, A extends ActionsDecl<T>>(
    decl: StoreSpec<T, A> & { actions: A & ActionsDecl<T> },
  ): EngineStoreHandle<T, A>
}
