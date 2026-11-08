import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { CONFIG_FILE } from './constants'
import { readKbConfig } from './scanner'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Write `tnotes.json` → `id` when it is missing or not a UUID. Returns the id. */
export async function ensureKnowledgeBaseId(rootPath: string): Promise<string> {
  const { config } = await readKbConfig(rootPath)
  if (typeof config.id === 'string' && UUID.test(config.id)) return config.id
  const id = randomUUID()
  const next = { ...config, id }
  await fs.writeFile(
    path.join(rootPath, CONFIG_FILE),
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8'
  )
  return id
}
