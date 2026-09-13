#!/usr/bin/env node
/**
 * 可更新性门禁：保证本仓库对上游始终是「新增为主、极少数改动走补丁」的形态，
 * 使 `git fetch upstream && git rebase upstream/main` 能一条线完成。
 *
 * 规则：
 *   1. 上游已有文件不得被删除。
 *   2. 上游文件只有两类合法改动：
 *        a. package.json —— 且只允许新增 script，其余字段必须与基线逐字一致；
 *        b. patches/*.patch 覆盖的文件 —— 且当前改动量必须与补丁完全一致（不得夹带私货）。
 *   3. 新增文件必须落在白名单目录内。
 *
 * 用法：node scripts/check-upstream-diff.mjs [baseline-ref]
 *       baseline 缺省取 ELECKOI_UPSTREAM_REF，再缺省依次尝试 upstream/main、v0.1.0。
 * 退出码非 0 表示违反约束。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * 允许新增的路径前缀（我们自己的代码与部署物）。
 *
 * 根目录的 CLAUDE.md 是刻意的例外：它是 AI 编码助手**自动读取**的约定文件，
 * 放在根目录才会被发现，放进 docs/ 就失去意义。
 *
 * 为什么不用更通用的 AGENTS.md：上游 .gitignore 第 40 行把 `/AGENTS.md` 有意排除
 * （作者当本地材料用），而我们不想为此去改上游的 .gitignore。
 * CLAUDE.md 同为主流约定且未被忽略，是这两个约束下的最优解。
 */
const ALLOWED_ADDITIONS = [
  'src/web/',
  'docker/',
  'patches/',
  'docs/webui/',
  'scripts/check-upstream-diff.mjs',
  'scripts/apply-patches.mjs',
  '.dockerignore',
  'CLAUDE.md'
]

/**
 * 允许直接修改的上游文件。
 *
 * - package.json：只允许新增 script，其余字段逐字一致（下方 checkPackageJson 强制）。
 * - README.md / NOTICE：fork 声明与「对应源码」地址必须写在这两个文件里
 *   （AGPL-3.0 §5(a) 要求醒目标注修改、§13 要求指向本版本的源码）。
 *   两者都是纯文档，上游改动导致冲突时人工合并即可，不影响可构建性。
 */
const ALLOWED_MODIFICATIONS = new Set(['package.json', 'README.md', 'NOTICE'])

function git(args, options = {}) {
  // core.quotePath=false：否则中文路径会被转义成八进制，白名单比对失效。
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : undefined
  })
}

/**
 * 基线 = 我们与上游最后一次同步的提交。
 * 优先用 upstream/main（跟随上游最新），其次退到本地 tag。
 */
function resolveBaseline() {
  const explicit = process.argv[2] ?? process.env.ELECKOI_UPSTREAM_REF
  if (explicit) return explicit
  for (const candidate of ['upstream/main', 'v0.1.0']) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { quiet: true })
      return candidate
    } catch {
      // 试下一个
    }
  }
  throw new Error('找不到可用的上游基线引用（试过 upstream/main 与 v0.1.0）。')
}

/** 解析 patches/*.patch，得到「被补丁覆盖的文件 → 期望的增删行数」。 */
function patchedFiles() {
  const dir = join(root, 'patches')
  if (!existsSync(dir)) return new Map()
  const expected = new Map()
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.patch'))) {
    const content = readFileSync(join(dir, name), 'utf8')
    let current = null
    for (const line of content.split('\n')) {
      if (line.startsWith('+++ b/')) {
        current = line.slice('+++ b/'.length).trim()
        if (!expected.has(current)) expected.set(current, { added: 0, removed: 0, patches: [] })
        expected.get(current).patches.push(name)
        continue
      }
      if (current === null) continue
      const entry = expected.get(current)
      if (line.startsWith('+') && !line.startsWith('+++')) entry.added += 1
      else if (line.startsWith('-') && !line.startsWith('---')) entry.removed += 1
    }
  }
  return expected
}

function listChangedTracked() {
  return git(['diff', '--name-status', baseline])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/)
      return { status, path: rest.join(' ') }
    })
}

