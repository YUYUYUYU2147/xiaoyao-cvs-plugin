import fs from "node:fs"
import path from "node:path"
import fetch from "node-fetch"

export const SR_GACHA_POOLS = [
  { type: "GachaType_AvatarUp", name: "角色活动跃迁" },
  { type: "GachaType_EquipmentUp", name: "光锥活动跃迁" },
  { type: "GachaType_CollabAvatarUp", name: "联动角色跃迁" },
  { type: "GachaType_CollabEquipmentUp", name: "联动光锥跃迁" },
  { type: "GachaType_Newbie", name: "新手跃迁" },
]
export const SR_GACHA_COMMAND = "^(?:\\*|#星铁)更新抽卡记录$"
export const SR_GACHA_COOKIE_COMMAND = "^(?:\\*|#星铁)绑定跃迁Cookie\\s+([\\s\\S]+)$"
export const SR_GACHA_REIMPORT_PROMPT = "请私聊发送 *绑定跃迁Cookie <米游社Cookie> 重新导入"

const API_URL = "https://act-api-takumi.mihoyo.com/event/rpg_gacha_record/five_star_list"
const BADGE_API_URL = "https://api-takumi.mihoyo.com/common/badge/v1/login/account"
const VALID_REGIONS = ["prod_gf_cn", "prod_qd_cn"]
const EPHEMERAL_COOKIE_KEYS = ["e_hkrpg_token", "DEVICEFP", "DEVICEFP_SEED_ID", "DEVICEFP_SEED_TIME", "_MHYUUID"]

function parseCookie(cookie) {
  return new Map(
    normalizeSrCookie(cookie)
      .split(";")
      .map(part => {
        const index = part.indexOf("=")
        return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : []
      })
      .filter(([key, value]) => key && value),
  )
}

function serializeCookie(cookie) {
  return [...cookie.entries()].map(([key, value]) => `${key}=${value}`).join(";")
}

function getSetCookieHeaders(headers) {
  if (typeof headers?.raw === "function") {
    const values = headers.raw()["set-cookie"]
    if (Array.isArray(values)) return values
  }
  const value = headers?.get?.("set-cookie")
  return value ? [value] : []
}

