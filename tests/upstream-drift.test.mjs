/**
 * 上游漂移自检：eng 预设是内置 `standard` 预设的整棵 fork，DSH 升级后上游新增
 * 的行不会自动传过来（2026-09-12 已因此漏掉 `@deepseek-ai/dsh-tool-present`）。
 *
 * 两类检查：
 * 1. **漂移**：eng 与上游 standard 去掉注释/空行后只允许有白名单内的差异；出现
 *    白名单外的差异（尤其是上游有 eng 没有的行）即失败，提示把哪一行带过来。
 * 2. **两份副本一致**：`node --test` 会把包内 `presets/eng/` 同步进
 *    `<dshHome>/.agent-presets/eng`（与 dsh 启动时的 sync-on-boot 同一个函数），
 *    改完源树不跑测试直接重启，跑的就是旧副本——这里直接堵掉。
 *
 * 上游文件不存在（非 npm 布局、DSH 未安装）时跳过，不让本包在没有 harness 的
 * 环境里失败。
 * 运行：node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, syncPresetTrees } from '../src/preset-sync.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENG_PRESET = join(PACKAGE_ROOT, 'presets', 'eng')

/**
 * 本包相对上游 standard 的有意差异。eng 只做加法、一处调参，和本 fork 的
 * 部署侧行覆盖：
 * - 三个预设本地插件行（eng 独有）；
 * - tool-result-pruner 的阈值放大到 2 倍，上游值由下方 pruner 常量描述；
 * - delegation 组里 8 个官方 tool-subagent 角色行（本 fork 的派发面，
 *   2026-09-18 随 dsh-subagent-dispatch 退役加入；通用行 `tool-subagent`
 *   不是新行，其键差异由下方 ROW_OVERRIDES 声明）。
 */
const EXTRA_ENG_ROWS = [
  "tool-subagent-roundtable -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-researcher -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-scout -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-tdd-tester -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-implementer -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-reviewer -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-code-quality-reviewer -> @deepseek-ai/dsh-tool-subagent",
  "tool-subagent-lark -> @deepseek-ai/dsh-tool-subagent",
  "tool-wait-subagent -> ./plugins/wait-subagent/index.js",
  "eng-exit-guard -> ./plugins/exit-guard/index.js",
  "eng-mode-instructions -> ./plugins/mode-instructions/index.js",
]

/** tool-result-pruner 有意放大的阈值：eng 值 → 上游值（预设内注释说明了原因）。 */
const PRUNER_OVERRIDES = new Map([
  ['16384', '8192'],
  ['8192', '4096'],
  ['2048', '1024'],
])

/**
 * 有意覆盖的上游行配置：rowId → (键 → 上游该键的值)。只有本 fork 的
 * 部署侧 delta 能进这张表，纯调参仍走 PRUNER_OVERRIDES。上游没有的键写成
 * undefined——声明本身就是"这里是相对上游的差异，且差异已知"。
 */
const ROW_OVERRIDES = new Map([
  // 派发面的官方承载（2026-09-18）：本 fork 的 tool-subagent 配置面给该行
  // 加了 `models` 别名表与 `defaultModel`（上游均无此键），同时删掉了上游
  // 的 `modelSelectionSettings: true`——`models` 与它互斥，保留会在 mount
  // 期 fail loud。键删除不在本测试的检测面（遍历以 eng 键为准），故只声明
  // 新增键。
  ['tool-subagent', new Map([['defaultModel', undefined], ['models.*', undefined]])],
])

/**
 * 解析本机 DSH 安装根。优先 `DSH_PACKAGE_ROOT`（指向 dsh 包目录，便于异机排查），
 * 其次沿 node 可执行文件向上找全局安装目录（`node_modules` 与 `lib/node_modules`，
 * 覆盖 nvm 与系统级 npm 两种布局），最后退回 node 自带的解析器；找不到返回
 * undefined，调用方跳过检查——本包在没有 harness 的环境里不该失败。
 */
