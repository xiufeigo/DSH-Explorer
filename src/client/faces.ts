/**
 * Apply-world inject faces: JSON-compatible data, callbacks, and the store
 * handle created in apply. Components never receive ctx or whole services.
 */

export interface LayoutActions {
  openDetails(): void
  closeDetails(): void
}

interface LayoutLike {
  openDetails(): void
  closeDetails(): void
}

export function layoutActions(layout: LayoutLike): LayoutActions {
  return {
    openDetails: () => { layout.openDetails() },
    closeDetails: () => { layout.closeDetails() },
  }
}
