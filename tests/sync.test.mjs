/**
 * preset-sync.js 单元测试：bundle 渲染、行名锚定、幂等同步、变更重写、多余文件
 * 清理、retire、旧发现根退役、无关目录隔离。
 * 运行：node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { renderBundleFiles, retireLegacyPresets, syncOnePreset, syncPresetTrees } from '../src/preset-sync.js'

function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
}

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

/** 最小预设源树：一行插件清单 + 元数据 + 一个自带插件。 */
function sourceFiles(rows = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n") {
  return {
    'agent.cordis.yml': `# 说明注释块\n\n${rows}`,
    'preset.yml': 'name: 工程模式\ndescription: 面向工程的 Agent\n',
    'plugins/a/index.js': 'export const name = "a"\n',
  }
}

test('渲染：产出 bundle 清单与声明 patch，行清单来自 agent.cordis.yml', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'local-bundles', 'dsh-preset-eng')
  makeTree(source, sourceFiles())
  assert.equal(syncOnePreset(source, target, { order: 10 }), 'synced')

  assert.deepEqual(treeFiles(target), ['package.json', 'plugins/a/index.js', 'preset.patch.yml'])
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-preset-eng')
  assert.equal(manifest.dsh.bundle.patch, './preset.patch.yml')
  const patch = readFileSync(join(target, 'preset.patch.yml'), 'utf8')
  assert.equal(patch.includes('        id: eng'), true)
  assert.equal(patch.includes('        name: "工程模式"'), true)
  assert.equal(patch.includes('        order: 10'), true)
  assert.equal(patch.includes("- id: persona"), true)
  rmSync(base, { recursive: true, force: true })
})

test('渲染：相对插件名改写成目标目录下的 file:// 绝对 URL', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'local-bundles', 'dsh-preset-eng')
  makeTree(source, sourceFiles("- id: local-tool\n  name: ./plugins/a/index.js\n  config:\n    x: 1\n"))
  syncOnePreset(source, target)
  const patch = readFileSync(join(target, 'preset.patch.yml'), 'utf8')
  assert.equal(patch.includes(`name: file://${join(target, 'plugins/a/index.js')}`), true)
  assert.equal(/name: \.\//.test(patch), false, `patch 里仍残留相对行名：\n${patch}`)
  rmSync(base, { recursive: true, force: true })
})

test('渲染：renderBundleFiles 是纯函数，不写盘', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'out')
  makeTree(source, sourceFiles())
  const files = renderBundleFiles(source, target, 11)
  assert.deepEqual([...files.keys()], ['package.json', 'preset.patch.yml'])
  assert.equal(existsSync(target), false)
  assert.equal(files.get('preset.patch.yml').includes('order: 11'), true)
  rmSync(base, { recursive: true, force: true })
})

test('幂等：第二次同步返回 current 且不动 mtime', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'dst')
  makeTree(source, sourceFiles())
  assert.equal(syncOnePreset(source, target), 'synced')
  const mtime = statSync(join(target, 'preset.patch.yml')).mtimeMs
  assert.equal(syncOnePreset(source, target), 'current')
  assert.equal(statSync(join(target, 'preset.patch.yml')).mtimeMs, mtime)
  rmSync(base, { recursive: true, force: true })
})

test('变更重写：源改动后重渲染', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'dst')
  makeTree(source, sourceFiles())
  syncOnePreset(source, target)
  writeFileSync(join(source, 'agent.cordis.yml'), "# v2\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    maxBytes: 1\n")
  assert.equal(syncOnePreset(source, target), 'synced')
  assert.equal(readFileSync(join(target, 'preset.patch.yml'), 'utf8').includes('maxBytes: 1'), true)
  rmSync(base, { recursive: true, force: true })
})

test('多余文件清理：目标里源树不含的文件被删除，空目录一并清掉', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'eng')
  const target = join(base, 'dst')
  makeTree(source, sourceFiles())
  syncOnePreset(source, target)
  makeTree(target, { 'stale/left.js': 'x\n' })
  assert.equal(syncOnePreset(source, target), 'synced')
  assert.deepEqual(treeFiles(target), ['package.json', 'plugins/a/index.js', 'preset.patch.yml'])
  rmSync(base, { recursive: true, force: true })
})

test('syncPresetTrees：多预设 + retire 只删插件曾拥有的 id，不碰无关目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const sourceRoot = join(base, 'presets')
  const targetRoot = join(base, 'local-bundles')
  makeTree(join(sourceRoot, 'eng'), sourceFiles())
  makeTree(join(sourceRoot, 'other'), sourceFiles())
  makeTree(targetRoot, { 'dsh-preset-retired-old/package.json': '{}\n', 'user-made/package.json': '{}\n' })

  const result = syncPresetTrees(sourceRoot, targetRoot, ['retired-old'])
  assert.deepEqual(result.synced.sort(), ['eng', 'other'])
  assert.deepEqual(result.current, [])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.retired, ['retired-old'])
  assert.equal(existsSync(join(targetRoot, 'dsh-preset-retired-old')), false)
  assert.equal(existsSync(join(targetRoot, 'user-made')), true)
  assert.equal(existsSync(join(targetRoot, 'dsh-preset-eng', 'preset.patch.yml')), true)
  // 列表顺序按目录名排序，retire 之外的 id 不参与编号。
  assert.equal(readFileSync(join(targetRoot, 'dsh-preset-eng', 'preset.patch.yml'), 'utf8').includes('order: 10'), true)
  rmSync(base, { recursive: true, force: true })
})

test('retireLegacyPresets：只删插件发布的 id，用户自建预设不动', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const sourceRoot = join(base, 'presets')
  const legacyRoot = join(base, '.agent-presets')
  makeTree(join(sourceRoot, 'eng'), sourceFiles())
  makeTree(legacyRoot, { 'eng/agent.cordis.yml': 'old\n', 'mine/agent.cordis.yml': 'user\n' })
  assert.deepEqual(retireLegacyPresets(sourceRoot, legacyRoot), ['eng'])
  assert.equal(existsSync(join(legacyRoot, 'eng')), false)
  assert.equal(existsSync(join(legacyRoot, 'mine', 'agent.cordis.yml')), true)
  assert.deepEqual(retireLegacyPresets(sourceRoot, legacyRoot), [])
  rmSync(base, { recursive: true, force: true })
})
