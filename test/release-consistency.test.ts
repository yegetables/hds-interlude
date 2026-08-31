import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HDS_INTERLUDE_VERSION } from '../src/meta'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

test('release-facing files share the runtime version', () => {
  const manifest = JSON.parse(read('package.json')) as { version: string, files: string[] }
  assert.equal(manifest.version, HDS_INTERLUDE_VERSION)
  for (const file of [
    'README.md', 'CONFIGURATION_GUIDE.md', 'BEGINNER_GUIDE.md', 'DEPLOYMENT_GUIDE.md', 'command.md',
    'docs/ARCHITECTURE.md', 'docs/AGENCY_WINDOW.md', 'docs/ALTER_SYSTEM.md', 'docs/SCHEDULE_PREPLAN.md', 'docs/README.md', 'docs/SECURITY.md',
    'docs/development/logging/LAYERED_LOG_IMPLEMENTATION.md',
  ]) {
    assert.match(read(file), new RegExp(HDS_INTERLUDE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), file)
  }
  const guide = readdirSync(pluginRoot).find(name => name.endsWith('.html') && name.includes(HDS_INTERLUDE_VERSION))
  assert.ok(guide, `missing deployment HTML for ${HDS_INTERLUDE_VERSION}`)
  assert.match(read(guide!), new RegExp(`koishi-plugin-hds-interlude-${HDS_INTERLUDE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tgz`))
})

test('published documentation includes every README-linked design index and current setup wording', () => {
  const manifest = JSON.parse(read('package.json')) as { files: string[] }
  assert.ok(manifest.files.includes('docs/README.md'))
  assert.ok(manifest.files.includes('docs/development'))
  assert.ok(manifest.files.includes('docs/SCHEDULE_PREPLAN.md'))
  assert.match(read('CONFIGURATION_GUIDE.md'), /useForStickers/)
  assert.match(read('DEPLOYMENT_GUIDE.md'), /DeepSeek 官方提供商/)
  assert.match(read('README.md'), /corepack yarn add/)
  assert.doesNotMatch(read('BEGINNER_GUIDE.md'), /主叙事模型位置选择一个模型预设/)
})
