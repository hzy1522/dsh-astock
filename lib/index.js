/**
 * dsh-astock 主机端（Host half）。
 *
 * 职责：为同包的客户端 bundle 提供 A 股数据 HTTP 路由，并持久化自选股。
 *
 * 两个与「动态插件」时代不同的关键点：
 * 1. 这里运行在正常的 Node 环境，**不是受限沙箱**，可以直接使用 fetch / node:fs。
 * 2. 客户端不再能调用 `host.call`（那是动态插件专有机制），因此全部改为
 *    由本文件注册的 HTTP 路由，客户端用 fetch 访问。
 *
 * 数据源（全部免密钥，实测可用）：
 *   腾讯  web.ifzq.gtimg.cn  K线（日/周/月 × 前/后/不复权，按年区间分页）
 *   腾讯  qt.gtimg.cn        实时行情（GBK 编码，需按 charset 解码）
 *   新浪  money.finance.sina.com.cn  日线备源
 *   东财  searchapi / datacenter-web 代码搜索 / 财务指标
 *
 * @module dsh-astock/host
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名（诊断用）。 */
export const name = 'astock'

/** 没有 webServer 就无法暴露路由，声明为硬依赖。 */
export const inject = ['webServer']

const TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const TX_QUOTE = 'https://qt.gtimg.cn/q='
const SINA_KLINE = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
const EM_SUGGEST = 'https://searchapi.eastmoney.com/api/suggest/get'
const EM_FIN = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const EM_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'

/**
 * 判断代码属于哪个市场。
 *
 * 用位数区分，而不是猜前缀：A 股是 6 位，港股是 5 位。这条规则对搜索结果
 * 和手输代码都成立，比让调用方显式传市场更不容易出错。
 * @param code - 股票代码。
 * @returns 'cn'（A 股）、'hk'（港股）或 ''（无法识别）。
 */
function marketOf(code) {
  const c = String(code || '').trim()
  if (/^[0-9]{5}$/.test(c)) return 'hk'
  if (/^[0-9]{6}$/.test(c)) return 'cn'
  return ''
}

/**
 * 代码 -> 腾讯行情/K线用的带市场前缀符号。
 * A 股：6/9 沪市，4/8 北交所，其余深市；港股统一 hk 前缀。
 */
function symOf(code) {
  const c = String(code || '').trim()
  const market = marketOf(c)
  if (market === 'hk') return 'hk' + c
  if (market !== 'cn') return ''
  const head = c.charAt(0)
  if (head === '6' || head === '9') return 'sh' + c
  if (head === '4' || head === '8') return 'bj' + c
  return 'sz' + c
}

function numOf(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null
  const parsed = parseFloat(String(value))
  return isFinite(parsed) ? parsed : null
}

function enc(params) {
  const parts = []
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])))
    }
  }
  return parts.join('&')
}

/** 目标根数：日线按每年约 250 个交易日估算，留预热余量。 */
function periodTarget(period, years) {
  if (period === 'week') return years * 52 + 10
  if (period === 'month') return years * 12 + 6
  return years * 250 + 30
}

/**
 * 取文本并按响应头 charset 解码。
 *
 * 这里不能直接用 `response.text()`：腾讯行情返回 GBK，按 UTF-8 解码会把
 * 股票名变成乱码且不可逆。动态插件时代这一步由 host 的 `web` 服务代劳，
 * 现在必须自己做。
 * @param url - 完整请求地址。
 * @returns 解码后的响应文本。
 */
async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { accept: '*/*', 'user-agent': 'Mozilla/5.0 (compatible; dsh-astock)' },
  })
  if (!response.ok) throw new Error('上游返回 HTTP ' + response.status)
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  const matched = /charset=["']?([\w-]+)/i.exec(contentType)
  const label = matched === null ? 'utf-8' : matched[1].toLowerCase()
  if (label === 'utf-8' || label === 'utf8') return buffer.toString('utf8')
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    // 未知 charset 标签时退回 UTF-8，至少不抛错。
    return buffer.toString('utf8')
  }
}

async function getJson(url) {
  return JSON.parse(await fetchText(url))
}

/** 腾讯 K 线单次请求。param=symbol,period,起,止,根数,复权 */
async function txKlineOnce(symbol, period, fq, from, to, count) {
  const param = symbol + ',' + period + ',' + (from || '') + ',' + (to || '') + ',' + count + ',' + (fq || '')
  const json = await getJson(TX_KLINE + '?param=' + param)
  const bag = json && json.data ? json.data[symbol] : null
  if (!bag) return []
  const key = (fq || '') + period
  const raw = bag[key] || bag[period] || bag['qfq' + period] || bag['day'] || []
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]
    if (!row || row.length < 6) continue
    // 腾讯顺序：日期, 开, 收, 高, 低, 量
    out.push([String(row[0]), numOf(row[1]), numOf(row[2]), numOf(row[3]), numOf(row[4]), numOf(row[5])])
  }
  return out
}

/** 新浪备源，仅日线；字段顺序是 开/高/低/收，与腾讯不同。 */
async function sinaKline(symbol, count) {
  const text = await fetchText(SINA_KLINE + '?' + enc({ symbol: symbol, scale: '240', ma: 'no', datalen: String(count) }))
  const rows = JSON.parse(text)
  if (!Array.isArray(rows)) return []
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const d = String(r.day || '').slice(0, 10)
    if (d === '') continue
    out.push([d, numOf(r.open), numOf(r.close), numOf(r.high), numOf(r.low), numOf(r.volume)])
  }
  return out
}

/** code 为六位代码；symbol 为显式交易所代码（如 sh000300 沪深300），优先级更高。 */
async function loadKline(args) {
  const codeArg = String(args.code || '').trim()
  const symbolArg = String(args.symbol || '').trim()
  const period = String(args.period || 'day')
  const fq = args.fq === undefined || args.fq === null ? 'qfq' : String(args.fq)
  const years = Math.max(1, Math.min(15, Number(args.years || 3)))
  const symbol = /^(sh|sz|bj|hk)[0-9]{5,6}$/.test(symbolArg) ? symbolArg : symOf(codeArg)
  if (symbol === '') throw new Error('无效的股票代码')
  const market = symbol.slice(0, 2) === 'hk' ? 'hk' : marketOf(codeArg)
  const target = periodTarget(period, years)

  let all = []
  let source = 'tencent'
  let adjusted = market !== 'hk'
  try {
    const byDate = {}
    const dates = []
    const absorb = (rows) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (byDate[r[0]] === undefined) {
          byDate[r[0]] = r
          dates.push(r[0])
        }
      }
    }
    const newest = await txKlineOnce(symbol, period, fq, '', '', 300)
    if (newest.length === 0) throw new Error('腾讯未返回该代码的 K 线')
    absorb(newest)
    // 从最新一根的年份往前逐年翻页，规避单次响应体积与条数上限。
    let year = Number(newest[newest.length - 1][0].slice(0, 4)) - 1
    let guard = 0
    while (dates.length < target && guard < 40 && year >= 1990) {
      absorb(await txKlineOnce(symbol, period, fq, year + '-01-01', year + '-12-31', 320))
      year -= 1
      guard += 1
    }
    dates.sort()
    for (let i = 0; i < dates.length; i++) all.push(byDate[dates[i]])
  } catch (txError) {
    // 新浪备源只覆盖 A 股日线；港股请求它返回 null，直接抛出腾讯的错误更有用。
    if (period !== 'day' || market === 'hk') throw txError
    source = 'sina'
    all = await sinaKline(symbol, Math.min(1000, target))
    if (all.length === 0) throw txError
  }
  const trimmed = all.length > target ? all.slice(all.length - target) : all
  // adjusted=false 表示这段数据未经复权（港股经腾讯拿不到复权价）。
  return { code: codeArg || symbol, symbol, market, period, fq, source, adjusted, bars: trimmed }
}

/**
 * 解析腾讯行情。
 *
 * A 股与港股共用同一套 API，但字段布局有实质差异，必须分支处理：
 *   成交额   A 股是万元，港股是元（相差 10000 倍）
 *   换手率   港股该位为 0（无此数据）
 *   市净率   A 股在 46，港股该位是英文名（无此数据）
 *   每手股数 港股在 60（各股不同，汇丰 400、长和 500）；A 股恒为 100
 *   币种     港股在 75（HKD）
 * @param code - 股票代码。
 * @returns 归一化后的行情对象。
 */
