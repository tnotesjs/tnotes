import fs from 'node:fs'
import path from 'node:path'

import { readKbConfig } from '@tnotesjs/kb'

import type { ResolvedSsgConfig, SsgConfig } from './types'

export function defineConfig(config: SsgConfig): SsgConfig {
  return config
}

const normalizeBase = (base: string) => {
  const value = `/${base}/`.replace(/\/+/g, '/')
  return value === '//' ? '/' : value
}

/**
 * Resolve the site config from the knowledge base root. tnotes.json is the
 * only config file; build conventions (outDir/cacheDir/publicDir) are fixed.
 */
export async function resolveConfig(root = process.cwd()): Promise<ResolvedSsgConfig> {
  const requestedRoot = path.resolve(root)
  const absoluteRoot = fs.existsSync(requestedRoot)
    ? fs.realpathSync.native(requestedRoot)
    : requestedRoot

  const { config, diagnostic } = await readKbConfig(absoluteRoot)
  if (diagnostic) throw new Error(diagnostic.message)
  const user = config as SsgConfig

  return {
    root: absoluteRoot,
    outDir: path.resolve(absoluteRoot, '.tnotes/dist'),
    cacheDir: path.resolve(absoluteRoot, 'node_modules/.tnotes-ssg'),
    publicDir: path.resolve(absoluteRoot, 'public'),
    base: normalizeBase(user.base ?? '/'),
    title: user.title ?? path.basename(absoluteRoot),
    description: user.description ?? '',
    lang: user.lang ?? 'zh-Hans',
    port: user.port ?? 9193,
    home: user.home,
    repositoryUrl: user.repositoryUrl,
    icon: user.icon,
    discussions: user.discussions === true,
    ignoreDeadLinks: user.ignoreDeadLinks ?? false,
    head: user.head ?? [],
    theme: user.theme,
    markdown: {
      lineNumbers: user.markdown?.lineNumbers !== false,
      math: user.markdown?.math !== false,
      imageLazyLoading: user.markdown?.imageLazyLoading !== false
    }
  }
}
