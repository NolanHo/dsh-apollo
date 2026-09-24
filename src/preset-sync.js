/**
 * 预设物化：把包内 `presets/` 下的每个预设目录渲染成 0.1.7 的**声明 bundle**，
 * 幂等同步进 harness home 的 `local-bundles/`，并退役插件过去写下的旧目录。
 *
 * 为什么需要同步：0.1.7 把用户 preset 的载体从“`<dshHome>/.agent-presets/<id>/`
 * 目录”改成“声明 bundle”——一个包在 `dsh.bundle.patch` 里给出 patch 文件，patch
 * 里用 `@deepseek-ai/dsh-agent-preset` 行声明 `{ id, name, description, order,
 * plugins }`。宿主不再扫描 `.agent-presets`，因此插件包自带的预设只能在上电时
 * 渲染成 bundle，再由 profile 侧选中（`plugin_manager` 的 `install_bundle`，一次
 * 性动作；选中状态落在 profile 的 `dsh.profile.bundles`）。
 *
 * 两个渲染规则来自 0.1.7 的实际行为：
 * - **行的 `name` 必须是字符串**。loader 只对行内 `config` 求值 `!!js`，不对
 *   `name` 求值；registry 又直接挂载 `config.plugins`，不经过会锚定相对名的
 *   patch 读取路径。所以预设自带的 `./plugins/x/index.js` 必须在此渲染成
 *   `file://` 绝对 URL，否则该行要么拿不到 fiber（“never started”），要么在校验
 *   时报 “names no plugin”。
 * - **自带资产跟着 bundle 走**。`../plugins/`、`skills/` 等按 patch 文件所在
 *   目录解析（宿主为定义提供的 `baseUrl`），因此资产复制到 bundle 根下，源侧的
 *   相对引用（含 `new URL('skills/', baseUrl)`）继续成立。
 *
 * 同步按目录进行且幂等：目标树与渲染结果逐字节相同时跳过（`current`）。插件不
 * 拥有的目录绝不触碰。`retire` 列出插件曾经拥有、如今不再发布的预设 id；退役
 * 旧发现根（`.agent-presets/<id>`）只针对插件当前发布的 id。
 *
 * 零依赖（只用 node 内置模块），宿主插件因此可以从任意位置加载而无需
 * bare import 解析。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/** 渲染产物：bundle 清单文件名。 */
const MANIFEST = 'package.json'
/** 渲染产物：声明 patch 文件名。 */
const PATCH = 'preset.patch.yml'
/** 旧发现根里的 id 目录名，退役时按 `<legacyRoot>/<id>` 删除。 */
const LEGACY_ROOT = '.agent-presets'

/**
 * 解析 DSH home 目录：DSH_HOME 环境变量优先（`~` 展开、相对路径基于进程
 * CWD），缺省 `<home>/.dsh`。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @param home - 平台 home 目录回退（测试注入点）。
 * @returns 绝对 DSH home 路径。
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const trimmed = raw.trim()
    const expanded = trimmed === '~' ? home
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(home, trimmed.slice(2))
      : trimmed
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** 从当前环境解析 DSH home 目录。 */
export function dshHome() {
  return resolveDshHome()
}

/**
 * 一次同步运行的分类结果：
 * - `synced`：本次写入的预设 id；
 * - `current`：已与渲染结果一致的预设 id；
 * - `failed`：渲染或写入失败的预设 id 及原因；
 * - `retired`：本次删除的过期预设 id（新根与旧根合计）。
 * @typedef {Object} SyncResult
 * @property {string[]} synced
 * @property {string[]} current
 * @property {{id: string, error: string}[]} failed
 * @property {string[]} retired
 */

/**
 * 渲染一个预设目录所需的全部文件（不含自带资产）：
 * `package.json` 声明 bundle，`preset.patch.yml` 声明 preset 行。
 * @param sourceDir - 包内预设目录（含 `agent.cordis.yml`、可选 `preset.yml`）。
 * @param targetDir - 渲染目标 bundle 目录（决定自带资产与 `name` 的绝对 URL）。
 * @param order - 列表顺序（`preset.yml` 未声明 `order` 时的来源）。
 * @returns 相对路径到文件内容的映射。
 */
