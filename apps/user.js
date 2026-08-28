import utils from "../model/mys/utils.js"
import { Cfg, Data } from "../components/index.js"
import moment from "moment"
import Common from "../components/Common.js"
import { isV3 } from "../components/Changelog.js"
import gsCfg from "../model/gsCfg.js"
import fs from "fs"
import YAML from "yaml"
import User from "../model/user.js"
import { SR_GACHA_COMMAND, SR_GACHA_COOKIE_COMMAND, SR_GACHA_REIMPORT_PROMPT, SrGachaSummary, formatSrSummary, formatSrGachaFailure, getSrGachaCookieFile, isSuccessfulReply, readSrGachaCookie, saveSrGachaCookie, extractSrGachaCookie } from "../model/srGachaSummary.js"
import { hasPlaceholder, syncSummaryToGenshin } from "../model/srGachaBridge.js"

export const rule = {
  userInfo: {
    reg: "^#*(ck|stoken|cookie|cookies|签到)查询$",
    describe: "用户个人信息查询",
  },
  gclog: {
    // #* 只吃 #，星铁前缀会被核心标准化成「#星铁」，故显式允许
    reg: "^(?:#*|#星铁)(强制)?(更新|获取|导出)抽卡记录$",
    describe: "更新抽卡记录",
  },
  srGclog: {
    reg: SR_GACHA_COMMAND,
    describe: "更新崩铁五星跃迁摘要",
  },
  srGachaCookie: {
    reg: SR_GACHA_COOKIE_COMMAND,
    describe: "绑定崩铁跃迁 Cookie",
  },
  srGachaExportGuard: {
    // 存在占位条目时禁止导出，避免把不完整数据写进 UIGF 文件
    reg: "^#?(原神|星铁)?(强制)?导出记录(json)?(v2|v4)?$",
    describe: "崩铁占位记录导出保护",
  },
  gcPaylog: {
    //避免指令冲突
    reg: "^#*(刷新|获取|导出)(充值|氪金)记录$",
    describe: "刷新充值记录",
  },
  mytoken: {
    reg: "^#*我的(stoken|云ck)$",
    describe: "查询绑定数据",
  },
  bindStoken: {
    reg: "^(.*)stoken=(.*)$",
    describe: "绑定stoken",
  },
  bindLogin_ticket: {
    reg: "^(.*)login_ticket=(.*)$",
    describe: "绑定ck自动获取sk",
  },
  cloudToken: {
    reg: "^(.*)ct(.*)$",
    describe: "云原神签到token获取",
  },
  delSign: {
    reg: "^#*删除(我的)*((stoken|sk)|(云原神|云ck))$",
    describe: "删除云原神、stoken数据",
  },
  updCookie: {
    reg: "^#*(刷新|更新|获取)(ck|cookie)$",
    describe: "刷新cookie",
  },
}
const _path = process.cwd()
const YamlDataUrl = `${_path}/plugins/xiaoyao-cvs-plugin/data/yaml`
const yunpath = `${_path}/plugins/xiaoyao-cvs-plugin/data/yunToken/`
export async function userInfo(e, { render }) {
  let user = new User(e)
  e.reply("正在获取角色信息请稍等...")
  let sumData = await user.getCkData()
  let week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
  let day = moment(new Date()).format("yyyy年MM月DD日 HH:mm") + " " + week[new Date().getDay()]
  if (Object.keys(sumData).length == 0) {
    e.reply("未获取到角色信息~")
    return true
  }
  let ck = ""
  if (e.cookie) {
    ck = await utils.getCookieMap(e.cookie)
    ck = ck?.get("ltuid")
  }
  return await Common.render(
    `user/userInfo`,
    {
      uid: e.user_id,
      ltuid: ck || e.user_id,
      save_id: e.user_id,
      day,
      sumData,
    },
    {
      e,
      render,
      scale: 1.2,
    },
  )
}
let configData = gsCfg.getfileYaml(`${_path}/plugins/xiaoyao-cvs-plugin/config/`, "config")
export async function gcPaylog(e) {
  let user = new User(e)
  await user.cookie(e)
  let redis_Data = await redis.get(`xiaoyao:gcPaylog:${e.user_id}`)
  if (redis_Data) {
    let time = redis_Data * 1 - Math.floor(Date.now() / 1000)
    e.reply(`请求过快,请${time}秒后重试...`)
    return true
  }
  let isGet = /导出|获取/.test(e.msg)
  if (!e.isPrivate && isGet) {
    e.reply("请私聊发送")
    return true
  }
  let authkey = await getAuthKey(e, user, { auth_appid: "csc" })
  if (!authkey) {
    return true
  }
  let url = `https://webstatic.mihoyo.com/event/user-game-search/hk4e/index.html?selfquery_type=3&lang=zh-cn&sign_type=2&auth_appid=csc&authkey_ver=1&authkey=${encodeURIComponent(authkey)}&game_biz=hk4e_cn&app_client=bbs&type=3&size=6&region=${e.region}&end_id=`
  e.msg = url
  // e.reply(e.msg)
  let sendMsg = []
  e.reply("充值记录获取中请稍等...")
  e._reply = e.reply
  e.reply = msg => {
    sendMsg.push(msg)
  }
  if (isGet) {
    sendMsg = [...sendMsg, ...[1, `uid:${e.uid}`, e.msg]]
  } else {
    let time = (configData.gclogEx || 5) * 60
    redis.set(`xiaoyao:gcPaylog:${e.user_id}`, Math.floor(Date.now() / 1000) + time, {
      //数据写入缓存避免重复请求
      EX: time,
    })
    if (isV3) {
      let { payLog } = await import(`file://${_path}/plugins/genshin/apps/payLog.js`)
      let pl = new payLog()
      e.isGroup = false
      pl.e = e
      await pl.getAuthKey(e)
      e._reply(sendMsg[1])
      return true
      // await (new payLog()).payLog(e)
    } else {
      e._reply(`V2暂不支持`)
      return false
    }
  }
  await utils.replyMake(e, sendMsg, 1)
  return true
}
export async function gclog(e) {
  let user = new User(e)
  if (e.isSr) {
    // 崩铁没有可用的 authkey 链路，更新走徽章摘要；导出复用 genshin 的 UIGF 导出
    if (!/导出|获取/.test(e.msg)) return await srGclog(e)
    if (await srGachaExportGuard(e)) return true
    if (e.isGroup && !e.msg.includes("强制")) {
      e.reply("建议私聊(需加好友)导出，若你确认要在此导出，请发送【*强制导出抽卡记录】", false, { at: true })
      return true
    }
    try {
      const ExportLog = (await import(`file://${_path}/plugins/genshin/model/exportLog.js`)).default
      await new ExportLog(e).exportJson()
    } catch (error) {
      logger.error(`[崩铁抽卡记录导出] ${error.message}`)
      e.reply(`崩铁抽卡记录导出失败：${error.message}`)
    }
    return true
  }
  await user.cookie(e)
  let redis_Data = await redis.get(`xiaoyao:gclog:${e.user_id}`)
  if (redis_Data) {
    let time = redis_Data * 1 - Math.floor(Date.now() / 1000)
    e.reply(`请求过快,请${time}秒后重试...`)
    return true
  }
  let isGet = /导出|获取/.test(e.msg)
  if (!e.isPrivate && isGet) {
    e.reply("请私聊发送")
    return true
  }
  let authkey = await getAuthKey(e, user)
  if (!authkey) {
    return true
  }
  let url = `https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?authkey_ver=1&sign_type=2&auth_appid=webview_gacha&init_type=301&gacha_id=fecafa7b6560db5f3182222395d88aaa6aaac1bc&timestamp=${Math.floor(Date.now() / 1000)}&lang=zh-cn&device_type=mobile&plat_type=ios&region=${e.region}&authkey=${encodeURIComponent(authkey)}&game_biz=hk4e_cn&gacha_type=301&page=1&size=5&end_id=0`
  e.msg = url
  // e.reply(e.msg)
  let sendMsg = []
  e.reply("抽卡记录获取中请稍等...")
  e._reply = e.reply
  e.reply = msg => {
    sendMsg.push(msg)
  }
  if (isGet) {
    sendMsg = [...sendMsg, ...[1, `uid:${e.uid}`, e.msg]]
  } else {
    if (isV3) {
      let gclog = (await import(`file://${_path}/plugins/genshin/model/gachaLog.js`)).default
      await new gclog(e).logUrl()
    } else {
      let { bing } = await import(`file://${_path}/lib/app/gachaLog.js`)
      e.isPrivate = true
      await bing(e)
    }
  }
  await utils.replyMake(e, sendMsg, 1)
  let time = (configData.gclogEx || 5) * 60
  redis.set(`xiaoyao:gclog:${e.user_id}`, Math.floor(Date.now() / 1000) + time, {
    //数据写入缓存避免重复请求
    EX: time,
  })
  return true
}