async function loadQuote(code) {
  const symbol = symOf(code)
  if (symbol === '') throw new Error('无效的股票代码：' + code)
  const market = marketOf(code)
  const text = await fetchText(TX_QUOTE + symbol)
  const matched = /="([\s\S]*)"/.exec(text)
  if (!matched) throw new Error('腾讯行情返回格式异常')
  const f = matched[1].split('~')
  if (f.length < 47) throw new Error('腾讯行情字段不足（' + f.length + '）')
  const isHk = market === 'hk'
  return {
    code,
    market,
    name: f[1],
    price: numOf(f[3]), prevClose: numOf(f[4]), open: numOf(f[5]),
    change: numOf(f[31]), changePct: numOf(f[32]),
    high: numOf(f[33]), low: numOf(f[34]),
    volume: numOf(f[36]),
    amount: numOf(f[37]),
    // 成交额单位随市场不同，交给客户端换算显示。
    amountUnit: isHk ? 'yuan' : 'wan',
    turnover: isHk ? null : numOf(f[38]),
    pe: numOf(f[39]),
    amplitude: numOf(f[43]),
    floatCap: numOf(f[44]), marketCap: numOf(f[45]),
    pb: isHk ? null : numOf(f[46]),
    // 每手股数：A 股固定 100；港股逐股不同，读不到时保守按 100。
    lot: isHk ? (numOf(f[60]) || 100) : 100,
    currency: isHk ? (String(f[75] || 'HKD').trim() || 'HKD') : 'CNY',
    updated: f[30] || '',
  }
}

async function loadSearch(q) {
  if (q.trim() === '') return { items: [] }
  const items = []
  try {
    const json = await getJson(EM_SUGGEST + '?' + enc({ input: q, type: '14', token: EM_TOKEN, count: '12' }))
    const rows = json && json.QuotationCodeTable ? json.QuotationCodeTable.Data : null
    if (Array.isArray(rows)) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (!r) continue
        // A 股与港股都收；其余（美股/指数/板块/权证）过滤掉。
        const classify = String(r.Classify || '')
        if (classify !== 'AStock' && classify !== 'HK') continue
        const c = String(r.Code || '')
        const market = marketOf(c)
        if (market === '') continue
        // 港股里的衍生品（窝轮/牛熊证）代码也是 5 位，用类型名再筛一道。
        const board = String(r.SecurityTypeName || '')
        if (market === 'hk' && /购|沽|牛|熊|证/.test(board)) continue
        items.push({ code: c, name: String(r.Name || ''), board, market, pinyin: String(r.PinYin || '') })
      }
    }
  } catch {
    // 搜索源不可用时不致命：下面允许直接按代码录入。
  }
  if (items.length === 0 && marketOf(q) !== '') items.push({ code: q.trim(), name: q.trim(), board: '', market: marketOf(q), pinyin: '' })
  return { items }
}

async function loadFinancials(code) {
  const symbol = symOf(code)
  if (symbol === '') throw new Error('无效的股票代码：' + code)
  // 东财这份报表只覆盖 A 股（港股 SECUCODE=00700.HK 返回「返回数据为空」），
  // 与其给一个空表让用户以为没数据，不如说清楚。
  if (marketOf(code) === 'hk') {
    throw new Error('港股暂不提供财务数据：东方财富的这份报表只覆盖 A 股')
  }
  const secucode = code + '.' + symbol.slice(0, 2).toUpperCase()
  const json = await getJson(EM_FIN + '?' + enc({
    reportName: 'RPT_F10_FINANCE_MAINFINADATA',
    columns: 'SECUCODE,SECURITY_CODE,REPORT_DATE,EPSJB,BPS,ROEJQ,XSMLL',
    filter: '(SECUCODE="' + secucode + '")',
    pageSize: '16',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    source: 'HSF10',
    client: 'PC',
  }))
  const rows = json && json.result && Array.isArray(json.result.data) ? json.result.data : []
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    out.push({
      date: String(r.REPORT_DATE || '').slice(0, 10),
      eps: numOf(r.EPSJB), bps: numOf(r.BPS), roe: numOf(r.ROEJQ), gross: numOf(r.XSMLL),
    })
  }
  return { rows: out }
}

// ---------------- 公司事件（真实日期，供策略的事件因子使用） ----------------
//
// 「财报披露后第二个交易日买入」这类策略，缺的从来不是写代码的能力，而是**真实日期**：
// 「哪天开会」「哪天披露」「哪天是交易日」都不能让模型凭空算。所以这里把可核实的
// 公开日期取回来，交给策略与模型；交易日换算由客户端按真实 K 线完成。
//
// 三类事件都必须是**事先公布过**的，否则回测就是未来函数：
//   meeting  业绩说明会 / 股东大会 / 路演：公告正文里写明了会议召开时间，公告日在前
//   report   财报预约披露日：交易所期初公布的预约披露时间表（所以用预约日，而不是
//            实际披露日——用实际日会变成「提前知道财报哪天出」）
//   exdiv    除权除息日：分红实施公告里提前公布

const EM_ANNOUNCE = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
const EM_ANNOUNCE_BODY = 'https://np-cnotice-stock.eastmoney.com/api/content/ann'
const EM_APPOINT_REPORT = 'RPT_PUBLIC_BS_APPOIN'
const EM_BONUS_REPORT = 'RPT_SHAREBONUS_DET'

/** 会议类公告标题（A 股简体 + 港股繁体两套写法）。 */
const ANNOUNCE_TITLE = /(关于召开|關於召開|会议通知|會議通知|说明会|說明會|路演|业绩发布会|業績發布會|股东大会|股東大會|股东周年大会|股東週年大會|股东特别大会|股東特別大會|会议资料|會議資料)/
/** 这些是会后文件、结果公告或例行报表，正文里的日期不是会议召开时间。 */
const ANNOUNCE_EXCLUDE = /(决议|決議|结果|結果|法律意见|法律意見|律师|律師|提示性|延期|取消|更正|代表委任|声明|聲明|通函|月报表|月報表|翌日披露|投票|年报|年報|中期报告|中期報告|季度报告|季度報告)/
/** 港股的「董事会会议召开日期」公告＝提前公布的业绩日，是港股版的预约披露。 */
const BOARD_MEETING_TITLE = /(董事会会议召开日期|董事會會議召開日期)/
/** 港股「业绩公告」：公告日即业绩日，所以只能用于 n >= 0（提前埋伏会被公告日挡住）。 */
const RESULT_TITLE = /([业業][绩績]公告\s*$|[年季][业業][绩績]\s*$|盈利公布|盈利公佈|[年季]度[业業][绩績]|中期[业業][绩績]|末期[业業][绩績]|全年[业業][绩績])/

/** 中文数字（繁体常见「謹訂於二零二六年五月十三日」）。 */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_NUM_SRC = '[零〇一二三四五六七八九十]+'
const NUM_SRC = '\\d{1,4}|' + CN_NUM_SRC

/**
 * 中文数字转阿拉伯数字。
 * 支持逐字读的年份（二零二六）与正常写法（十三、二十、三十一）。
 * @param text - 中文数字串。
 * @returns 数字，或 null（无法解析）。
 */
function cnNumber(text) {
  const str = String(text || '')
  if (str === '' || !/^[零〇一二三四五六七八九十]+$/.test(str)) return null
  // 三位以上且不含「十」的，是逐字读的年份：二零二六 → 2026。
  if (str.length >= 3 && !str.includes('十')) {
    let out = ''
    for (const ch of str) {
      if (CN_DIGIT[ch] === undefined) return null
      out += String(CN_DIGIT[ch])
    }
    return Number(out)
  }
  if (str === '十') return 10
  const at = str.indexOf('十')
  if (at < 0) return CN_DIGIT[str] === undefined ? null : CN_DIGIT[str]
  const head = at === 0 ? 1 : CN_DIGIT[str[0]]
  const tail = at === str.length - 1 ? 0 : CN_DIGIT[str[at + 1]]
  if (head === undefined || tail === undefined) return null
  return head * 10 + tail
}

/** 数字 token（阿拉伯或中文）转数字。 */
function tokenNumber(token) {
  const text = String(token || '')
  return /^\d+$/.test(text) ? Number(text) : cnNumber(text)
}

/** (年, 月, 日) 三个数字转 ISO 日期，非法则 null。 */
function isoFromDay(year, month, day) {
  return isoDate(year, month, day)
}

