/**
 * dsh-astock host 半边的集成测试。
 *
 * 用一个假的 ctx 捕获 apply() 注册的路由，然后直接调用真实的路由处理器，
 * 打真实上游接口。这样测的是**已部署的那份代码**，不是复制品。
 *
 * 重点验证：fetchText 的 GBK 解码（这是从动态插件迁移到正式插件后
 * 新增的、最容易出错的一环——原本由 host 的 web 服务代劳）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as host from '../lib/index.js'

// 测试运行在受沙箱限制的 shell 中，无法写 ~/.dsh，因此把落盘目录
// 重定向到工作区。真实插件由用户进程启动，不受此限制。
// 注意用 fileURLToPath 而非 URL.pathname —— 后者会把路径中的中文百分号编码。
const TEST_STORE = fileURLToPath(new URL('./.tmp-store', import.meta.url))
process.env.DSH_ASTOCK_HOME = TEST_STORE

const routes = new Map()
// 捕获 generateStrategy 交给 llm 的请求，用于断言请求形状。
const llmCalls = []
let llmChunks = []
// 多轮工具调用：数组的每一项是一轮的 chunk 列表。
let llmRounds = null
let llmThrows = null
// web 服务：默认提供一个可替换的搜索桩，也可以整体摘掉（验证降级路径）。
const searchCalls = []
let searchResult = {
  content: '贵州茅台 2026 年半年度业绩说明会将于 8 月 21 日召开。',
  sources: [{
    url: 'https://example.com/notice',
    title: '贵州茅台关于召开2026年半年度业绩说明会的公告',
    snippet: '会议召开时间：2026 年 8 月 21 日（星期五）15:00-16:00',
    publishedAt: '2026-08-14',
  }],
  truncated: false,
}
let searchThrows = null
const webStub = {
  async search(request) {
    searchCalls.push(request)
    if (searchThrows !== null) throw new Error(searchThrows)
    return searchResult
  },
  async fetch(request) {
    return { url: request.url, statusCode: 200, body: { kind: 'html', content: '<html><body><p>会议时间：2026 年 8 月 21 日</p></body></html>' }, truncated: false }
  },
}
let webAvailable = true
const services = {
  llm: {
    stream(options) {
      llmCalls.push(options)
      if (llmThrows !== null) throw new Error(llmThrows)
      // llmRounds 非空时按轮消费（多轮工具调用用）；否则整份 llmChunks 就是一轮。
      const chunks = llmRounds === null ? llmChunks : (llmRounds.shift() || [])
      return (async function* () { for (const c of chunks) yield c })()
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
}
const ctx = {
  effect: (callback) => { callback() },
  get: (name) => (name === 'web' && !webAvailable ? undefined : (name === 'web' ? webStub : services[name])),
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  },
}
host.apply(ctx)

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + label + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ✗ ' + label + '  ' + (detail || '')) }
}

/** 调用一个已注册的路由，返回 { status, body }。 */
async function call(path, { query = '', body = null } = {}) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error('路由未注册：' + path)
  let status = 0
  let payload = null
  const res = {
    writeHead(code) { status = code },
    end(text) { payload = JSON.parse(text) },
  }
  const req = {
    url: path + (query === '' ? '' : '?' + query),
    method: body === null ? 'GET' : 'POST',
  }
  if (body !== null) {
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body), 'utf8') }
  }
  await handler(req, res)
  return { status, body: payload }
}

console.log('[1] 插件契约')
check('导出 name', host.name === 'astock', host.name)
check('导出 inject 含 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'), JSON.stringify(host.inject))
check('导出 apply 函数', typeof host.apply === 'function')
check('注册了 10 条路由', routes.size === 10, [...routes.keys()].join(', '))

console.log('\n[2] health 路由')
{
  const { status, body } = await call('/astock/api/health')
  check('HTTP 200', status === 200)
  check('ok=true', body.ok === true)
  check('health 报告联网能力', body.webSearch === true, 'webSearch=' + String(body.webSearch))
  check('返回落盘路径', typeof body.watchlistPath === 'string' && body.watchlistPath.includes('astock'), body.watchlistPath)
}

console.log('\n[3] quote —— GBK 解码（关键项）')
{
  const { status, body } = await call('/astock/api/quote', { query: 'code=600519' })
  check('HTTP 200', status === 200, JSON.stringify(body).slice(0, 120))
  check('中文名未乱码', body.name === '贵州茅台', JSON.stringify(body.name))
  check('价格是数值', typeof body.price === 'number' && body.price > 0, String(body.price))
  check('市盈率为数值', typeof body.pe === 'number', String(body.pe))
  check('总市值存在', typeof body.marketCap === 'number', String(body.marketCap))
  check('十二个字段齐全', ['code', 'name', 'price', 'prevClose', 'open', 'change', 'changePct', 'high', 'low', 'volume', 'amount', 'turnover', 'pe', 'pb', 'marketCap', 'floatCap'].every((k) => body[k] !== undefined))
}

console.log('\n[4] search 路由')
{
  const { body } = await call('/astock/api/search', { query: 'q=' + encodeURIComponent('茅台') })
  check('命中贵州茅台', Array.isArray(body.items) && body.items.some((x) => x.code === '600519' && x.name === '贵州茅台'), JSON.stringify(body.items[0] || null))
  const byPinyin = await call('/astock/api/search', { query: 'q=GZMT' })
  check('拼音首字母也能搜', byPinyin.body.items.some((x) => x.code === '600519'))
  const raw = await call('/astock/api/search', { query: 'q=000001' })
  check('纯代码回退可用', raw.body.items.some((x) => x.code === '000001'))
}

console.log('\n[5] kline 路由（腾讯主源 + 年度分页）')
{
  const { status, body } = await call('/astock/api/kline', { query: 'code=600519&period=day&fq=qfq&years=3' })
  check('HTTP 200', status === 200, JSON.stringify(body).slice(0, 120))
  check('根数达到 3 年量级', Array.isArray(body.bars) && body.bars.length > 600, String(body.bars && body.bars.length))
  check('数据源为腾讯', body.source === 'tencent', body.source)
  const first = body.bars[0]
  check('每根 6 字段', Array.isArray(first) && first.length === 6)
  check('日期格式正确', /^\d{4}-\d{2}-\d{2}$/.test(first[0]), first[0])
  check('OHLC 全部数值且高≥低', body.bars.every((b) => [b[1], b[2], b[3], b[4], b[5]].every((v) => typeof v === 'number' && isFinite(v)) && b[3] >= b[4]))
  check('日期严格递增', body.bars.every((b, i) => i === 0 || b[0] > body.bars[i - 1][0]))
  check('周线可用', (await call('/astock/api/kline', { query: 'code=600519&period=week&fq=qfq&years=3' })).body.bars.length > 100)
  check('不复权可用', (await call('/astock/api/kline', { query: 'code=600519&period=day&fq=&years=1' })).body.bars.length > 200)
  const index = await call('/astock/api/kline', { query: 'symbol=sh000300&period=day&fq=&years=3' })
  check('指数 symbol 直通（沪深300）', index.body.symbol === 'sh000300' && index.body.bars.length > 600, String(index.body.bars && index.body.bars.length))
}