function listUntracked() {
  return git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function isAllowedAddition(path) {
  return ALLOWED_ADDITIONS.some((prefix) => path === prefix || path.startsWith(prefix))
}

/** package.json 只允许新增 script，其余字段必须与基线逐字一致。 */
function checkPackageJson(failures) {
  let baselineRaw
  try {
    baselineRaw = git(['show', `${baseline}:package.json`])
  } catch {
    failures.push(`无法读取基线 ${baseline} 的 package.json，跳过字段比对。`)
    return undefined
  }
  const before = JSON.parse(baselineRaw)
  const after = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === 'scripts') continue
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      failures.push(`package.json 的 "${field}" 与基线不一致；除 scripts 外不得改动上游声明。`)
    }
  }

  const beforeScripts = before.scripts ?? {}
  const afterScripts = after.scripts ?? {}
  for (const [name, command] of Object.entries(beforeScripts)) {
    if (afterScripts[name] !== command) failures.push(`package.json 改动了上游既有 script："${name}"。`)
  }
  return {
    added: Object.keys(afterScripts).filter((name) => !(name in beforeScripts)),
    removed: Object.keys(beforeScripts).filter((name) => !(name in afterScripts))
  }
}

/** 补丁覆盖的文件：改动量必须与补丁期望完全一致。 */
function checkPatchedFile(path, expected, failures, notes) {
  const numstat = git(['diff', '--numstat', baseline, '--', path]).trim()
  if (numstat === '') {
    notes.push(`${path}：补丁尚未施加（构建前由 apply-patches 施加）`)
    return
  }
  const [addedRaw, removedRaw] = numstat.split(/\s+/)
  const added = Number(addedRaw)
  const removed = Number(removedRaw)
  if (added !== expected.added || removed !== expected.removed) {
    failures.push(
      `${path} 的改动量与补丁不符（补丁 +${expected.added}/-${expected.removed}，实际 +${added}/-${removed}）；` +
      `请把改动写进 patches/，不要直接改上游文件。`
    )
    return
  }
  notes.push(`${path}：已施加补丁 ${expected.patches.join(', ')}（+${added}/-${removed}）`)
}

// ── 主流程 ──
const baseline = resolveBaseline()
const patches = patchedFiles()
const failures = []
const notes = []

const changed = listChangedTracked()
const deleted = changed.filter((entry) => entry.status.startsWith('D'))
const modified = changed.filter((entry) => !entry.status.startsWith('D') && !entry.status.startsWith('A'))

for (const entry of deleted) {
  failures.push(`删除了上游文件：${entry.path}（不允许；改用 patches/ 承载改动）`)
}
for (const entry of modified) {
  const patched = patches.get(entry.path)
  if (patched) {
    checkPatchedFile(entry.path, patched, failures, notes)
    continue
  }
  if (!ALLOWED_MODIFICATIONS.has(entry.path)) {
    failures.push(`修改了上游文件：${entry.path}（不允许；改用 patches/ 承载改动）`)
  }
}

const addedTracked = changed.filter((entry) => entry.status.startsWith('A')).map((entry) => entry.path)
const untracked = listUntracked()
for (const path of [...addedTracked, ...untracked]) {
  if (!isAllowedAddition(path) && !ALLOWED_MODIFICATIONS.has(path)) {
    failures.push(`新增文件不在白名单内：${path}（允许的前缀：${ALLOWED_ADDITIONS.join(', ')}）`)
  }
}

const scripts = checkPackageJson(failures)
if (scripts) {
  notes.push(`package.json 新增 script：${scripts.added.length > 0 ? scripts.added.join(', ') : '（无）'}`)
  if (scripts.removed.length > 0) failures.push(`package.json 删除了 script：${scripts.removed.join(', ')}`)
}

// ── 输出 ──
console.log(`基线：${baseline}（${git(['rev-parse', '--short', baseline]).trim()}）`)
console.log(`改动：上游文件修改 ${modified.length} 个、删除 ${deleted.length} 个；新增 ${addedTracked.length + untracked.length} 个；补丁 ${patches.size} 个文件`)
for (const note of notes) console.log(`· ${note}`)

if (failures.length > 0) {
  console.error('\n可更新性门禁未通过：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('\n可更新性门禁通过：对上游仅有新增与受控补丁，rebase 预期零冲突。')