/** 把匹配到的三组（年/月/日，可能是中文数字）拼成 ISO 日期，非法则 null。 */
function isoFromMatch(found) {
  const year = tokenNumber(found[1])
  const month = tokenNumber(found[2])
  const day = tokenNumber(found[3])
  if (year === null || month === null || day === null) return null
  return isoDate(year, month, day)
}

/**
 * 会议召开时间通常这么写；按优先级试，避免抓到正文里别的日期（股权登记日之类）。
 *
 * 同时覆盖 A 股（会议召开时间：2026 年 8 月 21 日）与港股（謹訂於二零二六年五月十三日舉行股東週年大會）。
 */
const MEETING_DATE_RES = [
  new RegExp('会议召开时间[^0-9' + CN_NUM_SRC + ']{0,12}(' + NUM_SRC + ')\\s*年\\s*(' + NUM_SRC + ')\\s*月\\s*(' + NUM_SRC + ')\\s*日'),
  // 「將於 2026 年 8 月 4 日召開董事會…」：動詞可能是舉行（開會）或召開。
  new RegExp('(?:将于|將於|谨订于|謹訂於|定于|定於|拟于|擬於)[^。；\\n]{0,30}?(' + NUM_SRC + ')\\s*年\\s*(' + NUM_SRC + ')\\s*月\\s*(' + NUM_SRC + ')\\s*日[^。；\\n]{0,40}?(?:举行|舉行|召开|召開)'),
  new RegExp('(?:现场|现场会议|网络|本次)?会议?(?:召开)?时间[^0-9' + CN_NUM_SRC + ']{0,12}(' + NUM_SRC + ')\\s*年\\s*(' + NUM_SRC + ')\\s*月\\s*(' + NUM_SRC + ')\\s*日'),
  new RegExp('(' + NUM_SRC + ')\\s*年\\s*(' + NUM_SRC + ')\\s*月\\s*(' + NUM_SRC + ')\\s*日[^。；\\n]{0,20}?(?:举行|舉行)(?:董事会会议|董事會會議|股东周年大会|股東週年大會|股东特别大会|股東特別大會|股东大会|股東大會|会议|會議)'),
]

const pad2 = (v) => String(v).padStart(2, '0')

/** 严格校验：格式对、且是真实存在的日期。 */
function isoDate(year, month, day) {
  const m = Number(month); const d = Number(day)
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
  const iso = String(year) + '-' + pad2(m) + '-' + pad2(d)
  const parsed = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso
}

/** 上游的各种日期串统一成合法的 YYYY-MM-DD，否则 null。 */
function dayOf(value) {
  const text = String(value === null || value === undefined ? '' : value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text + 'T00:00:00Z')) ? text : null
}

function addDays(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
}

/**
 * 从公告正文里提取会议召开日期。
 *
 * 提取不到、或日期明显不合常理（不在公告日之后的 120 天内）就返回 null——
 * **宁可漏掉一个事件，也不能编一个日期**。
 * @param content - 公告正文纯文本。
 * @param announcedAt - 公告日（YYYY-MM-DD）。
 * @returns 会议召开日期或 null。
 */
function meetingDateOf(content, announcedAt) {
  const text = String(content || '')
  for (const re of MEETING_DATE_RES) {
    const found = re.exec(text)
    if (found === null) continue
    const iso = isoFromMatch(found)
    if (iso === null) continue
    if (announcedAt !== null && (iso < announcedAt || iso > addDays(announcedAt, 120))) continue
    return iso
  }
  return null
}

/** 公告列表（A 股 ann_type=A，港股 ann_type=H，同一个接口）。 */
async function loadAnnouncements(code, size) {
  const json = await getJson(EM_ANNOUNCE + '?' + enc({
    sr: '-1', page_size: String(size), page_index: '1',
    ann_type: marketOf(code) === 'hk' ? 'H' : 'A',
    client_source: 'web', stock_list: code,
  }))
  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : []
  const out = []
  for (const it of list) {
    const announcedAt = dayOf(it.display_time) || dayOf(it.notice_date)
    const date = dayOf(it.notice_date) || announcedAt
    const artCode = String(it.art_code || '')
    if (date === null || announcedAt === null || artCode === '') continue
    out.push({
      date, announcedAt, artCode,
      // 标题形如「贵州茅台:贵州茅台关于召开…」，去掉公司名前缀更好读。
      title: String(it.title || '').replace(/^[^:：]{0,20}[:：]/, '').trim(),
    })
  }
  return out
}

/**
 * 公告类事件：逐条去公告正文里找日期。
 *
 * A 股：业绩说明会 / 股东大会的「会议召开时间」→ meeting。
 * 港股：「董事会会议召开日期」公告＝**提前公布的业绩日**，语义上就是港股版的预约披露，
 * 所以归类成 report，让 EVREP(n) 在港股同样可用；股东大会通告则归 meeting。
 */
async function loadAnnouncementEvents(code) {
  // 港股每天都有「翌日披露报表」，100 条常常盖不住一个月，所以取 200 条。
  const announcements = await loadAnnouncements(code, 200)
  const isHk = marketOf(code) === 'hk'
  const hits = announcements
    .filter((it) => {
      if (ANNOUNCE_EXCLUDE.test(it.title)) return false
      if (ANNOUNCE_TITLE.test(it.title) || BOARD_MEETING_TITLE.test(it.title)) return true
      // 业绩类公告只在港股拿来兜底：A 股的财报日有预约披露时间表，更权威。
      return isHk && RESULT_TITLE.test(it.title)
    })
    .slice(0, 8)
  // 公告正文的日期一旦确定就不会变，而正文接口最容易触发上游限流，
  // 所以按 art_code 缓存到磁盘：抓过一次就不再打扰上游。
  const cache = readAnnounceCache()
  const missing = hits.filter((it) => cache[it.artCode] === undefined)
  const { bodies, failures } = await loadAnnouncementBodies(missing)
  const fresh = new Map()
  for (let i = 0; i < missing.length; i++) {
    if (bodies[i] !== null) fresh.set(missing[i].artCode, bodies[i])
  }
  let cacheDirty = false
  const out = []
  for (let i = 0; i < hits.length; i++) {
    const cached = cache[hits[i].artCode]
    const body = fresh.get(hits[i].artCode)
    const content = body && body.data ? body.data.notice_content : null
    const title = hits[i].title
    const isBoard = BOARD_MEETING_TITLE.test(title)
    // 会议类优先：说明会 / 股东大会都带「召开」语义，别被标题里的「业绩」二字带偏。
    const isMeeting = ANNOUNCE_TITLE.test(title) && !isBoard
    // 命中缓存就不用再看正文了；没正文也没缓存时 extracted 为 null，走下面的兜底。
    const extracted = cached !== undefined ? cached.date : meetingDateOf(content, hits[i].announcedAt)
    if (cached === undefined && content !== null) {
      cache[hits[i].artCode] = { v: ANN_CACHE_VERSION, date: extracted, at: new Date().toISOString() }
      cacheDirty = true
    }
    let date = extracted
    let announcedAt = hits[i].announcedAt
    if (date === null) {
      // 正文里找不到日期（港股常见：公告正文只有一句「詳見附件」，日期在 PDF 里）。
      // 董事会会议日期公告就此作罢——宁可没有，也不能猜；
      // 业绩公告则可以退回**公告日**，并把 announcedAt 也设成公告日，
      // 于是它只对 n >= 0 生效，不会变成「提前知道业绩日」。
      if (isBoard || !isHk || !RESULT_TITLE.test(title)) continue
      date = hits[i].date
      announcedAt = hits[i].date
    }
    out.push({
      date,
      kind: isMeeting ? 'meeting' : 'report',
      title: isBoard ? '董事会会议（审批业绩）' : title,
      announcedAt,
      actual: null,
      source: extracted === null ? '公告日（正文未写明日期）' : '公告正文',
    })
  }
  if (cacheDirty) writeAnnounceCache(cache)
  // 正文拉不下来时不能装没事：调用方会把 failures 报给界面，
  // 否则用户只看到「事件变少了」，完全不知道是上游被限流。
  out.failures = failures
  return out
}

// ---------------- 公告正文解析结果缓存 ----------------
//
// 一条公告里写的会议日期是**不会变**的，而正文接口（np-cnotice-stock）最容易触发
// 上游限流（实测会直接 ECONNRESET）。所以按 art_code 把解析结果落盘缓存：
// 抓过一次就不再重复请求，上游抖动也不会让已有的事件凭空消失。
// 解析规则升级时把版本号 +1，旧缓存自动失效。