function dshPackageRoot() {
  const override = process.env.DSH_PACKAGE_ROOT
  if (override !== undefined && existsSync(join(override, 'package.json'))) return override
  const relative = join('@deepseek-ai', 'dsh', 'package.json')
  let dir = dirname(process.execPath)
  for (let depth = 0; depth < 6; depth += 1) {
    for (const prefix of [['node_modules'], ['lib', 'node_modules']]) {
      const candidate = join(dir, ...prefix, relative)
      if (existsSync(candidate)) return dirname(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    return dirname(createRequire(process.execPath).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    return undefined
  }
}

/**
 * 顶层行序列：去掉注释与空行，再把 `- id:` 列表项与紧随其后的 `name:` 折成
 * `id -> name` 一项。折叠断言比逐行断言更严——行序错位或缺配置项都会暴露，
 * 同时允许上游新增行被显式看见。缩进与引号差异被抹平：两者都不改变解析结果。
 */
function topLevelEntries(file) {
  const entries = []
  const rows = normalizedRows(file)
  for (let i = 0; i < rows.length; i += 1) {
    const idMatch = /^- id:[ \t]*(.+)$/.exec(rows[i])
    if (idMatch === null) continue
    const id = idMatch[1].trim()
    const next = rows[i + 1] ?? ''
    entries.push(next.startsWith('name:') ? `${id} -> ${unquote(next.slice('name:'.length).trim())}` : id)
  }
  return entries
}

/**
 * 每个顶层行的 `config:` 子树（id 行自身与 `name:` 行除外），键 → 值。
 * 供逐行比对配置漂移；行原文不再直接比较，避免把行距与缩进当成差异。
 */
function configOfRows(file) {
  const configs = new Map()
  let current
  let nested = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idMatch = /^- id:[ \t]*(.+)$/.exec(line)
    if (idMatch !== null) {
      current = idMatch[1].trim()
      configs.set(current, new Map())
      nested = false
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('name:')) continue
    const keyValue = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (keyValue !== null) {
      // 嵌套键（group/isolate 下的行）归到其父键，不单独成为一项。
      nested = /^[A-Za-z0-9_-]+:$/.test(line)
      const key = nested ? `${keyValue[1]}.*` : keyValue[1]
      configs.get(current).set(key, nested ? '' : keyValue[2])
      continue
    }
    if (nested) {
      const [key] = [...configs.get(current).keys()].slice(-1)
      configs.get(current).set(key, `${configs.get(current).get(key)} ${line}`.trim())
    }
  }
  return configs
}

/** 抹平 YAML 引号差异（`'x'` 与 `x` 解析为同一值）。 */
function unquote(value) {
  return value.replace(/^'(.*)'$/, '$1')
}

/** 去掉注释与空行，并抹平缩进——只留「有哪些行」。 */
function normalizedRows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** 上游 standard 预设文件；本机没有 DSH 安装时返回 undefined（跳过检查）。 */
function upstreamPresetFile() {
  const root = dshPackageRoot()
  if (root === undefined) return undefined
  const file = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  return existsSync(file) ? file : undefined
}

test('eng 预设的行与上游 standard 对齐，差异只有白名单', (t) => {
  const upstreamFile = upstreamPresetFile()
  if (upstreamFile === undefined) {
    t.skip('本机没有 DSH 内置 standard 预设，跳过漂移检查')
    return
  }
  const engFile = join(ENG_PRESET, 'agent.cordis.yml')
  const upstream = topLevelEntries(upstreamFile)
  const eng = topLevelEntries(engFile)

  // 顺序敏感：行序错位与新增/缺失行都在这里暴露。上游有、eng 没有 = 漏抄，
  // 漏抄就是静默少一个能力，必须补进 presets/eng/agent.cordis.yml。
  const extra = eng.filter((entry) => !upstream.includes(entry))
  const missing = upstream.filter((entry) => !eng.includes(entry))
  assert.deepEqual(missing, [], `eng 缺少上游行，请补进 presets/eng/agent.cordis.yml：\n${missing.join('\n')}`)
  assert.deepEqual(extra, EXTRA_ENG_ROWS, 'eng 相对上游出现了白名单外的行')

  // 嵌套 config 里有意的调参：eng 值只允许映射到声明的上游值。
  const upstreamConfigs = configOfRows(upstreamFile)
  for (const [id, config] of configOfRows(engFile)) {
    const reference = upstreamConfigs.get(id)
    if (reference === undefined) {
      assert.equal(EXTRA_ENG_ROWS.some((entry) => entry.startsWith(`${id} ->`)), true, `eng 多出的行 ${id} 不在白名单`)
      continue
    }
    for (const [key, value] of config) {
      const upstreamValue = reference.get(key)
      if (upstreamValue === value) continue
      // 声明优先：行级（新增或覆盖某个键）在 ROW_OVERRIDES，纯调参在 PRUNER_OVERRIDES。
      const rowOverride = ROW_OVERRIDES.get(id)
      if (rowOverride !== undefined && rowOverride.has(key) && rowOverride.get(key) === upstreamValue) continue
      if (PRUNER_OVERRIDES.has(value) && PRUNER_OVERRIDES.get(value) === upstreamValue) continue
      // 没有匹配声明就是漂移。不得退回 `assert.equal(declared, upstreamValue)`：
      // 新增的键其上游值是 undefined，`undefined === undefined` 会静默通过
      // （2026-09-12 在本 fork 上实测到该盲点），于是"加一行配置"就能骗过自检。
      assert.fail(`${id}.${key} 与上游不同且未声明：eng=${value} upstream=${String(upstreamValue)}`)
    }
  }
})

test('eng 预设引用的每个模块都能在 DSH 里解析到', (t) => {
  const root = dshPackageRoot()
  if (root === undefined) {
    t.skip('本机没有 DSH 安装，跳过模块解析检查')
    return
  }
  const specifiers = normalizedRows(join(ENG_PRESET, 'agent.cordis.yml'))
    .filter((row) => row.startsWith('name:'))
    .map((row) => row.slice('name:'.length).trim().replace(/^'(.*)'$/, '$1'))
  const bare = specifiers.filter((name) => name.startsWith('@deepseek-ai/'))
  assert.equal(bare.length > 20, true, '应解析出全部上游行名')

  const moduleRoot = join(root, 'node_modules')
  const unresolved = bare.filter((name) => {
    const [scope, pkg] = name.split('/')
    // 子路径行（如 `.../list-agents`）只要包在即可，具体子路径由 loader 解析。
    return !existsSync(join(moduleRoot, scope, pkg))
  })
  assert.deepEqual(unresolved, [], `eng 引用了本机 DSH 解析不到的模块：\n${unresolved.join('\n')}`)
})

test('包内 eng 源树渲染出的 bundle 保留全部行清单与自带资产（顺带刷新 bundle）', () => {
  const targetRoot = join(dshHome(), 'local-bundles')
  const result = syncPresetTrees(join(PACKAGE_ROOT, 'presets'), targetRoot)
  assert.deepEqual(result.failed, [], `渲染失败：${JSON.stringify(result.failed)}`)

  const bundleRoot = join(targetRoot, 'dsh-preset-eng')
  const patch = readFileSync(join(bundleRoot, 'preset.patch.yml'), 'utf8')
  const sourceRows = rowIds(readFileSync(join(ENG_PRESET, 'agent.cordis.yml'), 'utf8'))
  const renderedRows = rowIds(patch)
  // 健全性检查：源树被清空或走错目录时下面的断言会「零次通过」。
  assert.equal(sourceRows.length >= 10, true, `eng 源树行数异常偏少：${sourceRows.length}`)
  for (const id of sourceRows) {
    assert.equal(renderedRows.includes(id), true, `渲染结果缺少行 ${id}（跑 node --test 即会刷新 bundle）`)
  }
  // 0.1.7 的 registry 直接挂载 config.plugins，不锚定相对行名：渲染必须已换成绝对 URL。
  assert.equal(/^\s*name:\s*\.\//m.test(patch), false, `渲染结果里仍有相对行名：\n${patch}`)
  assert.equal(existsSync(join(bundleRoot, 'plugins')), true, '自带插件目录未随 bundle 复制')
})

/** 行清单里的顶层 `- id:` 值（含嵌套行，只看 id）。 */
function rowIds(text) {
  return [...text.matchAll(/^\s*- id: (\S+)$/gm)].map((match) => match[1])
}
