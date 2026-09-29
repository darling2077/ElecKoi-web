#!/usr/bin/env node
/**
 * WebUI 全量验收的运行器。
 *
 * 为什么不直接在 package.json 里写 `pnpm a && pnpm b && …`：
 *   上游 v0.2.0 把 `pnpm@11.7.0` 当成依赖装了进来，于是 `node_modules/.bin/pnpm` 就是 11.7.0；
 *   而**脚本内**的嵌套 `pnpm` 会优先命中它（pnpm 跑脚本时把 node_modules/.bin 放在 PATH 前面），
 *   它的版本自检又与本仓库 `packageManager: pnpm@10.32.1` 冲突，直接 ERROR 退出：
 *     [ERROR] This project is configured to use 10.32.1 of pnpm. Your current pnpm is v11.7.0
 *   这属于上游打包问题（同样的坑也在上游自己的 postinstall / predev / build 里），
 *   我们不改上游文件，所以在这里用**调用本脚本的那个 pnpm**（npm_execpath）跑各组。
 *
 * 顺带好处：每组一条横幅，失败即停并给出明确的退出码。
 */

import { spawn } from 'node:child_process'

/** 顺序与原先 package.json 里的链式调用一致：先静态检查，再按由轻到重的验收组。 */
const groups = [
  'webui:typecheck',
  'check:upstream-diff',
  'webui:poc',
  'webui:agent',
  'webui:media',
  'webui:avatar',
  'webui:multitenant',
  'webui:admin',
  'webui:cardisolation',
  'webui:csp',
  'webui:cardimages',
  'webui:uploadlimit',
  'webui:chrome',
  'webui:appearance',
  'webui:proxy',
  'webui:keys',
  'webui:render',
  'webui:mobile',
  'webui:quota',
  'webui:backup'
]

/** 调用本脚本的 pnpm（pnpm 会设 npm_execpath）；缺省退回 PATH 里的 pnpm。 */
const execPath = process.env.npm_execpath
const runner = execPath === undefined ? 'pnpm' : process.execPath
const baseArgs = execPath === undefined ? [] : [execPath]

function run(group) {
  return new Promise((resolve) => {
    const child = spawn(runner, [...baseArgs, group], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

for (const group of groups) {
  console.log(`\n\u001b[36m── ${group} ─────────────────────────────────────────\u001b[0m`)
  const code = await run(group)
  if (code !== 0) {
    console.error(`\n\u001b[31m验收中断：${group} 失败（退出码 ${code}）\u001b[0m`)
    process.exit(code)
  }
}
console.log('\n\u001b[32m全量验收通过。\u001b[0m')
