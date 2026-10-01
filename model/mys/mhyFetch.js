/**
 * 走米游社的请求出口。默认直连，被风控拦了才切代理。
 *
 * 为什么要有这一层：米游社对单个 IP 有频次风控，触发后不是返回错误码而是
 * 返回一整页 HTML「已阻断」（表现为 HTTP 405），于是所有接口一起挂 ——
 * 绑定 stoken、签到、查角色都会跟着失败，而且报出来的还是
 * 「Missing parameters」这种和风控毫无关系的文案，误导人往配置上找原因。
 *
 * 为什么要「被拦才切」而不是一开始就切：代理要经手我们的 Cookie
 * （ltoken + cookie_token + ltuid + account_id），那是能长期占用账号的东西。
 * 所以默认不外传，只有直连确实被拦了、这次请求本来就要发出去时才走代理。
 *
 * 配置（config/config.yaml，默认全空 = 不启用）：
 *   mhy_proxy      代理地址，形如 https://xxx.com/mihoyo_api
 *   mhy_proxy_key  该代理的 token，会放进 x-mihoyo-api-token 头
 *
 * 填了之后也只是「兜底」：平时一个代理请求都不发。
 * 与 xhh 插件共用同一套配置项，两边行为一致。
 */

import fs from 'node:fs';
import YAML from 'yaml'

const _path = process.cwd()
const CFG_PATH = `${_path}/plugins/xiaoyao-cvs-plugin/config/config.yaml`

let _cfg = null

/** 读配置。缓存起来 —— 一轮签到能发几十个请求，不必每次都读盘。 */
function cfg() {
	if (_cfg) return _cfg
	_cfg = {}
	try {
		if (fs.existsSync(CFG_PATH)) {
			const parsed = YAML.parse(fs.readFileSync(CFG_PATH, 'utf-8'))
			if (parsed && typeof parsed === 'object') _cfg = parsed
		}
	} catch (_) {
		_cfg = {}
	}
	return _cfg
}

/** 只认米游社官方地址，别把打码平台之类的也往代理送 */
const MHY_HOSTS = [
	'api-takumi.mihoyo.com',
	'api-takumi.miyoushe.com',
	'api.mihoyo.com',
	'bbs-api.miyoushe.com',
	'api-takumi-record.mihoyo.com',
	'public-operation-common.mihoyo.com',
]

function isMhyUrl(url) {
	const s = String(url || '')
	return MHY_HOSTS.some(h => s.includes(h))
}

/** 代理没配或 key 没有就当没配 */
export function proxyEnabled() {
	const c = cfg()
	const base = String(c.mhy_proxy || '').trim()
	const key = String(c.mhy_proxy_key || '').trim()
	return !!base && !!key
}

function proxyBase() {
	const base = String(cfg().mhy_proxy || '').trim()
	if (!base) return ''
	return base.endsWith('/') ? base.slice(0, -1) : base
}

/**
 * 米游社返回的不是 JSON 时会带这些特征，用来识别风控拦截页。
 * 判据用内容而不是状态码 —— 405 也可能是别的错，只认特征更准。
 */
function looksBlocked(text) {
	if (!text) return false
	const t = String(text)
	return t.includes('已阻断') || t.includes('阻断页面') || t.includes('安全威胁')
}

/** 包一层，给出与 fetch 一致的形状 */
function makeResponse(ok, status, text, headers) {
	return {
		ok,
		status,
		headers,
		text: async () => text,
		json: async () => JSON.parse(text),
	}
}

/**
 * 被风控拦了之后走代理重试一次。
 * 返回与 fetch 一致的响应对象；失败返回 null 让调用方按原样处理。
 */
async function viaProxy(url, param) {
	if (!proxyEnabled() || !isMhyUrl(url)) return null
	const payload = {
		url,
		headers: param?.headers || {},
		method: (param?.method || 'GET').toUpperCase(),
		game: gameOfUrl(url),
	}
	// body 可能是字符串或对象，原样转过去，代理会照转给米游社
	if (param?.body) {
		try {
			payload.body = JSON.parse(param.body)
		} catch (_) {
			payload.body = param.body
		}
	}
	try {
		const resp = await fetch(`${proxyBase()}/get`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-mihoyo-api-token': String(cfg().mhy_proxy_key || '').trim(),
			},
			body: JSON.stringify(payload),
			timeout: 20000,
		})
		const text = await resp.text()
		try {
			JSON.parse(text)
		} catch (_) {
			// 代理自己出问题时也会吐非 JSON，那就当没代理到
			return null
		}
		if (globalThis.Bot?.logger?.mark) {
			Bot.logger.mark(`[代理] 直连被拦，已改走代理 ${String(url).slice(0, 80)}`)
		}
		return makeResponse(true, 200, text, null)
	} catch (err) {
		if (globalThis.Bot?.logger?.error) {
			Bot.logger.error(`[代理] 代理请求失败: ${err.message}`)
		}
		return null
	}
}

/** 从 URL 认出是哪个游戏，好告诉代理（它的 game 参数要用 hk4e/hkrpg/nap） */
function gameOfUrl(url) {
	const s = String(url || '')
	if (s.includes('/hkkrpg/') || s.includes('hkrpg_cn') || s.includes('act_id=e202304121516551')) return 'hkrpg'
	if (s.includes('/nap/') || s.includes('zzz_cn') || s.includes('act_id=e202406242138391')) return 'nap'
	return 'hk4e'
}

/**
 * 出口。签名与 fetch 兼容，返回带 text() / json() 的响应对象。
 * 正常路径一个代理请求都不会发；只有直连拿到 HTML 阻断页时才试一次代理。
 */
export default async function mhyFetch(url, param = {}) {
	let response
	try {
		response = await fetch(url, param)
	} catch (error) {
		// 连接层面的失败（超时/DNS）不算风控，仍按原样抛给调用方
		throw error
	}
	if (!response.ok) {
		// 状态码先看一遍：有些拦截不返回 body，光读 text 判断不到
		if (response.status === 405 || response.status === 403) {
			const via = await viaProxy(url, param)
			if (via) return via
		}
		return response
	}
	const text = await response.text()
	if (!looksBlocked(text)) {
		return makeResponse(response.ok, response.status, text, response.headers)
	}
	const via = await viaProxy(url, param)
	if (via) return via
	// 没有代理或代理也不行，如实把被拦的事实交回去，由调用方归类
	return makeResponse(response.ok, response.status, text, response.headers)
}
