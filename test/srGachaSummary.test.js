import { test } from "node:test"
import assert from "node:assert/strict"
import { SR_GACHA_COMMAND, SR_GACHA_COOKIE_COMMAND, SR_GACHA_REIMPORT_PROMPT, formatSrGachaFailure, mergeSrSummary, normalizeSrCookie, normalizeSrRecords, SrGachaSummary, getSrRegion, validateSrCredentials, withFileLock, isSuccessfulReply, readSummary, readSrGachaCookie, saveSrGachaCookie, saveSummary, sanitizeSrGachaCookieLog } from "../model/srGachaSummary.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const cookie = "account_id=account;ltoken_v2=ltoken;cookie_token_v2=cookie;account_mid_v2=mid;e_hkrpg_token=hkrpg;DEVICEFP=fp;_MHYUUID=device-id;mi18nLang=zh-cn"

test("只保留五星，并把 null item 作为垫抽摘要", () => {
  const result = normalizeSrRecords([
    { item: null, got_item: false, gacha_count: 7, id: "0" },
    { item: { name: "四星角色", item_type: "ItemType_Avatar", rarity: 4 }, got_item: true, id: "4" },
    { item: { item_id: 1512, name: "五星角色", item_type: "ItemType_Avatar", rarity: 5 }, got_item: true, is_up: true, gacha_count: 77, id: "5" },
  ])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].item_type, "角色")
  assert.deepEqual(result.pity, { gacha_count: 7 })
})

test("合并按 id 去重，并用本次垫抽状态覆盖旧摘要", () => {
  const result = mergeSrSummary({ records: [{ id: "1", name: "旧" }], pity: { gacha_count: 3 } }, { records: [{ id: "1", name: "新" }, { id: "2", name: "新增" }], pity: null })
  assert.deepEqual(result.records.map(row => row.name).sort(), ["新", "新增"])
  assert.equal(result.pity, null)
})

test("分页原样传递 version_id 和 next_max_id，并发送来源请求头", async () => {
  const calls = []
  const request = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => calls.length === 1 ? { retcode: 0, message: "OK", data: { version_id: "v", next_max_id: "m", has_more: true, list: [] } } : { retcode: 0, message: "OK", data: { has_more: false, list: [] } } }
  }
  await new SrGachaSummary({ uid: "105411991", cookie, device: "device-id", request }).fetchPool("GachaType_AvatarUp")
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /version_id=v/)
  assert.match(calls[1].url, /max_id=m/)
  assert.equal(calls[0].options.headers.origin, "https://act.mihoyo.com")
  assert.equal(calls[0].options.headers["x-rpc-jump_source"], "2")
})

test("拒绝业务错误和缺少分页游标的异常响应", async () => {
  const errorRequest = async () => ({ ok: true, json: async () => ({ retcode: -100 }) })
  await assert.rejects(
    new SrGachaSummary({ uid: "105411991", cookie, device: "device-id", request: errorRequest }).fetchPool("GachaType_Newbie"),
    /retcode -100/,
  )
  const brokenPageRequest = async () => ({ ok: true, json: async () => ({ retcode: 0, message: "OK", data: { list: [], has_more: true } }) })
  await assert.rejects(
    new SrGachaSummary({ uid: "105411991", cookie, device: "device-id", request: brokenPageRequest }).fetchPool("GachaType_Newbie"),
    /分页游标缺失/,
  )
})

test("成功响应必须同时包含 retcode 0 和 message OK", async () => {
  for (const response of [
    { retcode: 0, data: { has_more: false, list: [] } },
    { retcode: 0, message: "ERROR", data: { has_more: false, list: [] } },
  ]) {
    await assert.rejects(
      new SrGachaSummary({ uid: "105411991", cookie, request: async () => ({ ok: true, json: async () => response }) }).fetchPool("GachaType_Newbie"),
      /接口返回错误.*message/,
    )
  }
})

