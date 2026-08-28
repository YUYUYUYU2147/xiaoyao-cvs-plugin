import fs from "node:fs"
import path from "node:path"

/** 徽章跃迁类型 -> genshin 抽卡记录文件名（srPool 的 type） */
export const SR_GACHA_TYPE_MAP = {
  GachaType_AvatarUp: "11",
  GachaType_EquipmentUp: "12",
  GachaType_CollabAvatarUp: "21",
  GachaType_CollabEquipmentUp: "22",
  GachaType_Newbie: "2",
}

/** 占位标记，genshin 不认识，仅本插件用于识别与清理 */
export const PLACEHOLDER_FLAG = "is_placeholder"
/** 徽章来源标记，用于区分本插件写入的真实五星与 authkey 记录 */
export const BADGE_FLAG = "from_badge"
/** 占位星级。genshin analyse() 只统计 rank_type 4/5，故 3 天然不进四星统计 */
const PLACEHOLDER_RANK = "3"
const PLACEHOLDER_NAME = "未知"
/** 记录 id 前 10 位是卡池批次（秒级时间戳），后续位是各接口独立编号 */
const BATCH_LEN = 10

export function getSrJsonDir(userId, uid) {
  const qq = String(userId)
  const id = String(uid)
  if (!/^[a-zA-Z0-9_-]+$/.test(qq)) throw new Error("用户标识不合法")
  if (!/^\d+$/.test(id)) throw new Error("崩铁 UID 不合法")
  return path.join(process.cwd(), "data", "srJson", qq, id)
}

export function batchOf(id) {
  return String(id).slice(0, BATCH_LEN)
}

/** 记录 id 前 13 位是毫秒时间戳，据此还原 time，不伪造时间 */
export function idToTime(id) {
  const ms = Number(String(id).slice(0, 13))
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const date = new Date(ms + 8 * 60 * 60 * 1000)
  const pad = value => String(value).padStart(2, "0")
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

export function isPlaceholder(row) {
  return row?.[PLACEHOLDER_FLAG] === true
}

/**
 * 跨接口身份：批次 + 物品 + 同批次内出现序号。
 * 徽章与 authkey 的完整 id 是两套独立编号，只有这个组合能对齐同一次抽卡。
 * rows 必须已按 id 降序，占位不参与编号。
 */
export function withLogicalIds(rows) {
  const counter = new Map()
  for (const row of rows) {
    if (isPlaceholder(row)) continue
    const key = `${batchOf(row.id)}|${row.item_id ?? ""}`
    const seq = (counter.get(key) || 0) + 1
    counter.set(key, seq)
    row.logical_id = `${key}|${seq}`
  }
  return rows
}

/**
 * authkey 已覆盖的批次：出现过非五星真实条目即视为该批次逐抽齐全。
 * 只有五星不足以证明覆盖（徽章自己也会写五星）。
 */
export function coveredBatches(rows) {
  const covered = new Set()
  for (const row of rows) {
    if (isPlaceholder(row) || row?.[BADGE_FLAG]) continue
    if (String(row.rank_type) === "5") continue
    covered.add(batchOf(row.id))
  }
  return covered
}

/**
 * 在开区间 (lower, base) 内取 count 个降序且互不相同的 id。
 * 均匀分布以远离真实 id，命中已占用值时向下就近避让。
 */
function buildPlaceholderIds(base, lower, count, used) {
  if (count <= 0) return []
  const top = BigInt(base)
  const bottom = BigInt(lower)
  const room = top - bottom - 1n
  if (room <= 0n) return []
  const want = BigInt(count)
  const step = room >= want ? (top - bottom) / (want + 1n) : 1n
  const ids = []
  const taken = new Set()
  for (let k = 1n; k <= want; k++) {
    let candidate = room >= want ? top - k * step : top - k
    if (candidate <= bottom) break
    while ((used.has(candidate.toString()) || taken.has(candidate.toString())) && candidate > bottom + 1n) {
      candidate -= 1n
    }
    const value = candidate.toString()
    if (candidate <= bottom || used.has(value) || taken.has(value)) break
    taken.add(value)
    ids.push(value)
  }
  return ids.sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))
}