const ANNOUNCE_CACHE_FILE = 'announcements.json'
const ANN_CACHE_VERSION = 1
/** 正文接口失败后的静默期。 */
const BODY_BACKOFF_MS = 60000
/** 下次允许请求正文的时间戳；失败后退避，避免把限流越敲越久。 */
let bodyBlockedUntil = 0

/** 读缓存；版本不匹配的条目直接丢掉。 */
function readAnnounceCache() {
  const all = readState(ANNOUNCE_CACHE_FILE)
  if (all === null || typeof all !== 'object') return {}
  const out = {}
  for (const key of Object.keys(all)) {
    const item = all[key]
    if (item && item.v === ANN_CACHE_VERSION && typeof item.date !== 'undefined') out[key] = item
  }
  return out
}

/** 写缓存，只保留最近 800 条，避免文件无限增长。 */
function writeAnnounceCache(map) {
  const keys = Object.keys(map)
  if (keys.length > 800) {
    keys.sort((a, b) => String(map[a].at).localeCompare(String(map[b].at)))
    for (const key of keys.slice(0, keys.length - 800)) delete map[key]
  }
  writeState(ANNOUNCE_CACHE_FILE, map)
}

/**
 * 拉公告正文。
 *
 * 上游（np-cnotice-stock.eastmoney.com）对短时间内的密集请求会直接 **ECONNRESET**，
 * 所以这里小批量并发 + 失败重试一次 + 批间隔；仍然失败就把原因带出去。
 * @param hits - 公告条目（含 artCode 与 title）。
 * @returns { bodies, failures }；bodies 与 hits 等长，失败位置为 null。
 */
async function loadAnnouncementBodies(hits) {
  const bodies = new Array(hits.length).fill(null)
  const failures = []
  // 失败退避：上游一旦限流，每次切股票/刷新都再去敲一遍只会延长封禁，
  // 所以失败后 60 秒内不再请求正文，直接用兜底结果 + 说明。
  if (Date.now() < bodyBlockedUntil) {
    const wait = Math.ceil((bodyBlockedUntil - Date.now()) / 1000)
    for (const it of hits) failures.push(it.title.slice(0, 24) + '：正文接口暂缓请求（还有 ' + wait + ' 秒）')
    return { bodies, failures }
  }
  const BATCH = 3
  for (let start = 0; start < hits.length; start += BATCH) {
    const slice = hits.slice(start, start + BATCH)
    const results = await Promise.all(slice.map((it) => getJson(EM_ANNOUNCE_BODY + '?' + enc({
      art_code: it.artCode, client_source: 'web', page_index: '1',
    })).catch((error) => ({ __error: String((error && error.message) || error) }))))
    for (let i = 0; i < slice.length; i += 1) {
      const result = results[i]
      if (result && result.__error === undefined) bodies[start + i] = result
      else failures.push(slice[i].title.slice(0, 24) + '：' + String(result && result.__error))
    }
    if (start + BATCH < hits.length) await new Promise((resolve) => setTimeout(resolve, 120))
  }
  if (failures.length > 0) bodyBlockedUntil = Date.now() + BODY_BACKOFF_MS
  else bodyBlockedUntil = 0
  return { bodies, failures }
}

/**
 * 财报披露事件。
 *
 * 事件日取**预约披露日**而不是实际披露日：预约时间表是交易所期初就公布的，
 * 用它在回测里「提前埋伏」是合规的；用实际披露日则等于提前知道了财报哪天出。
 */
async function loadReportEvents(code) {
  if (marketOf(code) === 'hk') return []
  const json = await getJson(EM_FIN + '?' + enc({
    reportName: EM_APPOINT_REPORT,
    columns: 'SECURITY_CODE,REPORT_DATE,REPORT_TYPE_NAME,FIRST_APPOINT_DATE,APPOINT_PUBLISH_DATE,ACTUAL_PUBLISH_DATE',
    filter: '(SECURITY_CODE="' + code + '")',
    pageSize: '12', sortColumns: 'REPORT_DATE', sortTypes: '-1', source: 'WEB', client: 'WEB',
  }))
  const rows = json && json.result && Array.isArray(json.result.data) ? json.result.data : []
  const out = []
  for (const r of rows) {
    const date = dayOf(r.FIRST_APPOINT_DATE) || dayOf(r.APPOINT_PUBLISH_DATE)
    if (date === null) continue
    out.push({
      date, kind: 'report',
      title: String(r.REPORT_TYPE_NAME || '定期报告').trim() + '（预约披露日）',
      // 预约时间表期初公布，视为事先已知。
      announcedAt: null,
      actual: dayOf(r.ACTUAL_PUBLISH_DATE),
      source: '交易所预约披露时间表',
    })
  }
  return out
}

/** 除权除息日：实施公告提前公布，所以 announcedAt 用公告日。 */
async function loadExDivEvents(code) {
  if (marketOf(code) === 'hk') return []
  const json = await getJson(EM_FIN + '?' + enc({
    reportName: EM_BONUS_REPORT,
    columns: 'SECURITY_CODE,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,NOTICE_DATE,PLAN_NOTICE_DATE,IMPL_PLAN_PROFILE',
    filter: '(SECURITY_CODE="' + code + '")',
    pageSize: '12', sortColumns: 'REPORT_DATE', sortTypes: '-1', source: 'WEB', client: 'WEB',
  }))
  const rows = json && json.result && Array.isArray(json.result.data) ? json.result.data : []
  const out = []
  for (const r of rows) {
    const date = dayOf(r.EX_DIVIDEND_DATE)
    if (date === null) continue
    const announcedAt = dayOf(r.NOTICE_DATE) || dayOf(r.PLAN_NOTICE_DATE)
    out.push({
      date, kind: 'exdiv', title: '除权除息日',
      announcedAt: announcedAt !== null && announcedAt <= date ? announcedAt : null,
      actual: null,
      source: announcedAt === null ? '分红送配（公告日未知）' : '分红实施公告',
    })
  }
  return out
}

/** 事件列表的进程内缓存：同一只股票 30 分钟内不重复打上游（正文要逐条拉，比较贵）。 */
const eventCache = new Map()

/**
 * 取一只股票的真实事件日期。
 * @param code - 六位 A 股 / 五位港股代码。
 * @returns { code, market, events, counts, fetchedAt }；events 按日期倒序。
 */
async function loadEvents(code) {
  const symbol = symOf(code)
  if (symbol === '') throw new Error('无效的股票代码：' + code)
  const cached = eventCache.get(code)
  if (cached !== undefined && Date.now() - cached.at < 30 * 60 * 1000) return cached.value
  // 三类事件各自尽力：某一路失败不该让整页事件都没了——但**失败原因要留下来**，
  // 否则用户只会看到「没取到事件」，完全不知道是数据源挂了还是这只股票本来就没有。
  const errors = []
  const settle = (label, promise) => promise.catch((error) => {
    errors.push(label + '：' + String((error && error.message) || error))
    return []
  })
  const [meetings, reports, exdivs] = await Promise.all([
    settle('公告事件', loadAnnouncementEvents(code)),
    settle('财报预约披露', loadReportEvents(code)),
    settle('除权除息', loadExDivEvents(code)),
  ])
  // 逐条正文的抓取失败也在 meetings.failures 里，一并报出去。
  if (Array.isArray(meetings.failures)) {
    for (const item of meetings.failures) errors.push('公告正文抓取失败：' + item)
  }
  const seen = new Set()
  const events = []
  const reportAt = new Map()
  // 交易所事件与「自定义事件」一起返回，但类型独立、来源与可信度分列显示。
  for (const ev of meetings.concat(reports, exdivs, customEventsOf(code))) {
    // 财报事件按「类型+日期」去重：同一天既有提前公布的董事会会议日期、又有当天发的
    // 业绩公告时，只留**提前公告**的那条——那才是回测里能用的信息。
    if (ev.kind === 'report') {
      const key = ev.kind + '|' + ev.date
      const previous = reportAt.get(key)
      if (previous !== undefined) {
        // 保留**更早公布**的那条：同一天既有业绩公告、又有更早的「将于某日召开董事会」
        // 预告时，后者才让 EVREP(-1) 这种提前量变得合规。
        const better = previous.announcedAt === null
          ? ev.announcedAt !== null
          : (ev.announcedAt !== null && ev.announcedAt < previous.announcedAt)
        if (better) {
          events[events.indexOf(previous)] = ev
          reportAt.set(key, ev)
        }
        continue
      }
      reportAt.set(key, ev)
      events.push(ev)
      continue
    }
    const key = ev.kind + '|' + ev.date + '|' + ev.title
    if (seen.has(key)) continue
    seen.add(key)
    events.push(ev)
  }
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const counts = { meeting: 0, report: 0, exdiv: 0, custom: 0 }
  for (const ev of events) counts[ev.kind] += 1
  // 取数出错时**不进缓存**：否则一次限流会把「缺了会议事件」的结果锁住 30 分钟，
  // 上游恢复了用户也看不到——这正是「等一下再试」应该能解决的事。
  const value = {
    code, market: marketOf(code), events, counts, errors,
    note: (() => {
      if (errors.length > 0) return '部分事件没取到：' + errors.slice(0, 2).join('；')
      if (events.length > 0) return ''
      return marketOf(code) === 'hk'
        ? '港股事件来自港交所公告：只识别「董事会会议召开日期」（提前公布的业绩日）与股东大会通告；最近 200 条公告里没有这类文件时就是空的。'
        : '这批公告里没有可用的会议日期。'
    })(),
    fetchedAt: new Date().toISOString(),
  }
  if (errors.length === 0) eventCache.set(code, { at: Date.now(), value })
  return value
}

