import { describe, expect, it } from 'vitest'

import { knowledgeBaseSettingsWriteSchema } from './schemas'

const base = {
  knowledgeBaseId: 'kb-1',
  name: 'TNotes.test',
  title: '测试',
  port: 9193,
  statsEnabled: false
}

describe('知识库配置写入 schema', () => {
  it('保留库级约定字段（此前被 zod 剥掉，保存后不落盘）', () => {
    const parsed = knowledgeBaseSettingsWriteSchema.parse({
      ...base,
      autoPush: { enabled: true, idleMinutes: 5 },
      pushRunUpdateBefore: false,
      headingNumberMaxDepth: 3,
      lineBreaks: 'visual'
    })
    expect(parsed).toMatchObject({
      autoPush: { enabled: true, idleMinutes: 5 },
      pushRunUpdateBefore: false,
      headingNumberMaxDepth: 3,
      lineBreaks: 'visual'
    })
  })

  it('接受 null 表示删键', () => {
    const parsed = knowledgeBaseSettingsWriteSchema.parse({
      ...base,
      autoPush: null,
      pushRunUpdateBefore: null,
      headingNumberMaxDepth: null
    })
    expect(parsed.autoPush).toBeNull()
    expect(parsed.headingNumberMaxDepth).toBeNull()
  })

  it('拒绝未知的换行方式', () => {
    expect(knowledgeBaseSettingsWriteSchema.safeParse({ ...base, lineBreaks: 'gfm' }).success).toBe(
      false
    )
  })
})