export async function srGclog(e) {
  const redisKey = `xiaoyao:srGclog:${e.user_id}`
  const redisData = await redis.get(redisKey)
  if (redisData) {
    const time = redisData * 1 - Math.floor(Date.now() / 1000)
    e.reply(`请求过快,请${time}秒后重试...`)
    return true
  }
  if (!e.user?.getUid || !e.user?.getMysUser) {
    e.reply("当前运行环境不支持读取崩铁账号，请更新云崽核心")
    return true
  }
  const uid = e.user.getUid("sr")
  const mysUser = e.user.getMysUser("sr")
  if (!uid) {
    e.reply("未找到已绑定的崩铁 UID，请先绑定崩铁账号")
    return true
  }
  const candidateCookies = [readSrGachaCookie(getSrGachaCookieFile(e.user_id)), e.cookie]
  const user = new User(e)
  try {
    const cookieData = await user.getCookie(e)
    candidateCookies.push(cookieData?.cookie, e.cookie)
  } catch {}
  candidateCookies.push(mysUser?.ck)
  const cookie = candidateCookies.find(value => {
    try {
      new SrGachaSummary({ uid, cookie: value })
      return true
    } catch {
      return false
    }
  })
  if (!uid || !cookie) {
    e.reply(`未找到可用的崩铁米游社 Cookie。需要主 Cookie 中包含账号、登录票据和 mid 字段，${SR_GACHA_REIMPORT_PROMPT}`)
    return true
  }
  e.reply("崩铁五星跃迁摘要获取中，请稍等...")
  try {
    const result = await new SrGachaSummary({ uid, cookie }).update()
    const count = Object.values(result.pools).reduce((sum, pool) => sum + pool.records.length, 0)
    const pity = Object.values(result.pools).filter(pool => pool.pity).map(pool => `${pool.name}${pool.pity.gacha_count}抽`).join("、")
    const detail = formatSrSummary(result)
    let bridgeNote = ""
    try {
      const stats = syncSummaryToGenshin({ userId: e.user_id, uid, pools: result.pools })
      const notes = []
      if (stats.pools) {
        notes.push(`已向抽卡记录写入 ${stats.five} 条五星、${stats.placeholder} 条占位（占位仅补总抽数，不计入四星统计）`)
      } else if (!stats.errors.length) {
        notes.push("抽卡记录已由游戏内链接导入的完整数据覆盖，本次无需写入")
      }
      if (stats.skipped) notes.push(`${stats.skipped} 条五星已有完整逐抽记录，跳过`)
      for (const item of stats.boundary) {
        const names = item.items.map(row => `${row.name}(${row.skippedDraw}抽)`).join("、")
        notes.push(`${names} 的垫抽跨入已导入区间，未补占位以避免重复计数`)
      }
      for (const item of stats.shortfall) {
        const names = item.items.map(row => `${row.name} 缺 ${row.need - row.got}`).join("、")
        notes.push(`池 ${item.type} 占位空间不足：${names}`)
      }
      for (const item of stats.errors) notes.push(`池 ${item.type} 同步失败：${item.message}`)
      if (notes.length) bridgeNote = `\n${notes.join("；")}。`
      if (stats.pools) bridgeNote += `可用 ${e.isSr ? "*" : "#"}抽卡记录 查看。`
    } catch (error) {
      logger.error(`[崩铁跃迁摘要] 同步抽卡记录失败：${error.message}`)
      bridgeNote = `\n同步到抽卡记录失败：${error.message}`
    }
    const successMessage = `崩铁跃迁摘要更新完成，新增五星 ${result.added} 条，当前共 ${count} 条。${pity ? `当前垫抽：${pity}。` : ""}\n${detail}\n仅包含五星记录和当前垫抽摘要，不是完整逐抽历史，不含四星记录。${bridgeNote}`
    const replyResult = await e.reply(successMessage)
    if (!isSuccessfulReply(replyResult)) return true
    const time = (configData.gclogEx || 5) * 60
    await redis.set(redisKey, Math.floor(Date.now() / 1000) + time, { EX: time })
  } catch (error) {
    logger.error(`[崩铁跃迁摘要] ${error.message}`)
    e.reply(formatSrGachaFailure(error))
  }
  return true
}