test("缺少 OK 响应时 update 不写入摘要", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-invalid-response-"))
  const file = path.join(dir, "summary.json")
  const request = async () => ({ ok: true, json: async () => ({ retcode: 0, data: { has_more: false, list: [] } }) })
  await assert.rejects(new SrGachaSummary({ uid: "105411991", cookie, request, file }).update(), /接口返回错误/)
  assert.equal(fs.existsSync(file), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("每次请求带有限超时信号，超时后锁释放且可重入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-timeout-"))
  const file = path.join(dir, "summary.json")
  let signal
  const request = async (_url, options) => {
    signal = options.signal
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  }
  const summary = new SrGachaSummary({ uid: "105411991", cookie, request, file, timeoutMs: 5 })
  await assert.rejects(summary.update(), /超时/)
  assert.equal(signal.aborted, true)
  assert.equal(fs.existsSync(`${file}.lock`), false)
  assert.equal(await withFileLock(file, async () => "reentered"), "reentered")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("fn 抛错后文件锁仍可重入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-lock-"))
  const file = path.join(dir, "summary.json")
  await assert.rejects(withFileLock(file, async () => { throw new Error("fn failed") }), /fn failed/)
  assert.equal(await withFileLock(file, async () => "ok"), "ok")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("命令只匹配星铁更新，不接管获取和导出", () => {
  const reg = new RegExp(SR_GACHA_COMMAND)
  assert.equal(reg.test("*更新抽卡记录"), true)
  assert.equal(reg.test("#星铁更新抽卡记录"), true)
  assert.equal(reg.test("*获取抽卡记录"), false)
  assert.equal(reg.test("*导出抽卡记录"), false)
})