function makePlaceholder({ uid, gachaType, id, itemType }) {
  return {
    uid: String(uid),
    gacha_id: "",
    gacha_type: gachaType,
    item_id: "",
    count: "1",
    time: idToTime(id),
    name: PLACEHOLDER_NAME,
    lang: "zh-cn",
    item_type: itemType,
    rank_type: PLACEHOLDER_RANK,
    id: String(id),
    [PLACEHOLDER_FLAG]: true,
    [BADGE_FLAG]: true,
  }
}

function makeFiveStar({ uid, gachaType, record }) {
  return {
    uid: String(uid),
    gacha_id: "",
    gacha_type: gachaType,
    item_id: record.item_id == null ? "" : String(record.item_id),
    count: "1",
    time: idToTime(record.id),
    name: record.name,
    lang: "zh-cn",
    item_type: record.item_type,
    rank_type: "5",
    id: String(record.id),
    [BADGE_FLAG]: true,
  }
}

/**
 * 把单个卡池的徽章摘要展开成 genshin 格式条目（id 降序）。
 * 已被 authkey 覆盖的批次整段跳过：那些抽数在本地已有真实逐抽记录。
 */
export function buildPoolRows({ uid, gachaType, pool, existingIds = new Set(), covered = new Set(), history = [] }) {
  const records = Array.isArray(pool?.records) ? [...pool.records] : []
  records.sort((a, b) => String(b.id).localeCompare(String(a.id)))
  const itemType = gachaType === "12" || gachaType === "22" ? "光锥" : "角色"
  const rows = []
  const shortfall = []
  const skipped = []
  const boundary = []
  if (!records.length) return { rows, shortfall, skipped, boundary }

  const used = new Set(existingIds)
  for (const record of records) used.add(String(record.id))

  // 徽章侧同样计算 logical_id，用于和历史真实记录对齐
  const badgeLogical = new Map()
  {
    const counter = new Map()
    for (const record of records) {
      const key = `${batchOf(record.id)}|${record.item_id ?? ""}`
      const seq = (counter.get(key) || 0) + 1
      counter.set(key, seq)
      badgeLogical.set(String(record.id), `${key}|${seq}`)
    }
  }
  const realRows = withLogicalIds(
    history.filter(row => !isPlaceholder(row) && !row[BADGE_FLAG]).slice()
      .sort((a, b) => String(b.id).localeCompare(String(a.id))),
  )
  const realByLogical = new Map(realRows.map(row => [row.logical_id, row]))
  const maxRealId = realRows.length ? String(realRows[0].id) : null

  // 当前垫抽：占位排在最新五星上方，批次已覆盖则本地已有真实记录，无需补
  const pity = Number(pool?.pity?.gacha_count)
  if (Number.isInteger(pity) && pity > 0 && !covered.has(batchOf(records[0].id))) {
    const top = (BigInt(records[0].id) + BigInt(pity) + 1n).toString()
    const ids = buildPlaceholderIds(top, records[0].id, pity, used)
    for (const id of ids) {
      used.add(id)
      rows.push(makePlaceholder({ uid, gachaType, id, itemType }))
    }
    if (ids.length < pity) shortfall.push({ name: "当前垫抽", need: pity, got: ids.length })
  }

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const batch = batchOf(record.id)
    if (covered.has(batch)) {
      skipped.push({ name: record.name, batch })
      continue
    }
    rows.push(makeFiveStar({ uid, gachaType, record }))
    const count = Number(record.gacha_count)
    if (!Number.isInteger(count) || count <= 1) continue
    const need = count - 1
    const previous = records[index + 1]
    // 下一条五星缺失或已被 authkey 覆盖：这条的垫抽跨进已导入区间。
    // 能在历史中定位到上一条五星时，扣除历史已有的抽数后补齐剩余，
    // 否则整段跳过，宁可少算也不与真实逐抽重复计数。
    if (!previous || covered.has(batchOf(previous.id))) {
      const realPrev = previous ? realByLogical.get(badgeLogical.get(String(previous.id))) : null
      if (!realPrev || !maxRealId) {
        boundary.push({ name: record.name, batch, skippedDraw: need, reason: "历史中找不到上一条五星" })
        continue
      }
      const already = realRows.filter(row => String(row.id).localeCompare(String(realPrev.id)) > 0).length
      const remain = need - already
      if (remain <= 0) {
        boundary.push({ name: record.name, batch, skippedDraw: 0, reason: `历史已覆盖该垫抽 ${already} 抽` })
        continue
      }
      const ids = buildPlaceholderIds(record.id, maxRealId, remain, used)
      for (const id of ids) {
        used.add(id)
        rows.push(makePlaceholder({ uid, gachaType, id, itemType }))
      }
      boundary.push({ name: record.name, batch, skippedDraw: already, reason: `历史已提供 ${already} 抽，补 ${ids.length} 抽` })
      if (ids.length < remain) shortfall.push({ name: record.name, need: remain, got: ids.length })
      continue
    }
    const ids = buildPlaceholderIds(record.id, previous.id, need, used)
    for (const id of ids) {
      used.add(id)
      rows.push(makePlaceholder({ uid, gachaType, id, itemType }))
    }
    if (ids.length < need) shortfall.push({ name: record.name, need, got: ids.length })
  }

  rows.sort((a, b) => String(b.id).localeCompare(String(a.id)))
  return { rows, shortfall, skipped, boundary }
}