// ---------------- 自定义事件（AI 检索 / 手工添加） ----------------
//
// 交易所数据里没有的日期（产品发布会、行业展会之类）不能靠编，但可以让 AI 联网查、
// 再由**用户确认**后加入。自定义事件与交易所事件严格分开：
//   - 用独立的事件类型 custom，只由 EVCUS(n) 引用，不会悄悄改变 EV/EVMEET 的语义；
//   - 表里标成「未核实」并带上来源链接；
//   - 公告日未知时按「事先已知」处理，这一点必须让用户看见——那是个建模假设。

const CUSTOM_EVENTS_FILE = 'events.json'

/** 只接受形状合法、日期真实的条目；宁可少，不可编。 */
function normalizeCustomEvents(items) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const date = dayOf(item && item.date)
    if (date === null) continue
    const title = String((item && item.title) || '自定义事件').trim().slice(0, 80)
    const key = date + '|' + title
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      date,
      title,
      // 能查到公告日就存下来；查不到就留空（= 按事先已知处理，界面会标注）。
      announcedAt: dayOf(item && item.announcedAt),
      source: String((item && item.source) || '').trim().slice(0, 300),
      evidence: String((item && item.evidence) || '').trim().slice(0, 300),
      addedBy: (item && item.addedBy) === 'manual' ? 'manual' : 'ai',
      addedAt: new Date().toISOString(),
    })
    if (out.length >= 40) break
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function readCustomEvents(code) {
  const all = readState(CUSTOM_EVENTS_FILE)
  const list = all && Array.isArray(all[code]) ? all[code] : []
  return list.filter((it) => dayOf(it && it.date) !== null)
}

function writeCustomEvents(code, items) {
  const all = readState(CUSTOM_EVENTS_FILE)
  const next = all && typeof all === 'object' ? Object.assign({}, all) : {}
  if (items.length === 0) delete next[code]
  else next[code] = items
  writeState(CUSTOM_EVENTS_FILE, next)
  // 事件列表有进程内缓存，自定义事件一变就得让它失效。
  eventCache.clear()
  return readCustomEvents(code)
}

/** 把自定义事件统一成与交易所事件同构的条目（但类型独立、明确标注未核实）。 */
function customEventsOf(code) {
  return readCustomEvents(code).map((it) => ({
    date: it.date,
    kind: 'custom',
    title: it.title,
    announcedAt: it.announcedAt || null,
    actual: null,
    source: it.addedBy === 'ai' ? 'AI 联网检索（未核实）' : '手工添加（未核实）',
    url: it.source || '',
    evidence: it.evidence || '',
    verified: false,
  }))
}

// ---------------- 联网查证（AI 生成策略时用） ----------------

/** 给模型的工具：搜索与抓网页。 */
const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: '用搜索引擎查资料。用于查证某只股票的真实事件日期（业绩说明会、股东大会、产品发布会、财报披露等）。一次可给多个查询词。',
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: '1-4 个搜索词，例如「贵州茅台 2026 半年度业绩说明会 召开时间」',
      },
    },
    required: ['queries'],
    additionalProperties: false,
  },
}
const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description: '抓取一个网页的正文，用来确认公告或新闻里写的具体日期。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '完整 URL（http/https）' } },
    required: ['url'],
    additionalProperties: false,
  },
}
const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]

/** 搜索结果压成模型能读的短文本。 */
function searchDigest(result) {
  const lines = []
  const content = result && typeof result.content === 'string' ? result.content.trim() : ''
  if (content !== '') lines.push(content.slice(0, 2000))
  const sources = result && Array.isArray(result.sources) ? result.sources : []
  for (const src of sources.slice(0, 8)) {
    lines.push('- ' + String(src.title || src.url || '')
      + '\n  ' + String(src.url || '')
      + (src.publishedAt ? '（' + src.publishedAt + '）' : '')
      + (src.snippet ? '\n  ' + String(src.snippet).replace(/\s+/g, ' ').slice(0, 400) : ''))
  }
  return lines.length === 0 ? '（没有结果）' : lines.join('\n')
}

/** 网页正文去掉标签，只留可读文本。 */
function fetchDigest(result) {
  const body = result && result.body ? String(result.body.content || '') : ''
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 4000)
}

/**
 * 执行一次模型请求的工具调用。
 * @param web - ctx.get('web')。
 * @param call - { name, args }。
 * @returns { text, isError, requests }；工具失败也交回给模型，让它自己决定下一步。
 */
async function runWebTool(web, call) {
  let args = {}
  try {
    args = JSON.parse(call.args === '' ? '{}' : call.args)
  } catch {
    return { text: '参数不是合法 JSON：' + String(call.args).slice(0, 200), isError: true }
  }
  try {
    if (call.name === 'web_search') {
      const queries = Array.isArray(args.queries)
        ? args.queries.filter((q) => typeof q === 'string' && q.trim() !== '').slice(0, 4)
        : []
      if (queries.length === 0) return { text: '没有给出查询词', isError: true }
      const parts = []
      for (const query of queries) {
        const result = await web.search({ query, maxResults: 6 })
        parts.push('查询：' + query + '\n' + searchDigest(result))
      }
      // requests 用于回报「一共联网查了几次」，一个查询算一次。
      return { text: parts.join('\n\n'), isError: false, requests: queries.length }
    }
    if (call.name === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\//.test(url)) return { text: '需要一个 http(s) URL', isError: true }
      const result = await web.fetch({ url })
      return { text: 'HTTP ' + String(result.statusCode) + '\n' + fetchDigest(result), isError: false, requests: 1 }
    }
    return { text: '未知工具：' + String(call.name), isError: true }
  } catch (error) {
    return { text: '工具执行失败：' + String((error && error.message) || error), isError: true }
  }
}

/**
 * 跑一轮模型调用，把文本与工具调用都收齐。
 *
 * 工具调用是**流式分片**给出的：同一 index 的分片要自己拼成一条完整调用，
 * 否则拿到的是半截 JSON。
 * @param llm - ctx.get('llm')。
 * @param options - GenerateOptions。
 * @returns { text, reasoningChars, usage, finish, calls }。
 */
async function streamOnce(llm, options) {
  let text = ''
  let reasoningChars = 0
  let usage = null
  let finish = null
  const calls = new Map()
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'tool-call-delta') {
      const current = calls.get(chunk.index) || { id: '', name: '', args: '' }
      if (chunk.id) current.id = String(chunk.id)
      if (chunk.name) current.name = chunk.name
      current.args += chunk.argumentsDelta || ''
      calls.set(chunk.index, current)
    }
  }
  return {
    text, reasoningChars, usage, finish,
    calls: [...calls.values()].filter((c) => c.name !== '' && c.id !== ''),
  }
}

/**
 * 从模型输出里取出「候选事件」区块。
 *
 * 这些日期要先经用户确认才生效，所以这里只做**形状校验**：日期不合法就丢掉，
 * 绝不替模型补一个。
 * @param text - 模型最终输出的全文。
 * @returns 候选事件数组。
 */