export function renderBundleFiles(sourceDir, targetDir, order) {
  const id = basename(sourceDir)
  const meta = readPresetMeta(sourceDir)
  const composition = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')
  const rows = anchorRelativeNames(entryBlock(composition), targetDir)
  const manifest = {
    name: `dsh-preset-${id}`,
    version: '0.1.0',
    private: true,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    dsh: { bundle: { patch: `./${PATCH}` } },
  }
  const patch = [
    `# ${id} agent preset 的声明行，由 dsh-apollo 从 presets/${id}/ 渲染。`,
    '# 0.1.7 起宿主读取声明 bundle，不再扫描 <dshHome>/.agent-presets。行清单来自',
    '# agent.cordis.yml；自带资产随 bundle 复制，相对引用按本文件所在目录解析。',
    '- insert:',
    `    - id: preset-${id}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${id}`,
    `        name: ${JSON.stringify(meta.name ?? id)}`,
    `        description: ${JSON.stringify(meta.description ?? '')}`,
    `        order: ${meta.order ?? order}`,
    '        plugins:',
    indent(rows, 10),
    '',
  ].join('\n')
  return new Map([
    [MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`],
    [PATCH, patch],
  ])
}

/** 读取 `preset.yml` 的顶层 `name`/`description`/`order`（扁平 `key: value`）。 */
function readPresetMeta(sourceDir) {
  const path = join(sourceDir, 'preset.yml')
  if (!existsSync(path)) return {}
  const meta = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^(name|description|order):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, key, raw] = match
    meta[key] = key === 'order' ? Number(raw) : raw
  }
  return meta
}

/** 去掉 `agent.cordis.yml` 顶部的说明注释块，返回顶层行清单。 */
function entryBlock(composition) {
  const lines = composition.split('\n')
  let index = 0
  while (index < lines.length && (lines[index].trim().startsWith('#') || lines[index].trim() === '')) index += 1
  return lines.slice(index)
}

/**
 * 把行清单里的相对插件名改写成 `file://` 绝对 URL。
 * @param rows - 行清单。
 * @param targetDir - bundle 根（自带资产所在目录）。
 * @returns 改写后的行清单。
 */
function anchorRelativeNames(rows, targetDir) {
  return rows.map((line) => {
    const match = /^(\s*)name:\s*((?:\.\/)[^\s#]+)\s*$/.exec(line)
    if (match === null) return line
    const [, pad, specifier] = match
    return `${pad}name: file://${join(targetDir, specifier.slice(2))}`
  })
}

/** 按层缩进行清单（空行不带空白）。 */
function indent(rows, spaces) {
  const pad = ' '.repeat(spaces)
  return rows.map((line) => (line.trim() === '' ? '' : pad + line)).join('\n')
}

/** `root` 下的全部文件（绝对路径，深度优先）。 */
function filesUnder(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(root)
  return out
}

/** 文件身份即内容：大小不同即判不同，否则逐字节比较。不用 mtime 快路径——复制会刷新 mtime，不作判据。 */
function sameFile(a, b) {
  const sa = statSync(a)
  const sb = statSync(b)
  if (sa.size !== sb.size) return false
  return readFileSync(a).equals(readFileSync(b))
}

/** 复制 `sourceDir` 整棵树到 `targetDir`（先建目录，按条目逐项复制）。 */
function copyTreeSync(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    if (statSync(source).isDirectory()) copyTreeSync(source, target)
    else copyFileSync(source, target)
  }
}

/** 删除 `root` 下不在 `keep`（相对路径集合）中的文件，再清理因此空出的目录。 */
function pruneExtras(root, keep) {
  const parents = new Set()
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file))
      rmSync(file, { force: true })
    }
  }
  for (const start of parents) {
    let dir = start
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true })
        dir = dirname(dir)
      } else {
        dir = undefined
      }
    }
  }
}

/** 幂等同步一棵已渲染完整的树：逐字节一致时跳过，否则先 prune 再整体复制。 */
function syncTree(sourceDir, targetDir) {
  const sourceFiles = filesUnder(sourceDir)
  const sourceSet = new Set(sourceFiles.map((file) => relative(sourceDir, file)))
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir)
    return 'synced'
  }
  let dirty = false
  for (const file of sourceFiles) {
    const dest = join(targetDir, relative(sourceDir, file))
    if (!existsSync(dest) || !sameFile(file, dest)) {
      dirty = true
      break
    }
  }
  if (!dirty) {
    for (const file of filesUnder(targetDir)) {
      if (!sourceSet.has(relative(targetDir, file))) {
        dirty = true
        break
      }
    }
  }
  if (!dirty) return 'current'
  // 必须先 prune 再 copy：目标侧可能残留与源文件同名的多余目录（或反之），
  // 不先清掉类型冲突项，copyFileSync 会以 EISDIR/ENOTDIR 失败；prune 会连带
  // 清掉因此空出的目录。copy 之后不再二次 prune——目标内容由源树决定，
  // 同输入的二次 prune 必然无操作。
  pruneExtras(targetDir, sourceSet)
  copyTreeSync(sourceDir, targetDir)
  return 'synced'
}