/**
 * 合并到本地 json。
 * 真实条目按 logical_id 去重，authkey 记录优先于徽章记录；
 * 占位只保留本轮重建的（按池独立调用，失败池不会走到这里）。
 */
export function mergeRows(localList, incoming) {
  const local = withLogicalIds(
    (Array.isArray(localList) ? localList : []).slice().sort((a, b) => String(b.id).localeCompare(String(a.id))),
  )
  const next = withLogicalIds(incoming.slice().sort((a, b) => String(b.id).localeCompare(String(a.id))))

  const authkeyReal = local.filter(row => !isPlaceholder(row) && !row[BADGE_FLAG])
  const authkeyLogical = new Set(authkeyReal.map(row => row.logical_id))
  const authkeyIds = new Set(authkeyReal.map(row => String(row.id)))

  const result = [...authkeyReal]
  for (const row of next) {
    if (isPlaceholder(row)) {
      if (authkeyIds.has(String(row.id))) continue
      result.push(row)
      continue
    }
    // 同一次抽卡已有 authkey 记录时不再写入徽章副本
    if (authkeyLogical.has(row.logical_id) || authkeyIds.has(String(row.id))) continue
    result.push(row)
  }

  const byId = new Map()
  for (const row of result) byId.set(String(row.id), row)
  return withLogicalIds([...byId.values()].sort((a, b) => String(b.id).localeCompare(String(a.id))))
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    fs.writeFileSync(temp, JSON.stringify(data, "", "\t"), "utf8")
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}

/** 检测某 UID 的 genshin 抽卡记录里是否存在占位条目 */
export function hasPlaceholder(userId, uid) {
  let dir
  try {
    dir = getSrJsonDir(userId, uid)
  } catch {
    return false
  }
  for (const type of Object.values(SR_GACHA_TYPE_MAP)) {
    if (readJson(path.join(dir, `${type}.json`)).some(isPlaceholder)) return true
  }
  return false
}

/**
 * 把徽章摘要同步进 genshin 抽卡记录。
 * 按卡池独立处理：单池异常只跳过该池，不影响其它池已有的占位。
 */
export function syncSummaryToGenshin({ userId, uid, pools }) {
  const dir = getSrJsonDir(userId, uid)
  const stats = { pools: 0, five: 0, placeholder: 0, skipped: 0, shortfall: [], boundary: [], errors: [] }
  for (const [gachaType, pool] of Object.entries(pools || {})) {
    const type = SR_GACHA_TYPE_MAP[gachaType]
    if (!type) continue
    const file = path.join(dir, `${type}.json`)
    try {
      const local = readJson(file)
      const existingIds = new Set(local.map(row => String(row.id)))
      const covered = coveredBatches(local)
      const { rows, shortfall, skipped, boundary } = buildPoolRows({ uid, gachaType: type, pool, existingIds, covered, history: local })
      const merged = mergeRows(local, rows)
      if (merged.length === local.length && !rows.length) continue
      writeJson(file, merged)
      stats.pools++
      stats.five += rows.filter(row => row.rank_type === "5").length
      stats.placeholder += rows.filter(isPlaceholder).length
      stats.skipped += skipped.length
      if (shortfall.length) stats.shortfall.push({ type, items: shortfall })
      if (boundary.length) stats.boundary.push({ type, items: boundary })
    } catch (error) {
      stats.errors.push({ type, message: error?.message || String(error) })
    }
  }
  return stats
}