function extractEventsBlock(text) {
  const fenced = /```events\s*([\s\S]*?)```/i.exec(String(text || ''))
  if (fenced === null) return []
  let raw = null
  try {
    raw = JSON.parse(fenced[1].trim())
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const date = dayOf(item && item.date)
    if (date === null) continue
    const title = String((item && item.title) || '事件').trim().slice(0, 80)
    const key = date + '|' + title
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      date,
      title,
      announcedAt: dayOf(item && item.announcedAt),
      source: String((item && item.source) || '').trim().slice(0, 300),
      evidence: String((item && item.evidence) || '').trim().slice(0, 300),
    })
    if (out.length >= 12) break
  }
  return out
}

// ---------------- 本地状态持久化 ----------------

/**
 * 插件状态目录，按优先级：$DSH_ASTOCK_HOME > $DSH_HOME/astock > ~/.dsh/astock。
 * @returns 目录绝对路径（可能尚不存在）。
 */
function stateDir() {
  const override = typeof process.env.DSH_ASTOCK_HOME === 'string' ? process.env.DSH_ASTOCK_HOME.trim() : ''
  if (override !== '') return override
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
  return join(home, 'astock')
}

/**
 * 写一个 JSON 状态文件；目录不存在时递归创建。
 * @param filename - 状态目录下的文件名。
 * @param value - 可序列化的值。
 */