export async function srGachaCookie(e) {
  if (!e.isPrivate) {
    e.reply("为保护 Cookie 安全，请私聊发送【*绑定跃迁Cookie 米游社Cookie】")
    return true
  }
  if (!e.user?.getUid) {
    e.reply("当前运行环境不支持读取崩铁 UID，请更新云崽核心")
    return true
  }
  const uid = e.user.getUid("sr")
  if (!uid) {
    e.reply("请先绑定崩铁 UID，再导入跃迁 Cookie")
    return true
  }
  const cookie = extractSrGachaCookie(e.raw_message || e.original_msg || e.msg)
  try {
    new SrGachaSummary({ uid, cookie })
    saveSrGachaCookie(getSrGachaCookieFile(e.user_id), cookie)
    e.reply("崩铁跃迁 Cookie 已安全保存，可发送【*更新抽卡记录】获取五星跃迁摘要")
  } catch (error) {
    e.reply(`Cookie 导入失败：${error.message}`)
  }
  return true
}
async function getAuthKey(
  e,
  user,
  data = {
    auth_appid: "webview_gacha",
  },
) {
  if (!e.uid) {
    e.uid = e?.runtime?.user?._regUid
  }
  e.region = getServer(e.uid)
  let authkeyrow = await user.getData("authKey", data)
  if (!authkeyrow?.data) {
    e.reply(
      `uid:${e.uid},authkey获取失败：` +
        (authkeyrow.message.includes("登录失效") ? "请重新绑定stoken" : authkeyrow.message),
    )
    return false
  }
  return authkeyrow.data["authkey"]
}
export async function mytoken(e) {
  if (!e.isPrivate) {
    e.reply("请私聊发送")
    return true
  }
  let user = new User(e)
  let msg = e.msg.replace(/#|我的/g, "")
  let ck, sendMsg
  if (msg === "stoken") {
    await user.getCookie(e)
    ck = await user.getStoken(e.user_id)
    sendMsg = `stuid=${ck.stuid};stoken=${ck.stoken};ltoken=${ck.ltoken};`
    if (ck?.mid) sendMsg += `mid=${ck?.mid};`
  } else {
    ck = await user.getyunToken(e)
    sendMsg = `${ck.yuntoken}devId=${ck.devId}`
  }
  if (sendMsg.includes("undefined")) {
    e.reply(`您暂未绑定${msg}`)
    return true
  }
  e.reply(sendMsg)
  return true
}

export async function bindLogin_ticket(e) {
  if (!e.isPrivate) {
    e.reply("请私聊发送")
    return true
  }
  let user = new User(e)
  let ckMap = await utils.getCookieMap(e.original_msg.replace(/'|"/g, ""))
  let stuid = ckMap?.get("login_uid") ? ckMap?.get("login_uid") : ckMap?.get("ltuid")
  if (!stuid) stuid = ckMap?.get("account_id")
  if (ckMap && Cfg.get("ck.sk")) {
    let res = await user.getData("bbsStoken", {
      loginUid: stuid,
      loginTicket: ckMap.get("login_ticket"),
    })
    if (res?.retcode === 0) {
      e.stuid = stuid
      await user.seachUid(res)
    }
  }
  return false
}

export async function bindStoken(e, uid = "") {
  if (!e.isPrivate) {
    e.reply("请私聊发送")
    return true
  }
  let msg = e.msg
  let user = new User(e)
  await user.cookie(e)
  e.uid = uid || e.uid
  e.region = getServer(e.uid)
  e.cks = msg.replace(/;/g, "&").replace(/stuid/, "uid")
  e.sk = await utils.getCookieMap(msg)
  let res = await user.getData("bbsGetCookie", { cookies: e.cks }, false)
  if (!res?.data) {
    e.uid = "64"
    e.region = getServer(e.uid)
    res = await user.getData("bbsGetCookie", { cookies: e.cks, method: "post" }, false)
    if (!res?.data) {
      await e.reply(
        `绑定Stoken失败，异常：${res?.message}\n请发送【stoken帮助】查看配置教程重新配置~`,
      )
      return true
    } else {
      await user.seachUid(res)
      return true
    }
  }
  // await user.getCookie(e)
  await user.seachUid(res)
  return true
}
export async function cloudToken(e) {
  if (e.msg.includes("ltoken") || e.msg.includes("_MHYUUID")) {
    //防止拦截米社cookie
    return false
  }
  if (["ct", "si", "devId"].includes(e.msg)) {
    e.reply(
      `格式支持\nai=*;ci=*;oi=*;ct=***********;si=**************;bi=***********;devId=***********`,
    )
    return false
  }
  let msg = e.msg.replace(/dev(i|l|I|L)d/g, "devId").split("devId")
  if (msg.length < 2) {
    Bot.logger.mark(`云原神绑定失败：未包含devId字段~`)
    return false
  }
  let devId = msg[1].replace(/=/, "")
  let user = new User(e)
  let yuntoken = msg[0]
  e.devId = devId
  e.yuntoken = yuntoken
  let res = await user.cloudSeach()
  if (res.retcode != 0) {
    e.reply(res.message)
    return true
  }
  let datalist = {
    devId: devId,
    yuntoken: yuntoken,
    qq: e.user_id,
    uid: e.uid,
    sign: true,
  }
  let yamlStr = YAML.stringify(datalist)
  fs.writeFileSync(`${yunpath}${e.user_id}.yaml`, yamlStr, "utf8")
  e.reply("云原神cookie保存成功~\n您后续可发送【#云原神查询】获取使用时间~")
  return true
}

export async function delSign(e) {
  let user = new User(e)
  e.msg = e.msg.replace(/#|删除|我的/g, "")
  let url = /sk|stoken/.test(e.msg) ? `${YamlDataUrl}` : `${yunpath}`
  await user.delSytk(url, e)
  return true
}
export async function updCookie(e) {
  let stoken = await gsCfg.getUserStoken(e.user_id)
  if (Object.keys(stoken).length == 0) {
    e.reply("请先绑定stoken\n发送【stoken帮助】查看配置教程")
    return true
  }
  let isGet = e.msg.includes("获取")
  if (!e.isPrivate && isGet) {
    e.reply("请私聊发送")
    return true
  }
  let user = new User(e)
  let sendMsg = []
  e._reply = e.reply
  e.reply = msg => {
    sendMsg.push(msg)
  }
  for (let item of Object.keys(stoken)) {
    e.region = getServer(stoken[item].uid)
    e.uid = stoken[item].uid
    if (!e?.uid) {
      Bot.logger.mark(`[刷新ck][stoken读取]qq:${e?.user_id}；uid:${e?.uid}`)
      continue //奇怪的东西
    }
    let cookies = `uid=${stoken[item].stuid}&stoken=${stoken[item].stoken}`
    if (stoken[item]?.mid) cookies += `&mid=${stoken[item]?.mid}`
    let data = { cookies: cookies }
    if (e?.uid[0] > 5) data.method = "post"
    let res = await user.getData("bbsGetCookie", data, false)
    if (!res?.data) {
      e.reply(`uid:${stoken[item].uid},请求异常：${res.message}`)
      continue
    }
    let ck = res["data"]["cookie_token"]
    e.msg = `ltoken=${stoken[item].ltoken};ltuid=${stoken[item].stuid};cookie_token=${ck}; account_id=${stoken[item].stuid};`
    if (isGet) {
      sendMsg = [...sendMsg, ...[`uid:${stoken[item].uid}`, e.msg]]
    } else {
      if (isV3) {
        let userck = (await import(`file://${_path}/plugins/genshin/model/user.js`)).default
        e.ck = e.msg
        await new userck(e).bing()
      } else {
        let { bingCookie } = await import(`file://${_path}/lib/app/dailyNote.js`)
        e.isPrivate = true
        await bingCookie(e)
      }
    }
  }
  await utils.replyMake(e, sendMsg, 0)
  return true
}

function getServer(uid) {
  switch (String(uid)[0]) {
    case "1":
    case "2":
      return "cn_gf01" // 官服
    case "5":
      return "cn_qd01" // B服
    case "6":
      return "os_usa" // 美服
    case "7":
      return "os_euro" // 欧服
    case "8":
      return "os_asia" // 亚服
    case "9":
      return "os_cht" // 港澳台服
  }
  return "cn_gf01"
}

export async function srGachaExportGuard(e) {
  if (!e.isSr) return false
  const uid = e.user?.getUid ? e.user.getUid("sr") : e.uid
  if (!uid || !hasPlaceholder(e.user_id, uid)) return false
  e.reply(
    [
      "检测到抽卡记录中存在占位条目，已阻止导出。",
      "占位条目由崩铁五星跃迁摘要生成，用于补齐总抽数，不含四星与三星明细，导出会产生不完整的 UIGF 文件。",
      "请先在游戏内获取抽卡链接，执行一次全量更新抽卡记录，占位条目会被真实数据整段替换，之后即可正常导出。",
    ].join("\n"),
  )
  return true
}