/**
 * 把 `sourceDir/<id>` 渲染成 bundle 并幂等同步到 `targetDir/<id>`。
 * @param sourceDir - 包内预设目录。
 * @param targetDir - 目标 bundle 目录。
 * @param options - `order`（`preset.yml` 无 `order` 时的列表顺序）。
 * @returns 'synced' 或 'current'。
 */
export function syncOnePreset(sourceDir, targetDir, options = {}) {
  const staged = mkdtempSync(join(tmpdir(), 'dsh-apollo-bundle-'))
  try {
    for (const [name, content] of renderBundleFiles(sourceDir, targetDir, options.order ?? 10)) {
      writeFileSync(join(staged, name), content)
    }
    for (const entry of readdirSync(sourceDir)) {
      if (entry === 'agent.cordis.yml' || entry === 'preset.yml') continue
      const source = join(sourceDir, entry)
      if (statSync(source).isDirectory()) copyTreeSync(source, join(staged, entry))
      else copyFileSync(source, join(staged, entry))
    }
    return syncTree(staged, targetDir)
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

/**
 * 同步 `sourceRoot` 下每个预设目录到 `targetRoot`，并按 `retire` 删除插件
 * 不再发布的预设。只操作插件拥有的预设 id，其他目录不动。
 * @param sourceRoot - 包内预设树（本包的 `presets/`）。
 * @param targetRoot - bundle 根（如 `<dshHome>/local-bundles`）。
 * @param retire - 源树缺失时应从目标根删除的预设 id 列表。
 * @returns 分类结果。
 */
export function syncPresetTrees(sourceRoot, targetRoot, retire = []) {
  const result = { synced: [], current: [], failed: [], retired: [] }
  mkdirSync(targetRoot, { recursive: true })
  let order = 0
  if (existsSync(sourceRoot)) {
    for (const entry of readdirSync(sourceRoot).sort()) {
      const source = join(sourceRoot, entry)
      if (!statSync(source).isDirectory()) continue
      const id = basename(source)
      const bundle = `dsh-preset-${id}`
      try {
        const outcome = syncOnePreset(source, join(targetRoot, bundle), { order: 10 + order })
        order += 1
        ;(outcome === 'synced' ? result.synced : result.current).push(id)
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  for (const id of retire) {
    if (existsSync(join(sourceRoot, id))) continue
    const stale = join(targetRoot, `dsh-preset-${id}`)
    if (existsSync(stale) && statSync(stale).isDirectory()) {
      rmSync(stale, { recursive: true, force: true })
      result.retired.push(id)
    }
  }
  return result
}

/**
 * 退役旧发现根里的预设目录。
 *
 * 0.1.7 之前插件把预设树写进 `<dshHome>/.agent-presets/<id>/`；该根已无人读取，
 * 留着只会误导定位。只删插件当前发布的 id（源树缺失的 id 交给 `retire`），
 * 用户自建的其他预设不动。
 * @param sourceRoot - 包内预设树。
 * @param legacyRoot - 旧发现根（如 `<dshHome>/.agent-presets`）。
 * @returns 本次删除的预设 id。
 */
export function retireLegacyPresets(sourceRoot, legacyRoot) {
  const retired = []
  if (!existsSync(sourceRoot) || !existsSync(legacyRoot)) return retired
  for (const entry of readdirSync(sourceRoot)) {
    const source = join(sourceRoot, entry)
    if (!statSync(source).isDirectory()) continue
    const stale = join(legacyRoot, basename(source))
    if (existsSync(stale) && statSync(stale).isDirectory()) {
      rmSync(stale, { recursive: true, force: true })
      retired.push(basename(source))
    }
  }
  return retired
}

export { LEGACY_ROOT }