function writeState(filename, value) {
  const path = join(stateDir(), filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  return path
}

/**
 * 读一个 JSON 状态文件，缺失或损坏时返回 undefined。
 * @param filename - 状态目录下的文件名。
 * @returns 解析后的值，或 undefined。
 */
function readState(filename) {
  try {
    return JSON.parse(readFileSync(join(stateDir(), filename), 'utf8'))
  } catch {
    return undefined
  }
}

/** 自选股 JSON 的绝对路径。 */
function watchlistPath() {
  return join(stateDir(), 'watchlist.json')
}

function readWatchlist() {
  const parsed = readState('watchlist.json')
  return Array.isArray(parsed) ? parsed : []
}

function writeWatchlist(items) {
  const cleaned = []
  for (const item of items) {
    if (!item) continue
    const code = String(item.code || '')
    // 用 marketOf 判定，A 股 6 位与港股 5 位都要留下。
    // （早先这里写死 6 位，导致港股能显示但保存时被静默丢弃。）
    const market = marketOf(code)
    if (market === '') continue
    cleaned.push({ code, name: String(item.name || code), market })
  }
  writeState('watchlist.json', cleaned)
  return cleaned
}

// ---------------- 免责声明 ----------------

/**
 * 免责声明的版本号。
 *
 * 落盘记录的是「用户接受了哪个版本」；条款有实质修改时递增此值，
 * 已确认过的用户会被重新要求确认一次。
 */
const DISCLAIMER_VERSION = '1'

const DISCLAIMER_TITLE = '免责声明与使用条款'

const DISCLAIMER_PARAGRAPHS = [
  '1. 本插件仅用于技术学习与量化研究，不构成任何投资建议、要约或收益承诺。插件不提供选股推荐、买卖时机提示，也不代客理财。任何据此做出的投资决策由使用者自行判断并承担全部后果。',
  '2. 行情、K线、财务等数据均来自第三方公开接口，可能存在错误、延迟、缺失或因接口变更而中断。插件不对数据的准确性、完整性、及时性作任何保证。港股数据来自腾讯且未经复权，除权除息日会出现价格跳空。',
  '3. 回测基于历史数据，不能代表未来表现。结果受策略过拟合、幸存者偏差、参数与区间选择等影响；交易成本、滑点、涨跌停与流动性均为近似模型，与真实成交存在差异。历史收益不预示未来收益。',
  '4. 由 AI 生成的策略代码仅供参考，未经审核，可能存在逻辑错误或隐含风险，请务必自行阅读并验证后再使用。',
  '5. 使用者应自行核实数据与结果，并自行承担使用本插件所产生的任何直接或间接损失。插件作者不对任何投资损失承担责任。',
  '6. 请遵守所在地区法律法规及所使用数据源的服务条款，禁止将本插件用于内幕交易、市场操纵等违法用途。',
]

/** 常驻页脚用的精简版。 */
const DISCLAIMER_SHORT = '本工具仅用于研究与学习，不构成投资建议。数据来自第三方，回测不代表未来收益，据此操作风险自负。'

function readDisclaimer() {
  const state = readState('disclaimer.json')
  return {
    version: DISCLAIMER_VERSION,
    title: DISCLAIMER_TITLE,
    paragraphs: DISCLAIMER_PARAGRAPHS,
    short: DISCLAIMER_SHORT,
    accepted: Boolean(state) && state.version === DISCLAIMER_VERSION,
    acceptedAt: state && typeof state.acceptedAt === 'string' ? state.acceptedAt : null,
  }
}

function acceptDisclaimer() {
  // 用 UTC 时间戳，避免本地时区在不同机器上产生歧义。
  const acceptedAt = new Date().toISOString()
  writeState('disclaimer.json', { version: DISCLAIMER_VERSION, acceptedAt })
  return readDisclaimer()
}

// ---------------- AI 生成策略 ----------------

/**
 * 生成策略代码的系统提示。
 *
 * 这段话是功能的成败关键：模型必须精确知道可用函数、返回契约，以及
 * 「只产生信号、不模拟资金」这条分工——否则它会写出自己算收益的代码。
 */
const STRATEGY_SYSTEM_PROMPT = [
  '你是量化策略代码生成器。只输出 JavaScript 代码本身，不要解释、不要 Markdown 代码块标记。',
  '',
  '生成的代码是一个函数体，会被 new Function 执行，必须 return { buy, sell } 两个数组。',
  '',
  '可用的入参（都是与 K 线等长的数组，索引 i 从 0 到 C.length - 1）：',
  '- C O H L V：收盘 / 开盘 / 最高 / 最低 / 成交量',
  '- N：K 线总根数',
  '',
  '可用的函数（都返回等长数组；预热期不足周期的元素是 null）：',
  '- MA(x, n) 简单均线，也可写 MA(n) 表示 MA(C, n)',
  '- EMA(x, n) 指数移动平均',
  '- SUM(x, n) 区间求和；STD(x, n) 区间标准差',
  '- HHV(x, n) 区间最高（省略 x 用最高价）；LLV(x, n) 区间最低（省略 x 用最低价）',
  '- REF(x, n) n 根之前的取值',
  '- RSI(n) 相对强弱指标，n 默认 14',
  '- DIF() DEA() MACD() 标准 MACD 三线',
  '- BOLL_UP(p, k) BOLL_MID(p) BOLL_LOW(p, k) 布林带，k 默认 2',
  '- CROSS(a, b) a 上穿 b 时为 1，否则 0',
  '- GT(a, b) LT(a, b) GTE(a, b) LTE(a, b) 逐元素比较，返回 1/0（null 当 0）',
  '- AND(a, b) OR(a, b) NOT(a) 逐元素逻辑运算',
  '- ABS(x) MAX(a, b) MIN(a, b)',
  '- EV(n) EVMEET(n) EVREP(n) EVDIV(n) EVCUS(n) 事件因子：相对真实事件的第 n 个交易日为 1，',
  '  其余为 0；n 可以为负（-1 = 事件前一个交易日），0 = 事件当日。',
  '  EVMEET=说明会/股东大会，EVREP=财报预约披露，EVDIV=除权除息，EVCUS=用户确认的自定义事件，',
  '  EV=全部。事件日期与交易日换算都由系统提供，你只写 n。',
  '',
  '硬性要求：',
  '1. buy 与 sell 都必须是长度严格等于 C.length 的数组，元素是真值/假值。',
  '2. buy[i] 为真表示「第 i 根收盘后想买入」，回测引擎会在第 i+1 根开盘成交；sell 同理。',
  '3. 不要自己模拟资金、股数、手续费或收益——引擎负责这些，你只负责产生信号。',
  '4. 引擎已强制 T+1 与涨跌停限制，你不需要处理。',
  '5. 不要使用 console、setTimeout、fetch 或任何网络/IO，只用纯计算。',
  '6. 需要持仓状态（例如最短持有天数）时可以写 for 循环和变量；否则优先用向量化写法。',
  '7. 代码要能独立运行，不要引用任何未在上面列出的变量或函数。',
  '8. 每一条买卖条件都必须用 GT/LT/GTE/LTE/CROSS 加 AND/OR/NOT 组合表达，禁止直接写 C[i] > MA(C, 20)[i] 这种原生比较。'
    + '原因：系统要按这些条件函数自动拆出「信号日哪一条成立、两边数值各是多少」当作交易明细里的证据，原生比较会让用户看不到依据。',
  '9. 最后必须额外 return 一个 why 函数，用中文说明该 bar 为什么买卖：',
  '   function why(i, side) { return side === "buy" ? "……为什么买……" : "……为什么卖……" }',
  '   它会原样展示在交易明细最前面。要写明用到的是哪几个具体条件，不要写「符合策略」这类空话。',
  '10. 需要「某事件前/后第几个交易日」这类逻辑时，只能用 EV / EVMEET / EVREP / EVDIV 配合真实事件日期，',
  '    绝不允许自己编造日期、按自然日加减、或在代码里写死具体日期字符串。',
  '    如果用户说的那种事件在提供的真实事件列表里没有，就用最接近的事件，并在 why 里说明用的是哪一个。',
].join('\n')

/** 从模型输出里剥掉可能的 Markdown 代码块围栏。 */
/** 联网查证最多跑几轮工具调用；最后一轮不给工具，逼模型落笔写代码。 */
const MAX_TOOL_ROUNDS = 4

/**
 * 有联网能力时追加给模型的说明。
 *
 * 关键约束：查到的日期必须写进 events 区块、并且**先给用户确认**才生效；
 * 查不到就明说查不到，绝不允许推算或猜测。
 */
const RESEARCH_ADDENDUM = [
  '',
  '【联网查证】你可以调用 web_search（必要时 web_fetch）核对真实资料，尤其是：',
  '- 该公司业绩说明会 / 股东大会 / 产品发布会的具体召开日期；',
  '- 财报的披露日期。',
  '宿主已经给过你一份「真实事件日期」列表——那是权威数据，优先直接用；',
  '只有列表里没有、而用户又明确要求的事件，才需要联网查证。',
  '查到之后，除了代码之外还必须输出一个 events 区块，列出候选日期：',
  '```events',
  '[{"date":"2026-09-09","title":"秋季新品发布会","announcedAt":"2026-08-01","source":"https://…","evidence":"原文写明 9 月 9 日召开"}]',
  '```',
  '- date 必须是 YYYY-MM-DD，且来自你查到的原文；**不允许推算、不允许猜**，查不到就不要写这条。',
  '- announcedAt 填该消息首次公开的日期（有就填，没有就省略）。',
  '- evidence 填原文摘录，source 填来源链接。',
  '这些日期会先给用户确认，确认后才作为自定义事件参与回测；',
  '策略里引用它们必须用 EVCUS(n)（相对第 n 个交易日），不要写死日期字符串。',
].join('\n')

/** 从模型输出里剥掉可能的 Markdown 代码块围栏。 */
function extractCode(text) {
  const fenced = /```(?:javascript|js)?\s*\n?([\s\S]*?)```/.exec(text)
  return (fenced === null ? String(text) : fenced[1]).trim()
}

/**
 * 把真实事件日期整理成给模型看的上下文。
 *
 * 模型自己算不出「哪天是交易日」，也不该去猜发布会日期；这里直接把它能用的
 * 真实日期与表达方式讲清楚，交易日换算交给引擎。
 * @param payload - loadEvents() 的结果。
 * @param displayName - 股票显示名。
 * @returns 注入提示词的文本块（没有事件时返回空串）。
 */
function eventBrief(payload, displayName) {
  const events = payload && Array.isArray(payload.events) ? payload.events : []
  if (events.length === 0) return ''
  const kindName = { meeting: '说明会/股东大会', report: '财报预约披露', exdiv: '除权除息' }
  const lines = events.slice(0, 24).map((ev) => (
    '- ' + ev.date + '  ' + (kindName[ev.kind] || ev.kind) + '  ' + ev.title
    + (ev.announcedAt ? '（' + ev.announcedAt + ' 公告，事件前就已公开）' : '（事先已公开）')
    + (ev.actual && ev.actual !== ev.date ? '，实际披露 ' + ev.actual : '')
  ))
  return [
    '【真实事件日期】以下日期来自交易所公告与预约披露时间表，是该股可引用的全部真实事件'
      + '（' + (displayName || payload.code) + '，共 ' + events.length + ' 条，按时间倒序）：',
    lines.join('\n'),
    '【事件因子的写法】条件里可以直接用这四个函数，它们返回与 K 线等长的 1/0 序列：',
    '- EV(n)        全部事件',
    '- EVMEET(n)    说明会 / 股东大会 / 路演',
    '- EVREP(n)     财报预约披露',
    '- EVDIV(n)     除权除息',
    'n 是**相对该事件的第 n 个交易日**：-1 = 事件前一个交易日，0 = 事件当日，2 = 事件后第二个交易日。',
    '事件当天不是交易日时按之后第一个交易日计算。「哪天是交易日」由引擎按真实 K 线换算，',
    '**你不要自己推算日历日期、也不要按自然日加减**，只写 n 就行。',
    '例：EVMEET(-1) 表示「说明会前一个交易日」，EVMEET(2) 表示「说明会后第二个交易日」。',
    '只有在事件事先公开过时才允许提前触发：说明会、财报预约披露、除权除息都满足这一条。',
    '如果用户要求的日期不在上面的列表里，**不要编造日期**，就用最接近的已有事件，',
    '并在 why 里写清用的是哪个事件。',
  ].join('\n')
}

/**
 * 没有事件数据时给模型的说明。
 *
 * 不说清楚的话，模型会凭常识写 `EVMEET(-1)`，用户拿到一个一跑就报错的策略。
 * @param code - 股票代码。
 * @param name - 股票显示名。
 * @param payload - loadEvents() 的结果（或只带 note 的简化对象）。
 * @returns 注入提示词的文本块。
 */
function noEventNotice(code, name, payload) {
  const errors = payload && Array.isArray(payload.errors) ? payload.errors.filter((x) => x !== '') : []
  return [
    '【重要：这只股票当前没有可用的事件数据】' + (name ? name + '（' + code + '）' : code),
    payload && payload.note ? '原因：' + payload.note : '',
    errors.length > 0 ? '取数报错：' + errors.join('；') : '',
    '因此：',
    '- **禁止**使用 EV / EVMEET / EVREP / EVDIV —— 它们依赖交易所事件数据，现在没有，用了必然报错。',
    '- 如果你能通过联网查证得到真实日期，可以输出 events 区块并改用 EVCUS(n)（用户确认后才生效）。',
    '- 如果查不到、而用户的需求又必须依赖事件日期，就生成一个**不依赖事件**的替代策略，',
    '  并在 why 里说明「缺少事件数据，改用……」。不要假装事件数据存在。',
  ].filter((line) => line !== '').join('\n')
}

/**
 * 调用宿主模型生成策略代码。
 * @param ctx - 插件上下文。
 * @param description - 用户对策略的自然语言描述。
 * @param currentCode - 现有策略代码，供模型在其基础上修改；无则留空。
 * @param eventContext - 真实事件日期上下文（eventBrief() 的结果）；无则留空。
 * @param eventCount - 交给模型的真实事件条数，原样回报给客户端。
 * @returns 生成的代码、所用模型与用量。
 */
async function generateStrategy(ctx, description, currentCode, eventContext, eventCount) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('宿主未挂载 llm 服务，无法调用模型')
  const picker = ctx.get('agentDefaultModel')
  const selection = picker === undefined ? undefined : picker.currentSelection()
  const provider = selection && selection.provider ? String(selection.provider) : ''
  const model = selection && selection.model ? String(selection.model) : ''
  if (provider === '' || model === '') {
    throw new Error('没有可用的默认模型，请先在设置的「模型」里选一个')
  }

  const parts = []
  if (typeof currentCode === 'string' && currentCode.trim() !== '') {
    parts.push('现有策略代码（请在此基础上按下面的需求修改）：\n' + currentCode.trim())
    parts.push('修改需求：' + description)
  } else {
    parts.push('策略需求：' + description)
  }
  if (typeof eventContext === 'string' && eventContext !== '') parts.push(eventContext)

  // 联网查证：宿主挂了 web 服务就让模型自己搜（它查不到的东西，谁也算不出来）；
  // 没有就直接生成——降级要静默，但要在返回值里说清楚「这次没联网」。
  const web = ctx.get('web')
  const canSearch = web !== undefined && typeof web.search === 'function'
  let searchError = ''
  if (!canSearch) searchError = '宿主未挂载 web 服务，本次没有联网查证'

  const messageId = (() => {
    let n = 0
    return () => 'astock-msg-' + Date.now().toString(36) + '-' + (n += 1)
  })()
  const history = [{
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text: parts.join('\n\n') }],
    source: { kind: 'plugin', plugin: 'astock' },
  }]

  const base = {
    provider,
    model,
    system: canSearch ? STRATEGY_SYSTEM_PROMPT + RESEARCH_ADDENDUM : STRATEGY_SYSTEM_PROMPT,
    temperature: 0.2,
    // 思考 token 与输出 token 共用 maxTokens 这一个预算，所以上限必须给足。
    //
    // 实测（deepseek-flash，默认选型带 reasoningEffort=high）：
    //   maxTokens 2048 -> 思考吃掉全部 2048，text-delta 为 0，finish=max-tokens
    //   maxTokens 8192 -> 思考 4190 + 正文 2261，正常结束
    // 上限只是天花板、按实际用量计费，因此这里给足余量，并且**不再强制
    // reasoningEffort**——生成一段策略代码不需要高思考强度，硬调高只会挤占正文。
    maxTokens: 16384,
  }

  let text = ''
  let reasoningChars = 0
  let usage = null
  let finish = null
  let searches = 0
  const inputSum = { input: 0, output: 0, seen: false }
  const addUsage = (u) => {
    if (u === null || u === undefined) return
    inputSum.seen = true
    inputSum.input += typeof u.inputTokens === 'number' ? u.inputTokens : 0
    inputSum.output += typeof u.outputTokens === 'number' ? u.outputTokens : 0
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // 最后一轮不给工具：否则模型可以一直搜下去，永远不落笔写代码。
    const allowTools = canSearch && round < MAX_TOOL_ROUNDS - 1
    const options = Object.assign({}, base, {
      messages: history,
      ...(allowTools ? { tools: WEB_TOOLS } : {}),
    })
    const step = await streamOnce(llm, options)
    text = step.text
    reasoningChars = step.reasoningChars
    usage = step.usage
    finish = step.finish
    addUsage(step.usage)
    if (finish !== null && finish.kind === 'error') {
      const failure = finish.failure
      throw new Error('模型调用失败：' + String((failure && failure.message) || '未知原因'))
    }
    if (finish !== null && finish.kind === 'aborted') throw new Error('模型调用被中断')
    if (step.calls.length === 0 || !allowTools) break

    // 把「模型要调用工具」与「工具的结果」都写回历史，下一轮它才看得到。
    history.push({
      id: messageId(),
      role: 'assistant',
      content: step.calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.args })),
      source: { kind: 'model', provider, model },
    })
    for (const call of step.calls) {
      const result = await runWebTool(web, call)
      searches += typeof result.requests === 'number' ? result.requests : 0
      if (result.isError && searchError === '') searchError = result.text
      history.push({
        id: messageId(),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: call.id,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError,
        }],
        source: { kind: 'tool', callId: call.id },
      })
    }
  }

  // events 区块要先摘掉：它也是围栏代码块，留着会被当成策略代码。
  const suggestedEvents = extractEventsBlock(text)
  const code = extractCode(text.replace(/```events[\s\S]*?```/gi, ''))
  if (code === '') {
    // 说清「为什么没有内容」，而不是一句无信息量的「没有返回任何内容」。
    const used = usage && typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : null
    const why = finish !== null && finish.kind === 'max-tokens'
      ? '模型把输出预算全用在思考上，还没开始写代码就被截断了（思考 '
        + (used === null ? '未知' : used) + ' tokens，上限 ' + base.maxTokens
        + '）。请重试，或把默认模型的思考强度调低。'
      : finish !== null
        ? '模型以 ' + finish.kind + ' 结束，没有产出代码'
        : '流意外结束，没有产出代码'
    throw new Error('模型没有返回任何内容：' + why
      + (reasoningChars > 0 ? '（本次思考了 ' + reasoningChars + ' 个字符）' : ''))
  }
  return {
    code,
    provider,
    model,
    stopReason: 'ok',
    // 交给模型的真实事件条数：客户端据此告诉用户「模型到底有没有拿到真实日期」。
    events: typeof eventCount === 'number' && eventCount > 0 ? eventCount : 0,
    // 联网查证的情况：搜了几次、有没有查到候选事件、以及是否降级了。
    searched: searches > 0,
    searches,
    searchError,
    suggestedEvents,
    usage: inputSum.seen
      ? { inputTokens: inputSum.input, outputTokens: inputSum.output }
      : (usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
  }
}

