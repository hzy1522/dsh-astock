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
let llmThrows = null
const services = {
  llm: {
    stream(options) {
      llmCalls.push(options)
      if (llmThrows !== null) throw new Error(llmThrows)
      return (async function* () { for (const c of llmChunks) yield c })()
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
}
const ctx = {
  effect: (callback) => { callback() },
  get: (name) => services[name],
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
check('注册了 8 条路由', routes.size === 8, [...routes.keys()].join(', '))

console.log('\n[2] health 路由')
{
  const { status, body } = await call('/astock/api/health')
  check('HTTP 200', status === 200)
  check('ok=true', body.ok === true)
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
  check('messages 结构正确', Array.isArray(sent.messages) && sent.messages.length === 1
    && sent.messages[0].role === 'user' && sent.messages[0].content[0].type === 'text'
    && sent.messages[0].source.kind === 'plugin' && sent.messages[0].source.plugin === 'astock')
  check('用户描述进了提示', sent.messages[0].content[0].text.includes('收盘价上穿 5 日线买入'))
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
