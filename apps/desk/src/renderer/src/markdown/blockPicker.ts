/**
 * 插入块列表（斜杠菜单与工具栏「插入」菜单共用的 DOM）。
 * 只管显示与选中，键盘由宿主转发：斜杠菜单的焦点留在编辑器里，工具栏菜单的焦点在搜索框里。
 */
import { INSERT_GROUP_LABELS, primaryAlias } from './insertCatalog'

import type { InsertItem } from './insertCatalog'

import './blockPicker.css'

export interface BlockPickerOptions {
  onPick(item: InsertItem): void
}

export class BlockPicker {
  readonly dom: HTMLElement
  private items: InsertItem[] = []
  private rows: HTMLElement[] = []
  private selected = 0

  constructor(private readonly options: BlockPickerOptions) {
    this.dom = document.createElement('div')
    this.dom.className = 'tn-block-picker'
    this.dom.setAttribute('role', 'listbox')
    this.dom.addEventListener('mousedown', (event) => event.preventDefault())
  }

  get current(): InsertItem | null {
    return this.items[this.selected] ?? null
  }

  get size(): number {
    return this.items.length
  }

  /** `grouped`：没有输入时按分组列出；有输入时按匹配度平铺。 */
  setItems(items: InsertItem[], grouped: boolean): void {
    this.items = items
    this.selected = 0
    this.rows = []
    this.dom.replaceChildren()
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tn-block-picker-empty'
      empty.textContent = '没有匹配的块'
      this.dom.append(empty)
      return
    }
    let group: string | null = null
    items.forEach((item, index) => {
      if (grouped && item.group !== group) {
        group = item.group
        const heading = document.createElement('div')
        heading.className = 'tn-block-picker-group'
        heading.textContent = INSERT_GROUP_LABELS[item.group]
        this.dom.append(heading)
      }
      const row = this.row(item, index)
      this.rows.push(row)
      this.dom.append(row)
    })
    this.paint()
  }

  move(delta: number): void {
    if (this.items.length === 0) return
    this.select((this.selected + delta + this.items.length) % this.items.length)
  }

  select(index: number): void {
    if (index < 0 || index >= this.items.length) return
    this.selected = index
    this.paint()
  }

  pickSelected(): boolean {
    const item = this.current
    if (!item) return false
    this.options.onPick(item)
    return true
  }

  private row(item: InsertItem, index: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tn-block-picker-item'
    row.setAttribute('role', 'option')
    row.dataset.id = item.id
    if (item.tone) row.dataset.tone = item.tone
    const icon = document.createElement('span')
    icon.className = 'tn-block-picker-icon'
    icon.innerHTML = item.icon
    const label = document.createElement('span')
    label.className = 'tn-block-picker-label'
    label.textContent = item.label
    const alias = document.createElement('span')
    alias.className = 'tn-block-picker-alias'
    alias.textContent = primaryAlias(item)
    row.append(icon, label, alias)
    // 键盘滚动列表时鼠标不动也会触发 mouseenter，只认真正的移动
    row.addEventListener('mousemove', () => {
      if (this.selected !== index) this.select(index)
    })
    row.addEventListener('click', () => this.options.onPick(item))
    return row
  }

  private paint(): void {
    this.rows.forEach((row, index) => {
      const active = index === this.selected
      row.classList.toggle('is-selected', active)
      row.setAttribute('aria-selected', String(active))
    })
    this.reveal(this.rows[this.selected])
  }

  /** 只滚列表自己（scrollIntoView 会连带滚动编辑器） */
  private reveal(row: HTMLElement | undefined): void {
    if (!row) return
    const heading = row.previousElementSibling
    const top = heading?.classList.contains('tn-block-picker-group')
      ? (heading as HTMLElement).offsetTop
      : row.offsetTop
    const bottom = row.offsetTop + row.offsetHeight
    const padding = 4
    if (top - padding < this.dom.scrollTop) this.dom.scrollTop = Math.max(0, top - padding)
    else if (bottom + padding > this.dom.scrollTop + this.dom.clientHeight) {
      this.dom.scrollTop = bottom + padding - this.dom.clientHeight
    }
  }
}