function getSetCookieValue(headers, name) {
  for (const header of getSetCookieHeaders(headers)) {
    const match = String(header).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`))
    if (match?.[1]) return match[1]
  }
  return ""
}

export function normalizeSrCookie(cookie) {
  let text = String(cookie || "").trim()
  const codeBlock = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  if (codeBlock) text = codeBlock[1].trim()
  const shellValue = text.match(/^COOKIE\s*=\s*(['"])([\s\S]*)\1$/i)
  if (shellValue) text = shellValue[2].trim()
  text = text.replace(/(?:^|[\r\n])\s*Cookie\s*:\s*/gi, "\n")
  text = text.replace(/;\s*Cookie\s*:\s*/gi, ";")
  return text
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(";")
}

export function extractSrGachaCookie(message) {
  return String(message || "").match(new RegExp(SR_GACHA_COOKIE_COMMAND))?.[1]?.trim() || ""
}

export function getSrRegion(uid) {
  const prefix = String(uid).slice(0, -8)
  if (prefix === "5") return "prod_qd_cn"
  if (["1", "2"].includes(prefix)) return "prod_gf_cn"
  throw new Error("仅支持崩铁国服官服或 B 服 UID，暂不支持国际服")
}

export function validateSrCredentials(cookie, device) {
  const normalizedCookie = normalizeSrCookie(cookie)
  const map = parseCookie(normalizedCookie)
  const required = [
    ["account", ["account_id", "account_id_v2", "ltuid", "ltuid_v2"]],
    ["ltoken_v2", ["ltoken_v2"]],
    ["cookie_token_v2", ["cookie_token_v2"]],
    ["mid", ["account_mid_v2", "ltmid_v2"]],
    ["mi18nLang", ["mi18nLang"]],
  ]
  const missing = required.filter(([, keys]) => !keys.some(key => map.get(key))).map(([name]) => name)
  if (missing.length) {
    throw new Error(`崩铁 Cookie 缺少必要字段：${missing.join("、")}；请提供米游社主 Cookie`)
  }
  const cookieDevice = map.get("_MHYUUID")
  if (device && cookieDevice && device !== cookieDevice) {
    throw new Error("崩铁设备信息与 Cookie 中的 _MHYUUID 不一致，请重新绑定包含设备信息的 Cookie")
  }
  const mainCookie = new Map(map)
  for (const key of EPHEMERAL_COOKIE_KEYS) mainCookie.delete(key)
  return { cookie: map, value: normalizedCookie, mainValue: serializeCookie(mainCookie), device: cookieDevice || "" }
}

export function isSuccessfulReply(reply) {
  return !(reply && typeof reply === "object" && reply.error)
}

export function sanitizeSrGachaCookieLog(text) {
  return String(text || "").replace(/(绑定跃迁Cookie\s+).*/, "$1<Cookie已脱敏>")
}

export function formatSrGachaFailure(error) {
  return `崩铁跃迁摘要获取失败：${error?.message || "未知错误"}\n${SR_GACHA_REIMPORT_PROMPT}`
}

export function getSrGachaCookieFile(userId) {
  const id = String(userId)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("用户标识不合法")
  return path.join(process.cwd(), "data", "srGachaCookie", `${id}.cookie`)
}

export function readSrGachaCookie(file) {
  try {
    return fs.readFileSync(file, "utf8").trim()
  } catch {
    return ""
  }
}

export function saveSrGachaCookie(file, cookie) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const normalizedCookie = normalizeSrCookie(cookie)
  try {
    fs.writeFileSync(temp, normalizedCookie, { encoding: "utf8", mode: 0o600, flag: "wx" })
    fs.renameSync(temp, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}

export function normalizeSrRecords(list) {
  if (!Array.isArray(list)) throw new Error("data.list 不是数组")
  const records = []
  let pity = null
  for (const row of list) {
    if (!row || typeof row !== "object") continue
    if (row.item === null) {
      if (row.got_item === false && Number.isInteger(Number(row.gacha_count)) && Number(row.gacha_count) >= 0) {
        pity = { gacha_count: Number(row.gacha_count) }
      }
      continue
    }
    // 接口是五星摘要；其它星级不得补写成四星或逐抽记录。
    if (row.got_item !== true || row.item?.rarity !== 5) continue
    const id = String(row.id || row.uuid || "")
    const item = row.item
    if (!id || !item.name || !["ItemType_Avatar", "ItemType_Equipment"].includes(item.item_type)) continue
    records.push({
      id,
      uuid: row.uuid || "",
      item_id: item.item_id,
      name: item.name,
      item_type: item.item_type === "ItemType_Avatar" ? "角色" : "光锥",
      rarity: 5,
      is_up: row.is_up === true,
      gacha_count: Number.isInteger(Number(row.gacha_count)) ? Number(row.gacha_count) : null,
    })
  }
  return { records, pity }
}

export function mergeSrSummary(previous, incoming) {
  const oldRecords = Array.isArray(previous?.records) ? previous.records : []
  const byId = new Map(oldRecords.map(row => [row.id || row.uuid, row]))
  for (const row of incoming.records) byId.set(row.id || row.uuid, row)
  return {
    records: [...byId.values()].sort((a, b) => String(b.id).localeCompare(String(a.id))),
    pity: incoming.pity,
  }
}

export function readSummary(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    return data?.schema === 1 ? data : { schema: 1, records: [], pity: null }
  } catch {
    return { schema: 1, records: [], pity: null }
  }
}

export function saveSummary(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(temp, 0o600)
    fs.renameSync(temp, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

function removeStaleLock(lockFile, staleAfter) {
  let stat
  let raw = ""
  try {
    stat = fs.statSync(lockFile)
    raw = fs.readFileSync(lockFile, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return true
    return false
  }
  let lock
  try { lock = JSON.parse(raw) } catch {}
  const timestamp = Number(lock?.time) || stat.mtimeMs
  if (Date.now() - timestamp <= staleAfter) return false
  if (lock?.pid && isProcessAlive(Number(lock.pid))) return false
  try {
    if (fs.readFileSync(lockFile, "utf8") !== raw) return false
    fs.unlinkSync(lockFile)
    return true
  } catch {
    return false
  }
}

export async function withFileLock(file, fn, { retries = 100, delay = 100, staleAfter = 10 * 60 * 1000 } = {}) {
  const lockFile = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const metadata = JSON.stringify({ pid: process.pid, time: Date.now(), token })
  let acquired = false
  for (let attempt = 0; attempt < retries; attempt++) {
    const tempLock = `${lockFile}.${token}.${attempt}.tmp`
    try {
      fs.writeFileSync(tempLock, metadata, { encoding: "utf8", mode: 0o600, flag: "wx" })
      fs.linkSync(tempLock, lockFile)
      acquired = true
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      removeStaleLock(lockFile, staleAfter)
      await new Promise(resolve => setTimeout(resolve, delay))
    } finally {
      try { fs.unlinkSync(tempLock) } catch {}
    }
  }
  if (!acquired) throw new Error("该 UID 的更新正在进行，请稍后重试")
  try {
    return await fn()
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"))
      if (current.token === token) fs.unlinkSync(lockFile)
    } catch {}
  }
}

export function formatSrSummary(result, maxPerPool = 5) {
  const lines = []
  for (const pool of Object.values(result.pools)) {
    const recent = pool.records.slice(0, maxPerPool)
    const details = recent.length
      ? recent.map(row => `${row.name} ${row.gacha_count == null ? "抽数未知" : `${row.gacha_count}抽`} ${row.is_up ? "UP" : "非UP"}`).join("；")
      : "暂无五星记录"
    lines.push(`【${pool.name}】${details}`)
  }
  return lines.join("\n")
}

export class SrGachaSummary {
  constructor({ uid, cookie, device = "", region = getSrRegion(uid), request = fetch, file, timeoutMs = 30000 } = {}) {
    if (!uid || !cookie) throw new Error("未找到崩铁 UID 或 Cookie")
    this.uid = String(uid)
    const credentials = validateSrCredentials(cookie, device)
    this.cookie = credentials.value
    this.mainCookie = credentials.mainValue
    this.device = credentials.device
    if (!VALID_REGIONS.includes(region) || region !== getSrRegion(this.uid)) throw new Error("仅支持崩铁国服官服或 B 服，区服与 UID 不匹配")
    this.region = region
    this.request = request
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("请求超时必须是有限正数")
    this.timeoutMs = timeoutMs
    this.file = file || path.join(process.cwd(), "data", "srGachaSummary", `${this.uid}.json`)
  }

  async refreshBadgeSession() {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(BADGE_API_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
          origin: "https://act.mihoyo.com",
          referer: "https://act.mihoyo.com/",
          Cookie: this.mainCookie,
        },
        body: JSON.stringify({
          uid: this.uid,
          region: this.region,
          game_biz: "hkrpg_cn",
          lang: "zh-cn",
        }),
        signal: controller.signal,
      })
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "请求失败"}`)
      const reply = await response.json()
      if (reply?.retcode !== 0 || reply?.message !== "OK") {
        throw new Error(`崩铁徽章会话换取失败（retcode ${reply?.retcode ?? "未知"}，message ${reply?.message ?? "未知"}）`)
      }
      const token = getSetCookieValue(response.headers, "e_hkrpg_token")
      if (!token) throw new Error("崩铁徽章会话未下发 e_hkrpg_token")
      this.cookie = `${this.mainCookie};e_hkrpg_token=${token}`
      return token
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`崩铁徽章会话换取超时（${this.timeoutMs}ms）`)
      const message = error?.message || String(error)
      if (message.startsWith("崩铁徽章会话")) throw new Error(message)
      throw new Error(`请求崩铁徽章会话失败：${message}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  async fetchPool(gachaType) {
    if (!SR_GACHA_POOLS.some(pool => pool.type === gachaType)) throw new Error("该崩铁跃迁类型尚未完成接口确认")
    let versionId
    let maxId
    const rows = []
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({
        game_biz: "hkrpg_cn",
        region: this.region,
        uid: this.uid,
        badge_region: this.region,
        badge_uid: this.uid,
        gacha_type: gachaType,
      })
      if (versionId) params.set("version_id", versionId)
      if (maxId) params.set("max_id", maxId)
      let response
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        response = await this.request(`${API_URL}?${params}`, {
          headers: {
            accept: "application/json, text/plain, */*",
            origin: "https://act.mihoyo.com",
            referer: "https://act.mihoyo.com/",
            "x-rpc-platform": "android",
            "x-rpc-jump_source": "2",
            Cookie: this.cookie,
          },
          signal: controller.signal,
        })
        if (!response?.ok) throw new Error(`HTTP ${response?.status || "请求失败"}`)
        response = await response.json()
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`请求${gachaType}超时（${this.timeoutMs}ms）`)
        throw new Error(`请求${gachaType}失败：${error.message}`)
      } finally {
        clearTimeout(timeout)
      }
      if (response?.retcode !== 0 || response?.message !== "OK") {
        throw new Error(`接口返回错误（retcode ${response?.retcode ?? "未知"}，message ${response?.message ?? "未知"}）`)
      }
      const data = response.data
      if (!data || !Array.isArray(data.list)) throw new Error("接口返回结构异常")
      rows.push(...data.list)
      if (typeof data.has_more !== "boolean") throw new Error("接口返回结构异常：has_more 必须为布尔值")
      if (!data.has_more) break
      if (!data.version_id || !data.next_max_id) throw new Error("接口分页游标缺失")
      versionId = String(data.version_id)
      maxId = String(data.next_max_id)
      if (page === 99) throw new Error("接口分页超过安全上限")
    }
    return normalizeSrRecords(rows)
  }

  async update() {
    return await withFileLock(this.file, async () => {
      await this.refreshBadgeSession()
      const incoming = {}
      for (const pool of SR_GACHA_POOLS) incoming[pool.type] = await this.fetchPool(pool.type)
      // 必须在完整抓取后重新读取，避免并发更新覆盖另一进程的新记录。
      const old = readSummary(this.file)
      const result = { schema: 1, source: "mihoyo:rpg_gacha_record/five_star_list", uid: this.uid, region: this.region, complete: false, only_five_star: true, pools: {} }
      let added = 0
      for (const pool of SR_GACHA_POOLS) {
        const previous = old.pools?.[pool.type]
        const merged = mergeSrSummary(previous, incoming[pool.type])
        result.pools[pool.type] = { name: pool.name, ...merged }
        added += Math.max(0, merged.records.length - (previous?.records?.length || 0))
      }
      saveSummary(this.file, result)
      return { added, file: this.file, pools: result.pools }
    })
  }
}
