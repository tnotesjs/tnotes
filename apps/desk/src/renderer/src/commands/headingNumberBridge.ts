type HeadingNumberActions = {
  add: () => void
  remove: () => void
}

let actions: HeadingNumberActions | null = null

export function registerHeadingNumberActions(next: HeadingNumberActions | null): void {
  actions = next
}

export function canRunHeadingNumbers(): boolean {
  return actions != null
}

export function runAddHeadingNumbers(): void {
  actions?.add()
}

export function runRemoveHeadingNumbers(): void {
  actions?.remove()
}
