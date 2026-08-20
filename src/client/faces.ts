/**
 * Apply-world inject faces: JSON-compatible data, callbacks, and the store
 * handle created in apply. Components never receive ctx or whole services.
 */

export interface LayoutActions {
  openDetails(): void
  closeDetails(): void
}

export interface CatalogActions {
  refreshSubagents(id: string): void
  setSubagentCatalogOpen(id: string, open: boolean): void
}

interface LayoutLike {
  openDetails(): void
  closeDetails(): void
}

interface SessionsLike {
  refreshSubagents?(id: string): Promise<void> | void
  setSubagentCatalogOpen?(id: string, open: boolean): void
}

export function layoutActions(layout: LayoutLike): LayoutActions {
  return {
    openDetails: () => { layout.openDetails() },
    closeDetails: () => { layout.closeDetails() },
  }
}

export function catalogActions(sessions: unknown): CatalogActions {
  const face = sessions as SessionsLike
  return {
    refreshSubagents: (id) => { void face.refreshSubagents?.(id) },
    setSubagentCatalogOpen: (id, open) => { face.setSubagentCatalogOpen?.(id, open) },
  }
}
