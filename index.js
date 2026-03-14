// 适配V3 Yunzai，将index.js移至app/index.js
import { currentVersion, isV3 } from "./components/Changelog.js"
import Data from "./components/Data.js"
import fs from 'fs'
import path from 'path'

if (!global.segment) {
  global.segment = (await import("oicq")).segment
}


export * from "./apps/index.js"
let index = {
  atlas: {},
}
if (isV3) {
  Bot.logger = logger
  index = await Data.importModule("/plugins/xiaoyao-cvs-plugin/adapter", "index.js")
}

export const atlas = index.atlas || {}

Bot.logger.info(`---------^_^---------`)
Bot.logger.info(`图鉴插件${currentVersion}初始化~`)

async function copyCfgToConfig() {
  const srcPath = path.join(process.cwd(), 'plugins/xiaoyao-cvs-plugin/components/cfg.json')
  const destDir = path.join(process.cwd(), 'plugins/xiaoyao-cvs-plugin/config')
  const destPath = path.join(destDir, 'cfg.json')
  if (fs.existsSync(destPath)) {
    Bot.logger.info(`[图鉴插件] config/cfg.json已存在，跳过复制操作`)
    return
  }
  if (fs.existsSync(srcPath)) {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
      Bot.logger.info(`[图鉴插件] 创建config目录: ${destDir}`)
    }

    fs.copyFileSync(srcPath, destPath)
    Bot.logger.info(`[图鉴插件] 已将components/cfg.json复制到config目录`)
  } else {
    Bot.logger.info(`[图鉴插件] 未找到components/cfg.json，跳过复制`)
  }
}

await copyCfgToConfig()

setTimeout(async function () {
  let msgStr = await redis.get("xiaoyao:restart-msg")
  let relpyPrivate = async function () {}
  if (!isV3) {
    let common = await Data.importModule("/lib", "common.js")
    if (common && common.default && common.default.relpyPrivate) {
      relpyPrivate = common.default.relpyPrivate
    }
  }
  if (msgStr) {
    let msg = JSON.parse(msgStr)
    await relpyPrivate(msg.qq, msg.msg)
    await redis.del("xiaoyao:restart-msg")
    let msgs = [`当前图鉴版本: ${currentVersion}`, "您可使用 #图鉴版本 命令查看更新信息"]
    await relpyPrivate(msg.qq, msgs.join("\n"))
  }
}, 1000)