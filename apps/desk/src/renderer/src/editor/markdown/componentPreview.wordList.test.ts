// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { deskWordListStorageScope } from '@tnotesjs/ui'

import { mountWordListPreview } from './componentPreview'

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.innerHTML = ''
  localStorage.clear()
})

function mountFor(noteUuid: string, words: string[]): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const handle = mountWordListPreview(host, {
    words,
    storageScope: deskWordListStorageScope('kb-repro', noteUuid)
  })
  cleanups.push(() => handle.unmount())
  return host
}

function boxes(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
}

describe('mountWordListPreview 勾选态', () => {
  it('笔记 A 勾选的词不会出现在笔记 B（todo 04）', async () => {
    const a = mountFor('note-a', ['apple', 'banana'])
    await nextTick()
    boxes(a)[0]!.click()
    await nextTick()
    expect(boxes(a)[0]!.checked).toBe(true)

    const b = mountFor('note-b', ['apple', 'cherry'])
    await nextTick()
    expect(boxes(b).map((box) => box.checked)).toEqual([false, false])

    const aAgain = mountFor('note-a', ['apple', 'banana'])
    await nextTick()
    expect(boxes(aAgain).map((box) => box.checked)).toEqual([true, false])
  })

  it('换作用域时按新笔记重新回读', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const handle = mountWordListPreview(host, {
      words: ['apple'],
      storageScope: deskWordListStorageScope('kb-repro', 'note-a')
    })
    cleanups.push(() => handle.unmount())
    await nextTick()
    boxes(host)[0]!.click()
    await nextTick()
    handle.update({
      words: ['apple'],
      storageScope: deskWordListStorageScope('kb-repro', 'note-b')
    })
    await nextTick()
    expect(boxes(host)[0]!.checked).toBe(false)
  })
})
