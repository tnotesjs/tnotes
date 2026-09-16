import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** Trap keyboard focus and restore both focus and body scrolling when a modal closes. */
export function useModalFocus(
  open: Ref<boolean>,
  root: () => HTMLElement | null,
  close: () => void
) {
  let previous: HTMLElement | null = null
  let overflow = ''
  let locked = false
  const focusable = () =>
    Array.from(
      root()?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input, [tabindex="0"]'
      ) ?? []
    ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const list = focusable()
    const first = list[0],
      last = list.at(-1)
    if (!first) {
      event.preventDefault()
      return
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || !root()?.contains(document.activeElement))
    ) {
      event.preventDefault()
      last?.focus()
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !root()?.contains(document.activeElement))
    ) {
      event.preventDefault()
      first.focus()
    }
  }
  function release() {
    if (!locked) return
    locked = false
    document.body.style.overflow = overflow
    document.removeEventListener('keydown', keydown)
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }
  watch(
    open,
    async (value) => {
      if (!value) {
        release()
        return
      }
      previous = document.activeElement as HTMLElement
      overflow = document.body.style.overflow
      locked = true
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', keydown)
      await nextTick()
      if (open.value)
        (root()?.querySelector<HTMLInputElement>('input') ?? focusable()[0])?.focus({
          preventScroll: true
        })
    },
    { flush: 'post' }
  )
  onBeforeUnmount(release)
}