test("完整跃迁 Cookie 导入命令只接受私聊形态并安全保存", () => {
  const reg = new RegExp(SR_GACHA_COOKIE_COMMAND)
  assert.equal(reg.test("*绑定跃迁Cookie " + cookie), true)
  assert.equal(reg.test("#星铁绑定跃迁Cookie " + cookie), true)
  assert.equal(reg.test("*绑定跃迁Cookie\nCookie: account_id=account\nCookie: ltoken_v2=ltoken"), true)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-cookie-test-"))
  const file = path.join(dir, "10001.cookie")
  saveSrGachaCookie(file, cookie)
  assert.equal(readSrGachaCookie(file), cookie)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("兼容 HttpCanary 多条 Cookie 头和代码块包装", () => {
  const input = `\`\`\`text\nCookie: account_id=account\nCookie: ltoken_v2=ltoken\ncookie_token_v2=cookie; account_mid_v2=mid\ne_hkrpg_token=hkrpg; DEVICEFP=fp\n_MHYUUID=device-id; mi18nLang=zh-cn\n\`\`\``
  const normalized = normalizeSrCookie(input)
  assert.match(normalized, /^account_id=account;ltoken_v2=ltoken;/)
  assert.doesNotThrow(() => validateSrCredentials(input, "device-id"))
})

test("跃迁 Cookie 日志脱敏且不会回显 Cookie", () => {
  const fake = "account_id=fake-cookie-value;cookie_token_v2=fake-token"
  const sanitized = sanitizeSrGachaCookieLog(`[用户][*绑定跃迁Cookie ${fake}]`)
  assert.match(sanitized, /Cookie已脱敏/)
  assert.equal(sanitized.includes(fake), false)
})

test("B 服参数使用 prod_qd_cn，国际服和未知池类型明确拒绝", async () => {
  assert.equal(getSrRegion("512345678"), "prod_qd_cn")
  let requestUrl
  const request = async url => {
    requestUrl = url
    return { ok: true, json: async () => ({ retcode: 0, message: "OK", data: { has_more: false, list: [] } }) }
  }
  await new SrGachaSummary({ uid: "512345678", cookie, request }).fetchPool("GachaType_Newbie")
  const params = new URL(requestUrl).searchParams
  assert.equal(params.get("region"), "prod_qd_cn")
  assert.equal(params.get("badge_region"), "prod_qd_cn")
  assert.equal(params.get("uid"), "512345678")
  assert.equal(params.get("badge_uid"), "512345678")
  assert.throws(() => getSrRegion("612345678"), /国际服/)
  await assert.rejects(new SrGachaSummary({ uid: "512345678", cookie, device: "device-id" }).fetchPool("GachaType_WeaponUp"), /尚未完成接口确认/)
})

test("凭据必须完整且设备值与 _MHYUUID 一致", () => {
  assert.doesNotThrow(() => validateSrCredentials(cookie, "device-id"))
  assert.throws(() => validateSrCredentials(cookie.replace("DEVICEFP=fp;", ""), "device-id"), /DEVICEFP/)
  assert.throws(() => validateSrCredentials(cookie, "other-device"), /不一致/)
})

test("回复返回 error 时不视为成功", () => {
  assert.equal(isSuccessfulReply(undefined), true)
  assert.equal(isSuccessfulReply({ error: new Error("send failed") }), false)
  assert.equal(isSuccessfulReply({ ok: true }), true)
})

test("业务失败提示包含准确的私聊重新导入入口", () => {
  const message = formatSrGachaFailure(new Error("HTTP 401"))
  assert.match(message, /HTTP 401/)
  assert.ok(message.includes(SR_GACHA_REIMPORT_PROMPT))
})

test("摘要临时文件和最终文件均为 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-mode-"))
  const file = path.join(dir, "summary.json")
  saveSummary(file, { schema: 1, records: [] })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir), ["summary.json"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("文件锁释放后可再次获取，并回收已结束进程的 stale lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-test-"))
  const file = path.join(dir, "summary.json")
  await withFileLock(file, async () => {
    await assert.rejects(withFileLock(file, async () => {}, { retries: 1, delay: 1 }), /正在进行/)
  })
  await withFileLock(file, async () => {})
  assert.equal(fs.existsSync(`${file}.lock`), false)
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 99999999, time: Date.now() - 11 * 60 * 1000 }))
  await withFileLock(file, async () => {}, { retries: 2, delay: 1 })
  assert.equal(fs.existsSync(`${file}.lock`), false)
  for (const contents of ["", "{bad json", JSON.stringify({ pid: "bad", time: Date.now() - 11 * 60 * 1000 })]) {
    fs.writeFileSync(`${file}.lock`, contents)
    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(`${file}.lock`, old, old)
    await withFileLock(file, async () => {}, { retries: 2, delay: 1, staleAfter: 1000 })
    assert.equal(fs.existsSync(`${file}.lock`), false)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test("update 逐池抓取、重新读取并持久化五星增量", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-summary-update-"))
  const file = path.join(dir, "summary.json")
  let round = 0
  const request = async url => {
    const type = new URL(url).searchParams.get("gacha_type")
    const isAvatar = type === "GachaType_AvatarUp"
    const item = isAvatar ? { item_id: 1, name: round ? "新角色" : "旧角色", item_type: "ItemType_Avatar", rarity: 5 } : { item_id: 2, name: "光锥", item_type: "ItemType_Equipment", rarity: 5 }
    return { ok: true, json: async () => ({ retcode: 0, message: "OK", data: { has_more: false, list: [{ id: isAvatar ? "a1" : "w1", uuid: "u1", item, got_item: true, is_up: isAvatar, gacha_count: 77 }] } }) }
  }
  const first = await new SrGachaSummary({ uid: "105411991", cookie, request, file }).update()
  round = 1
  const second = await new SrGachaSummary({ uid: "105411991", cookie, request, file }).update()
  assert.equal(first.added, 2)
  assert.equal(second.added, 0)
  assert.equal(readSummary(file).pools.GachaType_AvatarUp.records[0].name, "新角色")
  assert.equal(readSummary(file).pools.GachaType_Newbie.records.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
