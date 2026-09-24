/**
 * apply 冒烟测试：以临时 DSH_HOME 调用宿主插件 apply，验证启动同步路径
 * （home 解析 → 预设渲染成 <home>/local-bundles 下的声明 bundle，并退役
 * <home>/.agent-presets 旧目录）端到端可用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { apply, bundledPresetsRoot, name } from '../src/index.js'
import { syncOnePreset } from '../src/preset-sync.js'
/** eng 在同步里的 bundle 目录名，apply 与 syncOnePreset 都用它。 */
const given = 'dsh-preset-eng'

function treeFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out.sort()
}

test('插件导出契约：name / apply / bundledPresetsRoot', () => {
  assert.equal(name, 'apollo-skills')
  assert.equal(typeof apply, 'function')
  assert.equal(bundledPresetsRoot().endsWith('/presets/'), true)
})

test('apply：把捆绑预设渲染成 local-bundles 下的声明 bundle，并退役旧目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'eng-home-'))
  const logs = []
  // 预置 0.1.7 之前的旧发现根状态：插件发布的 eng 目录 + 用户自建目录。
  mkdirSync(join(home, '.agent-presets', 'eng'), { recursive: true })
  writeFileSync(join(home, '.agent-presets', 'eng', 'agent.cordis.yml'), 'legacy\n')
  mkdirSync(join(home, '.agent-presets', 'mine'), { recursive: true })
  writeFileSync(join(home, '.agent-presets', 'mine', 'agent.cordis.yml'), 'user\n')
  process.env.DSH_HOME = home
  try {
    apply({ skills: { registerProvider: () => {} }, logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) } })
  } finally {
    delete process.env.DSH_HOME
  }

  const targetRoot = join(home, 'local-bundles', given)
  const sourceRoot = bundledPresetsRoot()
  assert.equal(statSync(targetRoot).isDirectory(), true)
  // 同步结果与渲染结果逐字节一致。
  assert.equal(syncOnePreset(join(sourceRoot, 'eng'), targetRoot, { order: 10 }), 'current')
  assert.deepEqual(treeFiles(targetRoot).filter((rel) => rel.startsWith('plugins/')).length > 0, true)
  assert.equal(readFileSync(join(targetRoot, 'preset.patch.yml'), 'utf8').includes('工程模式'), true)
  // 0.1.7 起宿主不再扫描旧发现根，插件自己在启动时清掉它发布过的 id。
  assert.equal(existsSync(join(home, '.agent-presets', 'eng')), false)
  assert.equal(statSync(join(home, '.agent-presets', 'mine', 'agent.cordis.yml')).isFile(), true)
  assert.equal(logs.some((entry) => entry[0] === 'info'), true)
  rmSync(home, { recursive: true, force: true })
})

test('apply：幂等，重复挂载不报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'eng-home-'))
  process.env.DSH_HOME = home
  try {
    apply({ skills: { registerProvider: () => {} }, logger: console })
    apply({ skills: { registerProvider: () => {} }, logger: console })
  } finally {
    delete process.env.DSH_HOME
  }
  assert.equal(statSync(join(home, 'local-bundles', given, 'preset.patch.yml')).isFile(), true)
  rmSync(home, { recursive: true, force: true })
})