// ---------------- 测试钩子 ----------------
//
// 这几个纯函数没法只靠打真实接口来验证（比如中文数字日期、候选事件的校验），
// 而复制一份到测试里又会和实现一起漂移。所以按「测已部署的那份代码」的原则导出，
// 仅供 tests/host.test.mjs 直接调用，不是插件的公开 API。
export const __test = {
  cnNumber,
  tokenNumber,
  meetingDateOf,
  isoFromDay,
  extractEventsBlock,
  eventBrief,
  noEventNotice,
}

// ---------------- HTTP 管道 ----------------

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * 注册本插件的全部路由。
 * @param ctx - 已注入 webServer 的 Cordis 上下文。
 */
export function apply(ctx) {
  const route = (path, handle) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const query = Object.fromEntries(url.searchParams.entries())
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          sendJson(res, 200, await handle(query, body))
        } catch (error) {
          sendJson(res, 500, { error: String((error && error.message) || error) })
        }
      },
    }), 'astock:route:' + path)
  }

  route('/astock/api/health', async () => ({
    ok: true,
    plugin: name,
    watchlistPath: watchlistPath(),
    watchlistCount: readWatchlist().length,
    customEventsPath: join(stateDir(), CUSTOM_EVENTS_FILE),
    // 有没有联网查证能力：AI 生成时能不能自己搜资料，就看这一条。
    webSearch: ctx.get('web') !== undefined,
  }))
  route('/astock/api/search', async (query) => loadSearch(String(query.q || '')))
  route('/astock/api/kline', async (query) => loadKline(query))
  route('/astock/api/quote', async (query) => loadQuote(String(query.code || '')))
  route('/astock/api/financials', async (query) => loadFinancials(String(query.code || '')))
  route('/astock/api/watchlist', async (_query, body) => {
    if (body && Array.isArray(body.items)) return { items: writeWatchlist(body.items) }
    return { items: readWatchlist() }
  })
  route('/astock/api/disclaimer', async (_query, body) => {
    if (body && body.accept === true) return acceptDisclaimer()
    return readDisclaimer()
  })
  route('/astock/api/events', async (query) => loadEvents(String(query.code || '')))
  route('/astock/api/custom-events', async (_query, body) => {
    const code = String((body && body.code) || '').trim()
    if (symOf(code) === '') throw new Error('无效的股票代码：' + code)
    // 传了 items 就是覆盖式保存（客户端先读出当前列表、改完再整体提交）。
    if (body && Array.isArray(body.items)) {
      writeCustomEvents(code, normalizeCustomEvents(body.items))
    }
    return loadEvents(code)
  })
  route('/astock/api/generate-strategy', async (_query, body) => {
    const description = String((body && body.description) || '').trim()
    if (description === '') throw new Error('请先用一句话描述你想要的策略')
    const currentCode = typeof (body && body.currentCode) === 'string' ? body.currentCode : ''
    // 有股票代码就把该股的真实事件日期一并交给模型：不然它只能编日期。
    const code = String((body && body.code) || '').trim()
    let eventContext = ''
    let eventCount = 0
    if (code !== '') {
      const name = String((body && body.name) || '')
      try {
        const payload = await loadEvents(code)
        eventCount = payload.events.length
        if (eventCount > 0) eventContext = eventBrief(payload, name)
        // 没有事件数据时必须**明确告诉模型**，否则它会照着自己的知识写事件因子，
        // 生成的策略一跑就报「需要公司事件数据」——用户上次遇到的就是这个。
        else eventContext = noEventNotice(code, name, payload)
      } catch (error) {
        eventContext = noEventNotice(code, String((body && body.name) || ''), {
          note: String((error && error.message) || error), errors: [],
        })
      }
    }
    return generateStrategy(ctx, description, currentCode, eventContext, eventCount)
  })
}
