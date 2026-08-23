import fs from 'node:fs/promises'
import path from 'node:path'
import { assertValid, validatePlugin } from './manifest.js'

export async function linkPlugin(root = process.cwd()): Promise<string> {
  const manifest = assertValid(await validatePlugin(root))
  const pluginRoot = await fs.realpath(path.resolve(root))
  const home = process.env.OPEN_WALNUT_HOME ?? path.join(process.env.HOME ?? '', '.open-walnut')
  const linksDir = path.join(home, 'plugins')
  const target = path.join(linksDir, manifest.id)
  await fs.mkdir(linksDir, { recursive: true })

  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.symlink(pluginRoot, target, 'dir')
    return target
  }
  if (!stat.isSymbolicLink()) throw new Error(`Link target already exists and is not a symlink: ${target}`)

  let current: string
  try {
    current = await fs.realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.unlink(target)
    await fs.symlink(pluginRoot, target, 'dir')
    return target
  }
  if (current !== pluginRoot) throw new Error(`Plugin id is linked to another directory: ${current}`)
  return target
}