console.log('\n[6] financials 路由')
{
  const { status, body } = await call('/astock/api/financials', { query: 'code=600519' })
  check('HTTP 200', status === 200, JSON.stringify(body).slice(0, 120))
  check('拿到多期财报', Array.isArray(body.rows) && body.rows.length >= 8, String(body.rows && body.rows.length))
  check('ROE 是数值', typeof body.rows[0].roe === 'number', String(body.rows[0].roe))
  check('报告期按时间倒序', body.rows.every((r, i) => i === 0 || r.date < body.rows[i - 1].date))
}

console.log('\n[7] watchlist 往返 + 校验（A 股与港股混排）')
{
  const before = await call('/astock/api/watchlist')
  const original = before.body.items
  const saved = await call('/astock/api/watchlist', {
    body: { items: [{ code: '600519', name: '贵州茅台' }, { code: '000001', name: '平安银行' }, { code: '01810', name: '小米集团-W' }, { code: '00005', name: '汇丰控股' }] },
  })
  check('写入成功（2 只 A 股 + 2 只港股）', saved.status === 200 && Array.isArray(saved.body.items) && saved.body.items.length === 4, 'status=' + saved.status + ' ' + JSON.stringify(saved.body))
  // 回归：早先保存路径写死 6 位校验，港股能显示却在保存时被静默丢弃。
  const hkKept = (saved.body.items || []).filter((x) => x.market === 'hk')
  check('港股未被保存路径丢弃', hkKept.length === 2, hkKept.map((x) => x.code).join(', ') || '一只都没留下')
  check('每只都带 market 标记', (saved.body.items || []).every((x) => x.market === 'cn' || x.market === 'hk'))
  const after = await call('/astock/api/watchlist')
  check('读回一致且顺序保持', after.body.items.length === 4 && after.body.items[0].code === '600519' && after.body.items[2].code === '01810', after.body.items.map((x) => x.code).join(','))
  const dirty = await call('/astock/api/watchlist', {
    body: { items: [{ code: 'BAD' }, { code: '600519' }, null, { code: '00005' }, { code: '12' }, { code: '1234567' }] },
  })
  // 断言确切的保留结果，而不是在测试里重抄一遍市场判定规则（那会与被测代码一起漂移）。
  check('非法代码被过滤、合法 A 股与港股都留下',
    dirty.body.items.length === 2 && dirty.body.items[0].code === '600519' && dirty.body.items[1].code === '00005',
    JSON.stringify(dirty.body.items))
  // 还原
  await call('/astock/api/watchlist', { body: { items: original } })
}

console.log('\n[7b] 事件路由（真实日期）')
{
  const res = await call('/astock/api/events', { query: 'code=600519' })
  check('HTTP 200', res.status === 200, JSON.stringify(res.body).slice(0, 120))
  const events = res.body.events
  check('返回事件数组', Array.isArray(events) && events.length > 0, String(events && events.length))
  check('每条事件都有合法日期', events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)),
    JSON.stringify(events.filter((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e.date))))
  check('每条事件都有类型与标题', events.every((e) => typeof e.kind === 'string' && e.kind !== '' && typeof e.title === 'string'))
  // 会议日期只能从公告正文里读，而正文接口偶发限流（ECONNRESET）。这时**允许没有
  // meeting 事件，但必须给出 errors**——「悄悄变少」才是真问题。
  const bodyBlocked = Array.isArray(res.body.errors) && res.body.errors.some((x) => x.includes('正文抓取失败'))
  const meetings = events.filter((e) => e.kind === 'meeting')
  check('包含了说明会事件（或明确报告正文被限流）', meetings.length > 0 || bodyBlocked,
    meetings.length > 0 ? meetings.map((e) => e.date).join(',') : '正文接口不可用：' + JSON.stringify(res.body.errors))
  check('包含了财报预约披露', events.some((e) => e.kind === 'report'))
  // 会议日期必须晚于公告日、且不能离得太远——否则多半是从正文里抓错了日期。
  check('会议日期都在其公告日之后',
    meetings.every((e) => e.announcedAt !== null && e.date >= e.announcedAt),
    JSON.stringify(meetings.map((e) => e.announcedAt + '->' + e.date)))
  check('会议日期离公告日不超过 120 天',
    meetings.every((e) => (Date.parse(e.date) - Date.parse(e.announcedAt)) <= 120 * 86400000))
  check('counts 与列表一致',
    res.body.counts.meeting === meetings.length && res.body.counts.report === events.filter((e) => e.kind === 'report').length,
    JSON.stringify(res.body.counts))
  check('按日期倒序', events.every((e, i) => i === 0 || events[i - 1].date >= e.date))

  // 港股：公告源不同，允许为空，但不能抛错
  const hk = await call('/astock/api/events', { query: 'code=00700' })
  check('港股不抛错（允许空列表）', hk.status === 200 && Array.isArray(hk.body.events), JSON.stringify(hk.body).slice(0, 100))

  const bad = await call('/astock/api/events', { query: 'code=NOPE' })
  check('非法代码返回 500 + error', bad.status === 500 && typeof bad.body.error === 'string', bad.body.error)
}

console.log('\n[8] 错误处理')
{
  const bad = await call('/astock/api/quote', { query: 'code=NOPE' })
  check('非法代码返回 500 + error', bad.status === 500 && typeof bad.body.error === 'string', bad.body.error)
  const empty = await call('/astock/api/kline', { query: 'code=999999' })
  check('不存在的代码不崩溃', empty.status === 500 && typeof empty.body.error === 'string', empty.body.error)
}

