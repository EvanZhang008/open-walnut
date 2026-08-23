import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishCheck } from '../../packages/plugin-cli/src/publish-check.js'
import { scaffoldPlugin } from '../../packages/plugin-cli/src/scaffold.js'

const roots: string[] = []

async function createPlugin(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-publish-check-'))
  roots.push(parent)
  const root = path.join(parent, 'publish-fixture')
  await scaffoldPlugin('publish-fixture', root, { template: 'server' })
  return root
}

async function updatePackage(root: string, update: (pkg: Record<string, any>) => void): Promise<void> {
  const file = path.join(root, 'package.json')
  const pkg = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>
  update(pkg)
  await fs.writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('Plugin publish check', () => {
  it('checks the real npm file list without running lifecycle scripts', async () => {
    const root = await createPlugin()
    const marker = path.join(root, 'prepack-ran')
    await updatePackage(root, (pkg) => {
      expect(pkg.files).toEqual(['manifest.json', 'dist', 'skills', 'app'])
      pkg.scripts.prepack = `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`
    })

    const result = await publishCheck(root)

    expect(result.id).toBe('publish-fixture')
    expect(result.outputs).toEqual(['dist/server.mjs'])
    expect(result.packedFiles).toEqual(expect.arrayContaining(['manifest.json', 'dist/server.mjs']))
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects private packages and version drift', async () => {
    const root = await createPlugin()
    await updatePackage(root, (pkg) => { pkg.private = true })
    await expect(publishCheck(root)).rejects.toThrow(/private: true/)

    await updatePackage(root, (pkg) => {
      delete pkg.private
      pkg.version = '0.2.0'
    })
    await expect(publishCheck(root)).rejects.toThrow(/manifest\.json version must match package\.json version/)
  })

  it('rejects a files allowlist that omits a built entry', async () => {
    const root = await createPlugin()
    await updatePackage(root, (pkg) => { pkg.files = ['manifest.json'] })

    await expect(publishCheck(root)).rejects.toThrow(/missing required Plugin files: dist\/server\.mjs/)
  })

  it('rejects source maps and common secret files from the final tarball', async () => {
    const root = await createPlugin()
    await fs.mkdir(path.join(root, 'dist'), { recursive: true })
    await fs.writeFile(path.join(root, 'dist', 'private.key'), 'not-a-real-key\n')
    await fs.writeFile(path.join(root, 'dist', 'server.mjs.map'), '{}\n')

    await expect(publishCheck(root)).rejects.toThrow(/forbidden files:.*private\.key.*server\.mjs\.map/)
  })

  it('requires every conventional Skill in the packed files', async () => {
    const root = await createPlugin()
    const skill = path.join(root, 'skills', 'demo', 'SKILL.md')
    await fs.mkdir(path.dirname(skill), { recursive: true })
    await fs.writeFile(skill, '---\nname: demo\ndescription: Demo\n---\n')
    await updatePackage(root, (pkg) => { pkg.files = ['manifest.json', 'dist'] })

    await expect(publishCheck(root)).rejects.toThrow(/missing required Plugin files: skills\/demo\/SKILL\.md/)
  })

  it('does not require macOS metadata that npm omits from packages', async () => {
    const root = await createPlugin()
    const skillDir = path.join(root, 'skills', 'demo')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n')
    await fs.writeFile(path.join(skillDir, '.DS_Store'), 'metadata\n')

    const result = await publishCheck(root)

    expect(result.packedFiles).toContain('skills/demo/SKILL.md')
    expect(result.packedFiles).not.toContain('skills/demo/.DS_Store')
  })

  it('requires every file in a conventional Skill directory', async () => {
    const root = await createPlugin()
    const skillDir = path.join(root, 'skills', 'demo')
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n')
    await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), '# Guide\n')
    await updatePackage(root, (pkg) => {
      pkg.files = ['manifest.json', 'dist', 'skills/demo/SKILL.md']
    })

    await expect(publishCheck(root)).rejects.toThrow(/missing required Plugin files: skills\/demo\/references\/guide\.md/)
  })

  it('requires the declared Webview entry in the packed files', async () => {
    const root = await createPlugin()
    const manifestFile = path.join(root, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, any>
    manifest.webview = { title: 'External', entry: 'app/index.html' }
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(publishCheck(root)).rejects.toThrow(/missing required Plugin files: app\/index\.html/)
  })

  it('requires sibling assets from the declared Webview directory', async () => {
    const root = await createPlugin()
    const manifestFile = path.join(root, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, any>
    manifest.webview = { title: 'External', entry: 'app/index.html' }
    await fs.mkdir(path.join(root, 'app'), { recursive: true })
    await fs.writeFile(path.join(root, 'app', 'index.html'), '<script src="app.js"></script>\n')
    await fs.writeFile(path.join(root, 'app', 'app.js'), 'document.body.textContent = "ready"\n')
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await updatePackage(root, (pkg) => {
      pkg.files = ['manifest.json', 'dist', 'app/index.html']
    })

    await expect(publishCheck(root)).rejects.toThrow(/missing required Plugin files: app\/app\.js/)
  })
})
