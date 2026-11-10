import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readDemoCatalog, resolveDemoIds } from './demos'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function kb(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-demos-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

describe('demo catalog', () => {
  it('标题来自文件夹名，简介只来自 demos.json', () => {
    const root = kb({
      'demos/demos.json': JSON.stringify({
        '0001': { description: '单页挂载' },
        '0002': {}
      }),
      'demos/0001. 挂载根组件/1.html': '<html></html>',
      'demos/0002. 两个实例/1.html': '<html></html>',
      'demos/0003. 没有登记/1.html': '<html></html>',
      'demos/readme.txt': '不是文件夹'
    })
    const entries = readDemoCatalog(root)
    expect(entries.map((entry) => [entry.id, entry.title, entry.description])).toEqual([
      ['0001', '挂载根组件', '单页挂载'],
      ['0002', '两个实例', '']
    ])
    expect(entries[0]?.absolutePath).toBe(path.join(root, 'demos/0001. 挂载根组件'))
    expect(resolveDemoIds(entries, ['0001', '0003', '0009']).missingIds).toEqual(['0003', '0009'])
  })

  it('没有 demos 目录时目录为空', () => {
    expect(readDemoCatalog(kb({}))).toEqual([])
  })
})