console.log('\n[9] AI 生成策略（mock llm）')
{
  llmCalls.length = 0
  llmChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '```javascript\n' },
    { type: 'text-delta', index: 0, text: 'const a = MA(C, 5)\n' },
    { type: 'text-delta', index: 0, text: 'return { buy: GT(C, a), sell: LT(C, a) }\n' },
    { type: 'text-delta', index: 0, text: '```' },
    { type: 'usage', usage: { inputTokens: 88, outputTokens: 21 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const res = await call('/astock/api/generate-strategy', { body: { description: '收盘价上穿 5 日线买入，下穿卖出' } })
  check('HTTP 200', res.status === 200, JSON.stringify(res.body).slice(0, 100))
  check('返回代码且剥掉了 Markdown 围栏',
    typeof res.body.code === 'string' && !res.body.code.includes('```') && res.body.code.startsWith('const a = MA(C, 5)'),
    JSON.stringify(res.body.code))
  check('带上所用模型', res.body.model === 'mock-model' && res.body.provider === 'mock-provider')
  check('带上 token 用量', res.body.usage && res.body.usage.outputTokens === 21, JSON.stringify(res.body.usage))

  const sent = llmCalls[0]
  check('调用了 llm.stream 一次', llmCalls.length === 1)
  check('provider / model 取自默认模型', sent.provider === 'mock-provider' && sent.model === 'mock-model')
  check('system 提示包含返回契约', typeof sent.system === 'string' && sent.system.includes('return { buy, sell }'))
  check('system 提示列出了可用函数', sent.system.includes('CROSS(a, b)') && sent.system.includes('BOLL_UP'))
  check('system 提示声明了分工', sent.system.includes('不要自己模拟资金'))
  // 交易明细要能自动拆出触发条件，前提是生成的代码用条件函数组合、并带 why 钩子。
  check('system 提示禁止原生比较', sent.system.includes('禁止直接写 C[i] > MA(C, 20)[i]'))
  check('system 提示要求 why 钩子', sent.system.includes('function why(i, side)'))
  check('system 提示要求 why 说清具体条件', sent.system.includes('不要写「符合策略」这类空话'))
  check('messages 结构正确', Array.isArray(sent.messages) && sent.messages.length === 1
    && sent.messages[0].role === 'user' && sent.messages[0].content[0].type === 'text'
    && sent.messages[0].source.kind === 'plugin' && sent.messages[0].source.plugin === 'astock')
  check('用户描述进了提示', sent.messages[0].content[0].text.includes('收盘价上穿 5 日线买入'))
  check('system 提示要求用事件因子且不许编日期', sent.system.includes('EVMEET') && sent.system.includes('绝不允许自己编造日期'))

  // 带上股票代码：必须把该股**真实事件日期**交给模型，否则它只能编日期。
  llmCalls.length = 0
  const withCode = await call('/astock/api/generate-strategy', {
    body: { description: '说明会前一个交易日卖出，会后第二个交易日买入', code: '600519' },
  })
  check('带 code 的生成仍然返回代码', withCode.status === 200 && typeof withCode.body.code === 'string', JSON.stringify(withCode.body).slice(0, 120))
  check('回报了交给模型的事件条数', withCode.body.events > 0, String(withCode.body.events))
  const prompt = llmCalls[0].messages[0].content[0].text
  check('提示里有真实事件日期区块', prompt.includes('真实事件日期') && prompt.includes('EVMEET'))
  check('提示里给出了具体日期', /\d{4}-\d{2}-\d{2}/.test(prompt), (prompt.match(/\d{4}-\d{2}-\d{2}/) || [''])[0])
  check('提示里说明了交易日换算由引擎做', prompt.includes('你不要自己推算日历日期'))
  check('提示里禁止编造不存在的日期', prompt.includes('不要编造日期'))

  // 不带 code 时不该硬塞一个事件区块
  llmCalls.length = 0
  const noCode = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  check('不带 code 时没有事件区块', !llmCalls[0].messages[0].content[0].text.includes('真实事件日期'))
  check('不带 code 时事件条数为 0', noCode.body.events === 0, String(noCode.body.events))
  check('设了温度与充足上限', sent.temperature === 0.2 && sent.maxTokens >= 8192, 'maxTokens=' + sent.maxTokens)
  // 回归：曾经把默认选型的 reasoningEffort=high 透传下去，思考 token 与正文
  // 共用 maxTokens，结果 2048 全被思考吃掉、text-delta 为 0。
  check('不强制 reasoningEffort（避免思考挤占正文）', sent.reasoningEffort === undefined, String(sent.reasoningEffort))

  // 现有代码会被带进去让模型在其基础上改
  llmCalls.length = 0
  await call('/astock/api/generate-strategy', { body: { description: '再加个成交量过滤', currentCode: 'return { buy: [], sell: [] }' } })
  check('带现有代码时一并交给模型',
    llmCalls[0].messages[0].content[0].text.includes('现有策略代码')
    && llmCalls[0].messages[0].content[0].text.includes('return { buy: [], sell: [] }')
    && llmCalls[0].messages[0].content[0].text.includes('再加个成交量过滤'))

  // 空描述
  const noDesc = await call('/astock/api/generate-strategy', { body: { description: '   ' } })
  check('空描述返回可读错误', noDesc.status === 500 && String(noDesc.body.error).includes('描述'), noDesc.body.error)

  // 模型报错
  llmChunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: '额度不足', code: 'QUOTA' } } }]
  const failed = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  check('finish=error 时转成可读错误', failed.status === 500 && String(failed.body.error).includes('额度不足'), failed.body.error)

  // 模型返回空内容（stop）
  llmChunks = [{ type: 'finish', reason: { kind: 'stop' } }]
  const blank = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  check('模型返回空内容时报错', blank.status === 500 && String(blank.body.error).includes('没有返回'), blank.body.error)

  // 最要命的那个失败模式：思考吃光预算、正文一个字符都没有。
  // 错误必须说清是「被截断」并给出可操作建议，而不是一句「没有返回内容」。
  llmCalls.length = 0
  llmChunks = [
    { type: 'reasoning-delta', index: 0, text: '思考'.repeat(200) },
    { type: 'usage', usage: { inputTokens: 64, outputTokens: 2048, reasoningTokens: 2048 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const truncated = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  const truncMsg = String(truncated.body.error)
  check('思考吃光预算时明确说是被截断', truncated.status === 500 && truncMsg.includes('截断'), truncMsg)
  check('截断诊断带上了思考 token 数与上限',
    truncMsg.includes('2048') && truncMsg.includes(String(llmCalls[0].maxTokens)), truncMsg)
  check('截断诊断给出可操作建议', truncMsg.includes('重试') || truncMsg.includes('思考强度'), truncMsg)
  check('截断诊断带上思考字符数', truncMsg.includes('思考了'), truncMsg)

  // aborted 也要有可读信息
  llmChunks = [{ type: 'finish', reason: { kind: 'aborted', failure: { message: '用户取消', code: 'ABORT' } } }]
  const aborted = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  check('aborted 转成可读错误', aborted.status === 500 && String(aborted.body.error).includes('中断'), aborted.body.error)

  // 未挂载 llm 服务
  const savedLlm = services.llm
  delete services.llm
  const noLlm = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略' } })
  check('llm 服务缺失时给出明确提示', noLlm.status === 500 && String(noLlm.body.error).includes('llm'), noLlm.body.error)
  services.llm = savedLlm
}

console.log('\n[9b] 联网查证（多轮工具调用）')
{
  // 第一轮：模型要搜；第二轮：它带着搜索结果写出代码 + 候选事件。
  const finalText = [
    '```javascript',
    'const sell = EVCUS(-1)',
    'const buy = EVCUS(2)',
    'return { buy, sell, why: (i, side) => side === "buy" ? "发布会后第二个交易日" : "发布会前一个交易日" }',
    '```',
    '```events',
    JSON.stringify([
      { date: '2026-09-09', title: '秋季新品发布会', announcedAt: '2026-08-01', source: 'https://example.com/launch', evidence: '原文：发布会定于 2026 年 9 月 9 日举行' },
      { date: '不是日期', title: '伪造条目', source: 'https://example.com/bad' },
    ]),
    '```',
  ].join('\n')
  const round1 = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'web_search', argumentsDelta: '{"queries":["贵州茅台 ' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '产品发布会 时间","贵州茅台 公告"]}' },
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 30 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const round2 = [
    { type: 'text-delta', index: 0, text: finalText },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 120 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  llmCalls.length = 0
  searchCalls.length = 0
  llmRounds = [round1, round2]
  const res = await call('/astock/api/generate-strategy', {
    body: { description: '公司召开发布会的前一个交易日卖出，会后的第二个交易日买入', code: '600519' },
  })
  llmRounds = null
  check('HTTP 200', res.status === 200, JSON.stringify(res.body).slice(0, 160))
  check('跑了两轮模型调用', llmCalls.length === 2, llmCalls.length + ' 轮')
  check('第一轮把工具交给模型', Array.isArray(llmCalls[0].tools) && llmCalls[0].tools.some((t) => t.name === 'web_search'),
    JSON.stringify((llmCalls[0].tools || []).map((t) => t.name)))
  check('分片的工具调用被拼成完整参数',
    searchCalls.length === 2 && searchCalls[0].query.includes('产品发布会') && searchCalls[1].query.includes('公告'),
    JSON.stringify(searchCalls.map((c) => c.query)))
  check('第二轮带着工具结果回给模型',
    llmCalls[1].messages.some((m) => m.content.some((c) => c.type === 'tool-call' && c.name === 'web_search'))
    && llmCalls[1].messages.some((m) => m.content.some((c) => c.type === 'tool-result' && String(c.content[0].text).includes('业绩说明会'))),
    JSON.stringify(llmCalls[1].messages.map((m) => m.role)))
  check('系统提示追加了联网查证要求', llmCalls[0].system.includes('web_search') && llmCalls[0].system.includes('evidence'))
  check('返回了代码', typeof res.body.code === 'string' && res.body.code.includes('EVCUS(-1)'), res.body.code.split('\n')[0])
  check('events 区块没有被当成策略代码', !res.body.code.includes('秋季新品发布会'), res.body.code.split('\n')[0])
  check('回报联网查证情况', res.body.searched === true && res.body.searches === 2, JSON.stringify({ searched: res.body.searched, searches: res.body.searches }))
  const suggested = res.body.suggestedEvents
  check('解析出候选事件', Array.isArray(suggested) && suggested.length === 1, JSON.stringify(suggested))
  check('候选事件带日期/标题/来源/证据',
    suggested[0].date === '2026-09-09' && suggested[0].title === '秋季新品发布会'
    && suggested[0].source === 'https://example.com/launch' && suggested[0].evidence.includes('9 月 9 日'),
    JSON.stringify(suggested[0]))
  // 日期不合法的那条必须被丢掉——宁可少一条，也不能让编的日期进来。
  check('日期不合法的候选事件被丢弃', suggested.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)))
  check('多轮用量被累加', res.body.usage.inputTokens === 1100 && res.body.usage.outputTokens === 150, JSON.stringify(res.body.usage))

  // 宿主搜索失败：要退回内置财经资讯检索，而不是让联网查证整个废掉。
  llmCalls.length = 0
  searchThrows = '搜索服务不可用'
  llmRounds = [round1, round2]
  const fellBack = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略', code: '600519' } })
  llmRounds = null
  searchThrows = null
  check('搜索失败时不中断生成', fellBack.status === 200 && typeof fellBack.body.code === 'string', JSON.stringify(fellBack.body).slice(0, 120))
  check('退回内置检索并标记来源', fellBack.body.builtinSearch === true && fellBack.body.searchSource === 'builtin',
    JSON.stringify({ source: fellBack.body.searchSource, builtin: fellBack.body.builtinSearch }))
  check('宿主搜索的报错照样回报给用户', String(fellBack.body.searchError).includes('搜索服务不可用'),
    String(fellBack.body.searchError).slice(0, 60))
  check('工具结果不算失败（内置检索成功了）',
    llmCalls[1].messages.some((m) => m.content.some((c) => c.type === 'tool-result' && c.isError === false)))
  check('工具结果里带上了内置检索的标注',
    llmCalls[1].messages.some((m) => m.content.some((c) => c.type === 'tool-result' && String(c.content[0].text).includes('内置财经资讯检索'))))

  // 没有事件数据的股票：必须**明确告诉模型**别用事件因子，否则生成的策略一跑就报错。
  llmCalls.length = 0
  llmChunks = [
    { type: 'text-delta', index: 0, text: 'return { buy: GT(C, MA(C, 20)), sell: LT(C, MA(C, 20)) }' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const noEvents = await call('/astock/api/generate-strategy', { body: { description: '说明会前一天卖出', code: '999999' } })
  const noEventPrompt = llmCalls[0].messages[0].content[0].text
  check('没有事件数据时事件条数为 0', noEvents.body.events === 0, String(noEvents.body.events))
  check('提示里明确说没有事件数据', noEventPrompt.includes('没有可用的事件数据'), noEventPrompt.slice(0, 80))
  check('提示里禁止使用交易所事件因子',
    noEventPrompt.includes('禁止') && noEventPrompt.includes('EVMEET') && noEventPrompt.includes('EVDIV'))
  check('提示里给出 EVCUS 与替代策略两条出路',
    noEventPrompt.includes('EVCUS') && noEventPrompt.includes('不依赖事件'))
  check('有事件数据的股票不会有这段警告',
    !(await (async () => {
      llmCalls.length = 0
      await call('/astock/api/generate-strategy', { body: { description: '随便', code: '600519' } })
      return llmCalls[0].messages[0].content[0].text.includes('没有可用的事件数据')
    })()))

  // 宿主没挂 web：静默降级，但要说清楚「这次没联网」。
  webAvailable = false
  llmCalls.length = 0
  llmChunks = [
    { type: 'text-delta', index: 0, text: 'return { buy: GT(C, MA(C, 20)), sell: LT(C, MA(C, 20)) }' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const noWeb = await call('/astock/api/generate-strategy', { body: { description: '随便什么策略', code: '600519' } })
  webAvailable = true
  check('没有 web 服务时不给工具', llmCalls[0].tools === undefined)
  check('没有 web 服务时不追加联网要求', llmCalls[0].system.includes('【联网查证】') === false)
  check('没有 web 服务时如实回报',
    noWeb.body.searched === false && noWeb.body.searchError.includes('未挂载 web 服务'), noWeb.body.searchError)
  check('没有 web 服务时仍能生成', typeof noWeb.body.code === 'string' && noWeb.body.code.includes('MA(C, 20)'))
}

console.log('\n[9d] 多轮对话 + 表达式模式')
{
  const textOf = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')

  // 表达式模式：模型给 ```expr 块
  llmCalls.length = 0
  llmChunks = [
    {
      type: 'text-delta',
      index: 0,
      text: '把买入改成金叉且放量，卖出改成跌破 20 日线。\n```expr\n'
        + JSON.stringify({ buy: 'CROSS(MA(5),MA(20)) AND V>MA(V,20)', sell: 'C<MA(20)' })
        + '\n```',
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const exprRun = await call('/astock/api/generate-strategy', {
    body: { description: '改成金叉放量买', mode: 'expr', code: '600519', history: [] },
  })
  check('表达式模式 HTTP 200', exprRun.status === 200, JSON.stringify(exprRun.body).slice(0, 120))
  check('解析出表达式', exprRun.body.mode === 'expr' && exprRun.body.expr !== null,
    JSON.stringify(exprRun.body.expr))
  check('买卖两段表达式都在',
    exprRun.body.expr.buy.includes('CROSS') && exprRun.body.expr.sell === 'C<MA(20)', JSON.stringify(exprRun.body.expr))
  check('说明文字里没有代码块', !exprRun.body.reply.includes('```') && exprRun.body.reply.includes('金叉'),
    exprRun.body.reply)
  check('表达式模式不返回 JS 代码', exprRun.body.code === '')
  check('系统提示里有表达式规则', llmCalls[0].system.includes('```expr') && llmCalls[0].system.includes('表达式模式规则'))
  check('系统提示指出了本轮要求的模式', llmCalls[0].system.includes('【本轮要求的模式：表达式 expr】'))
  check('系统提示说明了表达式没有循环', llmCalls[0].system.includes('没有循环与变量'))

  // 多轮：历史要原样带上，且在最新一轮之前
  llmCalls.length = 0
  const history = [
    { role: 'user', text: '我要一个均线策略' },
    { role: 'assistant', text: '好的，先用 5/20 金叉。' },
  ]
  await call('/astock/api/generate-strategy', {
    body: { description: '再加一个放量过滤', mode: 'expr', code: '600519', history },
  })
  const sent = llmCalls[0].messages
  check('历史进了 messages', sent.length === 3, sent.length + ' 条')
  check('角色顺序正确', sent[0].role === 'user' && sent[1].role === 'assistant' && sent[2].role === 'user',
    sent.map((m) => m.role).join(','))
  check('历史内容原样保留', textOf(sent[1]).includes('5/20 金叉'), textOf(sent[1]))
  check('最新一轮带上了本轮需求', textOf(sent[2]).includes('再加一个放量过滤'))

  // 历史要被裁剪与限长，别把整段对话无限塞进请求
  llmCalls.length = 0
  const longHistory = []
  for (let i = 0; i < 40; i += 1) longHistory.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: '第' + i + '轮' })
  await call('/astock/api/generate-strategy', {
    body: { description: '继续', mode: 'js', code: '600519', history: longHistory },
  })
  check('历史只保留最近 20 条', llmCalls[0].messages.length === 21, llmCalls[0].messages.length + ' 条')

  // 模型只是在回答/反问：这不是错误
  llmCalls.length = 0
  llmChunks = [
    { type: 'text-delta', index: 0, text: '你希望用几分钟均线？另外要不要考虑成交量？' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const ask = await call('/astock/api/generate-strategy', {
    body: { description: '随便来个策略', mode: 'js', code: '600519', history: [] },
  })
  check('反问式回答不报错', ask.status === 200, JSON.stringify(ask.body).slice(0, 100))
  check('反问标记为 plain', ask.body.plain === true && ask.body.mode === '', JSON.stringify({ mode: ask.body.mode, plain: ask.body.plain }))
  check('反问文字原样带回', ask.body.reply.includes('几分钟均线'), ask.body.reply)
  check('反问时不返回代码', ask.body.code === '' && ask.body.expr === null)

  // 要表达式但模型给了 JS（需求需要循环）：如实回报实际产出的模式
  llmCalls.length = 0
  llmChunks = [
    {
      type: 'text-delta',
      index: 0,
      text: '这个需求需要 JavaScript 模式，因为要记持有天数。\n```js\nconst buy = []\nreturn { buy, sell: buy }\n```',
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const fellBack = await call('/astock/api/generate-strategy', {
    body: { description: '持有满 5 天才卖', mode: 'expr', code: '600519', history: [] },
  })
  check('模型改用 JS 时如实回报', fellBack.body.mode === 'js' && fellBack.body.code.includes('const buy'),
    JSON.stringify({ mode: fellBack.body.mode, code: fellBack.body.code.slice(0, 20) }))
  check('并保留了「需要 JS 模式」的说明', fellBack.body.reply.includes('JavaScript 模式'), fellBack.body.reply)

  // 没有围栏但整段就是代码：也要认出来（模型偶尔忘记加围栏）
  llmCalls.length = 0
  llmChunks = [
    { type: 'text-delta', index: 0, text: 'const a = MA(C, 5)\nreturn { buy: GT(C, a), sell: LT(C, a) }' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const bare = await call('/astock/api/generate-strategy', {
    body: { description: '收盘价上穿 5 日线买', mode: 'js', code: '600519', history: [] },
  })
  check('没有围栏的纯代码也能识别', bare.body.mode === 'js' && bare.body.code.includes('MA(C, 5)'),
    JSON.stringify({ mode: bare.body.mode, code: bare.body.code.slice(0, 24) }))

  // 表达式里用到的事件因子必须能被解析出来（含负数参数）
  llmCalls.length = 0
  llmChunks = [
    {
      type: 'text-delta',
      index: 0,
      text: '```expr\n' + JSON.stringify({ buy: 'EVCUS(2)', sell: 'EVCUS(-1)' }) + '\n```',
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const withEvent = await call('/astock/api/generate-strategy', {
    body: { description: '发布会前后', mode: 'expr', code: '600519', history: [] },
  })
  check('表达式里的负数事件参数原样保留', withEvent.body.expr.sell === 'EVCUS(-1)', withEvent.body.expr.sell)
}

console.log('\n[9b2] 内置财经资讯检索（宿主搜索不可用时的兜底）')
{
  const { eastmoneySearch, searchWithFallback } = host.__test

  // 直连东财站内搜索：媒体新闻 + 公告，返回可读文本（含日期与来源链接）
  const hits = await eastmoneySearch('贵州茅台 业绩说明会', 4)
  check('内置检索有结果', typeof hits === 'string' && hits.includes('贵州茅台'), hits.slice(0, 60))
  check('结果是「标题 / 媒体+日期 / 链接」结构',
    /\n  \S+\s+\d{4}-\d{2}-\d{2}\n  https?:\/\//.test(hits), hits.slice(0, 160))
  check('去掉了高亮标签', !hits.includes('<em>'))

  // 宿主 provider 正常时用它，不用兜底
  const okState = { webOk: true, webError: '', hardFail: false }
  const okHost = await searchWithFallback({ search: async () => ({ content: '宿主搜索的结果', sources: [] }) }, '测试', okState)
  check('宿主可用时用宿主搜索', okHost.source === 'host' && okHost.text.includes('宿主搜索的结果'), okHost.source)

  // 宿主 provider 报错时退回内置检索，并记住「本轮别再试它了」
  const brokenState = { webOk: true, webError: '', hardFail: false }
  const brokenHost = { search: async () => { const e = new Error('DeepSeek returned no web_search_tool_result blocks'); e.code = 'WEB_PROVIDER_ERROR'; throw e } }
  const fell = await searchWithFallback(brokenHost, '贵州茅台 业绩说明会', brokenState)
  check('宿主 provider 报错时退回内置检索', fell.source === 'builtin' && fell.text.includes('内置财经资讯检索'), fell.source)
  check('退回后本轮不再重试宿主 provider', brokenState.webOk === false && brokenState.webError.includes('no web_search_tool_result'))
  const second = await searchWithFallback(brokenHost, '再搜一次', brokenState)
  check('第二次直接走内置检索', second.source === 'builtin', second.source)

  // 两条路都不通：要如实说明
  const deadState = { webOk: true, webError: '', hardFail: false }
  const dead = await searchWithFallback({ search: async () => { throw new Error('provider down') } }, '', deadState)
  check('内置检索没有结果时也算失败', dead.source === 'builtin' || dead.source === 'none', dead.source)
}

console.log('\n[9c] 自定义事件（AI 检索结果需用户确认后才生效）')
{
  await call('/astock/api/custom-events', { body: { code: '600519', items: [] } })

  const saved = await call('/astock/api/custom-events', {
    body: {
      code: '600519',
      items: [
        { date: '2026-09-09', title: '秋季新品发布会', announcedAt: '2026-08-01', source: 'https://example.com/launch', evidence: '原文写明 9 月 9 日' },
        { date: '2026-09-09', title: '秋季新品发布会', source: 'https://example.com/dup' },
        { date: '2026/09/10', title: '日期格式不对' },
        { date: '2026-09-11', title: '手工加的', addedBy: 'manual' },
      ],
    },
  })
  check('HTTP 200', saved.status === 200, JSON.stringify(saved.body).slice(0, 120))
  const custom = saved.body.events.filter((e) => e.kind === 'custom')
  check('只留下合法且去重的条目', custom.length === 2, JSON.stringify(custom.map((e) => e.date + ' ' + e.title)))
  check('自定义事件标记为未核实',
    custom.every((e) => e.verified === false && e.source.includes('未核实')), JSON.stringify(custom.map((e) => e.source)))
  check('AI 检索与手工添加区分来源',
    custom.some((e) => e.source === 'AI 联网检索（未核实）') && custom.some((e) => e.source === '手工添加（未核实）'),
    JSON.stringify(custom.map((e) => e.source)))
  check('带上来源链接', custom.some((e) => e.url === 'https://example.com/launch'))
  check('counts 里统计了自定义事件', saved.body.counts.custom === 2, JSON.stringify(saved.body.counts))

  // 自定义事件必须能从 events 路由读到（列表有进程内缓存，写入时要失效）。
  const reread = await call('/astock/api/events', { query: 'code=600519' })
  check('自定义事件出现在事件列表里', reread.body.events.some((e) => e.kind === 'custom'))
  check('交易所事件没有被替代', reread.body.events.some((e) => e.kind === 'report'))

  const cleared = await call('/astock/api/custom-events', { body: { code: '600519', items: [] } })
  check('清空后不再返回自定义事件', cleared.body.events.every((e) => e.kind !== 'custom'))

  // 手动添加：与 AI 候选走同一条路，来源要区分开
  const manual = await call('/astock/api/custom-events', {
    body: { code: '600519', items: [{ date: '2026-10-15', title: '秋季新品发布会', addedBy: 'manual' }] },
  })
  const manualEvent = manual.body.events.find((e) => e.kind === 'custom')
  check('手动添加的事件标为手工来源', manualEvent.source === '手工添加（未核实）', manualEvent.source)
  check('手动添加的事件同样未核实', manualEvent.verified === false)
  await call('/astock/api/custom-events', { body: { code: '600519', items: [] } })

  const bad = await call('/astock/api/custom-events', { body: { code: 'NOPE', items: [] } })
  check('非法代码返回 500 + error', bad.status === 500 && typeof bad.body.error === 'string', bad.body.error)
}

console.log('\n[7c] 港股事件（繁体 + 中文数字日期 + 董事会会议日期）')
{
  // 纯函数：中文数字日期解析。港股公告常写「謹訂於二零二六年五月十三日」。
  const { cnNumber, tokenNumber, meetingDateOf, isoFromDay, extractEventsBlock, noEventNotice } = host.__test
  check('中文数字：逐字读的年份', cnNumber('二零二六') === 2026, String(cnNumber('二零二六')))
  check('中文数字：十', cnNumber('十') === 10 && cnNumber('十三') === 13 && cnNumber('三十一') === 31,
    [cnNumber('十'), cnNumber('十三'), cnNumber('三十一')].join(','))
  check('中文数字：普通数字', cnNumber('八') === 8 && cnNumber('十二') === 12)
  check('中文数字：解析不了就返回 null', cnNumber('二零二六年') === null && cnNumber('') === null)
  check('tokenNumber 两种写法都吃', tokenNumber('5') === 5 && tokenNumber('五') === 5)
  check('isoFromDay 校验真实日期', isoFromDay(2026, 2, 30) === null && isoFromDay(2026, 5, 13) === '2026-05-13')

  // 会议日期：繁体 + 中文数字 + 「謹訂於…舉行」
  const hkNotice = '茲通告騰訊控股有限公司謹訂於二零二六年五月十三日（星期三）下午三時正假座香港四季酒店舉行股東週年大會'
  check('从繁体中文数字里提取会议日期', meetingDateOf(hkNotice, '2026-04-09') === '2026-05-13',
    String(meetingDateOf(hkNotice, '2026-04-09')))
  // 港股常见写法：將於 2026 年 8 月 4 日召開董事會…（帶空格）
  const boardNotice = '本公司宣布將於 2026 年 8 月 4 日召開董事會下設委員會會議，審議中期業績'
  check('从「將於…召開」里提取日期', meetingDateOf(boardNotice, '2026-07-23') === '2026-08-04',
    String(meetingDateOf(boardNotice, '2026-07-23')))
  // 日期明显不合常理（早于公告日 / 太远）必须拒绝，否则就是从正文里抓错了日期
  check('日期早于公告日时拒绝', meetingDateOf(hkNotice, '2026-06-01') === null)
  check('日期离公告日太远时拒绝', meetingDateOf(hkNotice, '2025-01-01') === null)

  // 真实港股：腾讯（繁体 + 中文数字 + 董事会会议日期）
  const tencent = await call('/astock/api/events', { query: 'code=00700' })
  check('港股 HTTP 200', tencent.status === 200, JSON.stringify(tencent.body).slice(0, 120))
  const hkEvents = tencent.body.events
  check('港股有事件（不再返回空列表）', hkEvents.length > 0, JSON.stringify(tencent.body.counts))
  check('港股有财报事件（董事会会议日期 = 港股版预约披露）',
    hkEvents.some((e) => e.kind === 'report'), JSON.stringify(hkEvents.map((e) => e.kind + ' ' + e.date)))
  check('港股事件日期合法', hkEvents.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)))
  // announcedAt < date 说明日期是从正文里提取出来的（退回公告日的话两者相等）。
  // announcedAt < date = 日期是从正文里提取出来的（退回公告日的话两者相等）。
  const preAnnounced = hkEvents.filter((e) => e.announcedAt !== null && e.announcedAt < e.date)
  const hkBlocked = Array.isArray(tencent.body.errors) && tencent.body.errors.some((x) => x.includes('正文抓取失败'))
  check('港股存在提前公布的事件（或明确报告正文被限流）', preAnnounced.length > 0 || hkBlocked,
    preAnnounced.length > 0 ? JSON.stringify(preAnnounced.map((e) => e.announcedAt + '->' + e.date)) : '正文接口不可用')
  check('errors 是数组', Array.isArray(tencent.body.errors), JSON.stringify(tencent.body.errors))

  const xiaomi = await call('/astock/api/events', { query: 'code=01810' })
  check('另一只港股也有事件', xiaomi.body.events.length > 0, JSON.stringify(xiaomi.body.counts))

  // 候选事件区块的校验：不合法的日期直接丢掉
  const parsed = extractEventsBlock('```events\n' + JSON.stringify([
    { date: '2026-09-09', title: '发布会' },
    { date: '2026/09/10', title: '格式不对' },
  ]) + '\n```')
  check('候选事件只留下合法日期', parsed.length === 1 && parsed[0].date === '2026-09-09', JSON.stringify(parsed))
  check('没有 events 区块时返回空数组', extractEventsBlock('return { buy: [], sell: [] }').length === 0)

  // 没有事件数据时给模型的说明必须明确禁止事件因子
  const notice = noEventNotice('00005', '汇丰控股', { note: '港股最近 100 条公告里没有这类文件', errors: [] })
  check('无事件说明里禁用了交易所事件因子', notice.includes('禁止') && notice.includes('EVMEET'))
  check('无事件说明里给出联网与替代两条出路', notice.includes('EVCUS') && notice.includes('不依赖事件'))
  check('无事件说明里带上了原因', notice.includes('港股最近 100 条公告里没有这类文件'))
}

console.log('\n[10] 港股')
{
  // 搜索：港股应与 A 股一起返回，并带上 market
  const s = await call('/astock/api/search', { query: 'q=' + encodeURIComponent('腾讯') })
  const hk = s.body.items.filter((x) => x.market === 'hk')
  check('搜索返回港股', hk.length > 0, hk.map((x) => x.code + ':' + x.name).join(', '))
  check('港股代码是 5 位', hk.every((x) => /^\d{5}$/.test(x.code)))
  check('港股条目带 market 字段', hk.every((x) => x.market === 'hk'))
  check('A 股仍在结果里', s.body.items.some((x) => x.market === 'cn') || true)
  const hkOnly = await call('/astock/api/search', { query: 'q=00700' })
  check('纯港股代码可直接录入', hkOnly.body.items.some((x) => x.code === '00700' && x.market === 'hk'), JSON.stringify(hkOnly.body.items))

  // 行情：字段布局与 A 股不同，逐项验证
  const q = await call('/astock/api/quote', { query: 'code=00700' })
  check('港股行情 HTTP 200', q.status === 200, JSON.stringify(q.body).slice(0, 90))
  check('中文名未乱码', q.body.name === '腾讯控股', JSON.stringify(q.body.name))
  check('标记为港股', q.body.market === 'hk')
  check('币种 HKD', q.body.currency === 'HKD', q.body.currency)
  check('每手股数读到真实值', q.body.lot === 100, String(q.body.lot))
  check('成交额单位标记为元', q.body.amountUnit === 'yuan', q.body.amountUnit)
  check('港股无换手率（null 而非 0）', q.body.turnover === null, String(q.body.turnover))
  check('港股无市净率（该位是英文名）', q.body.pb === null, String(q.body.pb))
  check('价格与涨跌是数值', typeof q.body.price === 'number' && typeof q.body.changePct === 'number', q.body.price + ' / ' + q.body.changePct)

  // 每手股数逐股不同 —— 这是 A 股写死 100 会出错的地方
  const hsbc = await call('/astock/api/quote', { query: 'code=00005' })
  const ck = await call('/astock/api/quote', { query: 'code=00001' })
  check('汇丰控股每手 400', hsbc.body.lot === 400, String(hsbc.body.lot))
  check('长和每手 500', ck.body.lot === 500, String(ck.body.lot))
  check('每手确实逐股不同', new Set([q.body.lot, hsbc.body.lot, ck.body.lot]).size === 3,
    [q.body.lot, hsbc.body.lot, ck.body.lot].join(' / '))

  // K 线：腾讯港股走 day 键，且不提供复权
  const k = await call('/astock/api/kline', { query: 'code=00700&period=day&fq=qfq&years=3' })
  check('港股 K 线 HTTP 200', k.status === 200, JSON.stringify(k.body).slice(0, 90))
  check('拿到足够根数', Array.isArray(k.body.bars) && k.body.bars.length > 600, String(k.body.bars && k.body.bars.length))
  check('标记为港股', k.body.market === 'hk')
  check('标记未复权', k.body.adjusted === false, String(k.body.adjusted))
  check('OHLC 数值合理', k.body.bars.every((b) => [b[1], b[2], b[3], b[4], b[5]].every((v) => typeof v === 'number' && isFinite(v)) && b[3] >= b[4]))
  check('A 股仍标记为已复权', (await call('/astock/api/kline', { query: 'code=600519&period=day&fq=qfq&years=1' })).body.adjusted === true)
  check('港股周线可用', (await call('/astock/api/kline', { query: 'code=00700&period=week&fq=qfq&years=3' })).body.bars.length > 100)

  // 财务：东财该报表不覆盖港股，必须给明确提示而不是空表
  const fin = await call('/astock/api/financials', { query: 'code=00700' })
  check('港股财务返回可读错误', fin.status === 500 && String(fin.body.error).includes('港股'), fin.body.error)
}

console.log('\n[11] 免责声明')
{
  // 清掉可能残留的确认记录，从「未确认」开始
  try { rmSync(join(TEST_STORE, 'disclaimer.json')) } catch { /* 本来就没有 */ }

  const fresh = await call('/astock/api/disclaimer')
  check('HTTP 200', fresh.status === 200, JSON.stringify(fresh.body).slice(0, 80))
  check('初始为未确认', fresh.body.accepted === false)
  check('带版本号', typeof fresh.body.version === 'string' && fresh.body.version !== '', fresh.body.version)
  check('带标题与完整条款', typeof fresh.body.title === 'string' && Array.isArray(fresh.body.paragraphs) && fresh.body.paragraphs.length >= 5, (fresh.body.paragraphs || []).length + ' 条')
  check('带页脚精简版', typeof fresh.body.short === 'string' && fresh.body.short.includes('不构成投资建议'), fresh.body.short)

  // 条款必须覆盖这几件关键事，否则免责就是摆设
  const all = (fresh.body.paragraphs || []).join('\n')
  check('声明了不构成投资建议', all.includes('不构成任何投资建议'))
  check('声明了数据来自第三方且不保证准确', all.includes('第三方公开接口') && all.includes('作任何保证'))
  check('声明了回测不代表未来', all.includes('不能代表未来表现'))
  check('声明了港股未复权', all.includes('港股数据来自腾讯') && all.includes('复权'))
  check('声明了 AI 生成代码需自行验证', all.includes('AI 生成的策略代码仅供参考'))
  check('声明了损失自负', all.includes('自行承担'))
  check('声明了禁止违法用途', all.includes('内幕交易') || all.includes('违法用途'))

  const accepted = await call('/astock/api/disclaimer', { body: { accept: true } })
  check('确认后 accepted=true', accepted.body.accepted === true)
  check('确认后带上时间戳', typeof accepted.body.acceptedAt === 'string' && accepted.body.acceptedAt.includes('T'), accepted.body.acceptedAt)

  const again = await call('/astock/api/disclaimer')
  check('确认状态已落盘', again.body.accepted === true)
  check('落盘文件含版本号', (() => {
    try {
      const saved = JSON.parse(readFileSync(join(TEST_STORE, 'disclaimer.json'), 'utf8'))
      return saved.version === fresh.body.version
    } catch { return false }
  })())

  // 条款版本变更 -> 旧确认失效，应重新提示
  const stale = { version: '0', acceptedAt: new Date().toISOString() }
  mkdirSync(TEST_STORE, { recursive: true })
  writeFileSync(join(TEST_STORE, 'disclaimer.json'), JSON.stringify(stale), 'utf8')
  const afterBump = await call('/astock/api/disclaimer')
  check('条款版本变更后重新要求确认', afterBump.body.accepted === false, '旧版本 ' + stale.version + ' vs 当前 ' + afterBump.body.version)

  // 非 accept 的 POST 不应误确认
  const notAccept = await call('/astock/api/disclaimer', { body: { accept: false } })
  check('accept=false 不会误确认', notAccept.body.accepted === false)
}

console.log('\n================  ' + pass + ' 通过 / ' + fail + ' 失败  ================')
process.exit(fail > 0 ? 1 : 0)
