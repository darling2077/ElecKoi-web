#!/usr/bin/env node
/**
 * 施加 patches/*.patch 到工作树。
 *
 * 为什么要这一步：我们对上游源码的极少数必要改动写成补丁，而不是直接改文件，
 * 这样 git 树里的上游文件始终与上游一致，`git rebase upstream/main` 预期零冲突。
 *
 * 关键行为：**打不上就失败**。上游一旦改动了我们补丁涉及的那几行，
 * 这里会立刻报警，逼迫人工复核——这正是可更新性所需的那道闸门。
 *
 * 用法：
 *   node scripts/apply-patches.mjs           施加（幂等，已应用的会跳过）
 *   node scripts/apply-patches.mjs --revert  撤销
 *   node scripts/apply-patches.mjs --check   只检查能否施加，不改动
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const patchDir = join(root, 'patches')

function git(args, options = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : undefined
  })
}

/** 缺少 git 时装补丁会全部失败；明确区分这种情况，避免误报成「上游代码已变动」。 */
function assertGitAvailable() {
  try {
    git(['--version'], { quiet: true })
  } catch {
    console.error('找不到 git 可执行文件；`git apply` 是施加补丁的前提。')
    console.error('容器镜像请在构建阶段安装 git（见 docker/Dockerfile 的 builder 阶段）。')
    process.exit(1)
  }
}

function patchFiles() {
  if (!existsSync(patchDir)) return []
  return readdirSync(patchDir).filter((name) => name.endsWith('.patch')).sort()
}

function canApply(file, reverse) {
  try {
    git(['apply', '--check', ...(reverse ? ['--reverse'] : []), file], { quiet: true })
    return true
  } catch {
    return false
  }
}

const revert = process.argv.includes('--revert')
const checkOnly = process.argv.includes('--check')
assertGitAvailable()
const patches = patchFiles()

if (patches.length === 0) {
  console.log('patches/ 下没有补丁，无需施加。')
  process.exit(0)
}

const failures = []
let applied = 0
let skipped = 0

for (const name of patches) {
  const file = join(patchDir, name)

  if (revert) {
    if (canApply(file, true)) {
      if (!checkOnly) git(['apply', '--reverse', file])
      console.log(`已撤销：${name}`)
      applied += 1
    } else {
      console.log(`跳过（未应用）：${name}`)
      skipped += 1
    }
    continue
  }

  // 幂等：已应用过的补丁应能反向校验通过
  if (canApply(file, true) && !canApply(file, false)) {
    console.log(`跳过（已应用）：${name}`)
    skipped += 1
    continue
  }
  if (!canApply(file, false)) {
    failures.push(`${name}：无法施加（上游相关代码已变动，需人工复核并更新补丁）`)
    continue
  }
  if (!checkOnly) git(['apply', file])
  console.log(`${checkOnly ? '可施加' : '已应用'}：${name}`)
  applied += 1
}

console.log(`\n补丁 ${patches.length} 个：处理 ${applied}、跳过 ${skipped}、失败 ${failures.length}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
