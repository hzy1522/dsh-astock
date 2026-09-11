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
  '',
  '硬性要求：',
  '1. buy 与 sell 都必须是长度严格等于 C.length 的数组，元素是真值/假值。',
  '2. buy[i] 为真表示「第 i 根收盘后想买入」，回测引擎会在第 i+1 根开盘成交；sell 同理。',
  '3. 不要自己模拟资金、股数、手续费或收益——引擎负责这些，你只负责产生信号。',
  '4. 引擎已强制 T+1 与涨跌停限制，你不需要处理。',
  '5. 不要使用 console、setTimeout、fetch 或任何网络/IO，只用纯计算。',
  '6. 需要持仓状态（例如最短持有天数）时可以写 for 循环和变量；否则优先用向量化写法。',
  '7. 代码要能独立运行，不要引用任何未在上面列出的变量或函数。',
].join('\n')

/** 从模型输出里剥掉可能的 Markdown 代码块围栏。 */
function extractCode(text) {
  const fenced = /```(?:javascript|js)?\s*\n?([\s\S]*?)```/.exec(text)
  return (fenced === null ? String(text) : fenced[1]).trim()
}

/**
 * 调用宿主模型生成策略代码。
 * @param ctx - 插件上下文。
 * @param description - 用户对策略的自然语言描述。
 * @param currentCode - 现有策略代码，供模型在其基础上修改；无则留空。
 * @returns 生成的代码、所用模型与用量。
 */
async function generateStrategy(ctx, description, currentCode) {
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

  const options = {
    provider,
    model,
    system: STRATEGY_SYSTEM_PROMPT,
    messages: [{
      id: 'astock-generate-1',
      role: 'user',
      content: [{ type: 'text', text: parts.join('\n\n') }],
      source: { kind: 'plugin', plugin: 'astock' },
    }],
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
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }

  if (finish !== null && finish.kind === 'error') {
    const failure = finish.failure
    throw new Error('模型调用失败：' + String((failure && failure.message) || '未知原因'))
  }
  if (finish !== null && finish.kind === 'aborted') throw new Error('模型调用被中断')

  const code = extractCode(text)
  if (code === '') {
    // 说清「为什么没有内容」，而不是一句无信息量的「没有返回任何内容」。
    const used = usage && typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : null
    const why = finish !== null && finish.kind === 'max-tokens'
      ? '模型把输出预算全用在思考上，还没开始写代码就被截断了（思考 '
        + (used === null ? '未知' : used) + ' tokens，上限 ' + options.maxTokens
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
    usage: usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  }
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
  route('/astock/api/generate-strategy', async (_query, body) => {
    const description = String((body && body.description) || '').trim()
    if (description === '') throw new Error('请先用一句话描述你想要的策略')
    const currentCode = typeof (body && body.currentCode) === 'string' ? body.currentCode : ''
    return generateStrategy(ctx, description, currentCode)
  })
}
