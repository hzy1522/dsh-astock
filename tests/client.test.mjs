/**
 * dsh-astock 客户端 bundle 的渲染冒烟测试。
 *
 * 这个 bundle 的格式是 `__ModuleLoader__` 工厂块，正常只在浏览器里跑。
 * 这里用真实的 bundle 文件 + 轻量 hook 运行时，在 Node 里把它跑一遍：
 *   1. 验证模块出口契约（name / inject / apply）
 *   2. 验证两个 slot 注册
 *   3. 真正执行 Panel 组件，并点遍四个标签页，确认各自渲染出预期内容
 *
 * 用自建 hook 运行时而不是 react-dom：profile 里 react 是 18、react-dom 是 19，
 * 版本不匹配。本插件只用到 createElement / useState / useEffect，足以模拟。
 */
import { readFileSync } from 'node:fs'

let spec = null
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
globalThis.document = {
  createElement: () => ({ textContent: '', remove() {} }),
  head: { appendChild() {} },
}

await import('../client/client.js')

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + label + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ✗ ' + label + '  ' + (detail || '')) }
}

console.log('[1] 模块加载契约')
check('bundle 文件调用了 __ModuleLoader__.load', spec !== null)
check('bundle id == 包名', spec.id === 'dsh-astock', spec.id)
check('factory 是函数', typeof spec.factory === 'function')

// ---- 轻量 hook 运行时（带 deps 语义的真实行为） ----
const hookState = []
let hookIndex = 0
const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
const ReactStub = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    merged.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
    return { type, props: merged }
  },
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hookState)) hookState[index] = initial
    return [hookState[index], (next) => { hookState[index] = next }]
  },
  useEffect(effect, deps) {
    const index = hookIndex
    hookIndex += 1
    const previous = hookState[index]
    if (previous !== undefined && depsEqual(previous.deps, deps)) return
    hookState[index] = { deps }
    effect()
  },
}

// ---- stub fetch：返回固定的宿主响应，驱动组件的数据流 ----
const bars = JSON.parse(readFileSync(new URL('./fixtures/kline-600519.json', import.meta.url), 'utf8')).data.sh600519.qfqday
  .slice(-800).map((r) => [String(r[0]), +r[1], +r[2], +r[3], +r[4], +r[5]])
// 行情按代码分支：A 股与港股字段布局不同（成交额单位、换手率、市净率、每手股数、币种）。
const QUOTES = {
  '600519': {
    code: '600519', market: 'cn', name: '贵州茅台', price: 1275.16, prevClose: 1285.13, open: 1285.15,
    change: -9.97, changePct: -0.78, high: 1286.15, low: 1263.01, volume: 34801,
    amount: 443084, amountUnit: 'wan', turnover: 0.28, pe: 19.57, pb: 6.34,
    marketCap: 15940.54, floatCap: 15940.54, lot: 100, currency: 'CNY',
  },
  // 汇丰控股：每手 400 股 —— A 股写死 100 会在这里出错。
  '00005': {
    code: '00005', market: 'hk', name: '汇丰控股', price: 163.3, prevClose: 162.1, open: 162.5,
    change: 1.2, changePct: 0.74, high: 163.9, low: 161.8, volume: 15_000_000,
    amount: 2.44e9, amountUnit: 'yuan', turnover: null, pe: 12.4, pb: null,
    marketCap: 29000, floatCap: 29000, lot: 400, currency: 'HKD',
  },
}
const FIXTURES = {
  watchlist: { items: [{ code: '600519', name: '贵州茅台' }, { code: '00005', name: '汇丰控股' }] },
  financials: { rows: [{ date: '2026-06-30', eps: 35.57, bps: 200.99, roe: 16.75, gross: 89.56 }] },
  kline: { source: 'tencent', bars },
}
// 独立的沪深300 序列。必须是**另一条**曲线：如果指数等于个股自身，
// RS 恒等于 1、BETA 恒等于 1，情绪因子就测不出任何东西。
// 用「缓慢上行 + 正弦扰动」构造，保证收益非零且方差非零。
const INDEX_BARS = bars.map((b, i) => {
  const mid = 3500 + i * 1.1 + Math.sin(i / 5) * 30
  return [b[0], mid - 5, mid, mid + 6, mid - 6, 1.2e8]
})
// 事件夹具：日期直接取自真实 K 线，保证「第几个交易日」的期望值是可独立算出的。
//   A：交易日当天开的说明会，公告在 10 个交易日前（可提前埋伏）
//   B：日期落在两根 K 线**之间**（周末），验证「事件日不是交易日就顺延」
//   C：会议当天才公告，验证「不能提前知道」——EVMEET(-1) 必须抓不到它
const BAR_N = bars.length
const dayAt = (i) => bars[i][0]
const I_A = BAR_N - 100
let I_B = BAR_N - 60
while (I_B > 20 && Date.parse(dayAt(I_B)) - Date.parse(dayAt(I_B - 1)) < 3 * 86400000) I_B -= 1
const I_C = BAR_N - 30
const betweenDate = (a, b) => new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString().slice(0, 10)
const EVENTS = {
  code: '600519',
  market: 'cn',
  events: [
    { date: dayAt(I_A), kind: 'meeting', title: '2026年半年度业绩说明会', announcedAt: dayAt(I_A - 10), actual: null, source: 'stub' },
    { date: betweenDate(dayAt(I_B - 1), dayAt(I_B)), kind: 'meeting', title: '三季度业绩说明会（非交易日）', announcedAt: dayAt(I_B - 10), actual: null, source: 'stub' },
    { date: dayAt(I_C), kind: 'meeting', title: '当天才公告的说明会', announcedAt: dayAt(I_C), actual: null, source: 'stub' },
    { date: dayAt(BAR_N - 200), kind: 'exdiv', title: '除权除息日', announcedAt: dayAt(BAR_N - 210), actual: null, source: 'stub' },
    // 自定义事件：只由 EVCUS 引用，绝不能混进 EVMEET 的结果里。
    { date: dayAt(BAR_N - 140), kind: 'custom', title: 'AI 查到的产品发布会', announcedAt: dayAt(BAR_N - 150), actual: null, source: 'AI 联网检索（未核实）', url: 'https://example.com/launch', verified: false },
  ],
  counts: { meeting: 3, report: 0, exdiv: 1, custom: 1 },
}
// 客户端 POST 上来的自定义事件：存起来，好让后面的读取能看到。
let customEvents = []
let eventsAvailable = true
// 让测试可以模拟「指数取不到」的情况
let indexAvailable = true
// AI 生成接口的响应可被测试改写，用来验证成功与失败两条路径。
let generateFixture = {
  code: 'const fast = MA(C, 10)\nconst slow = MA(C, 30)\nreturn { buy: CROSS(fast, slow), sell: CROSS(slow, fast) }',
  provider: 'stub', model: 'stub-model', events: 27, usage: { inputTokens: 120, outputTokens: 42 },
}
let generateError = null
// 免责声明：默认为「已确认」，其它用例才不会被确认弹窗干扰；
// 专门的用例再把它翻成未确认。
let disclaimerAccepted = true
let disclaimerAcceptFails = false
const makeDisclaimer = (accepted) => ({
  version: '1',
  title: '免责声明与使用条款',
  paragraphs: ['1. 仅用于学习研究，不构成任何投资建议。', '2. 数据来自第三方接口，不作任何保证。'],
  short: '本工具仅用于研究与学习，不构成投资建议。数据来自第三方，回测不代表未来收益，据此操作风险自负。',
  accepted,
  acceptedAt: accepted ? '2026-09-11T00:00:00.000Z' : null,
})
const fetchCalls = []
// 记录 POST body：验证「一键改写」确实把当前策略代码和改写指令发给了宿主。
const fetchBodies = []
globalThis.fetch = async (url, init) => {
  const raw = String(url)
  fetchCalls.push(raw)
  if (init !== undefined && init.body !== undefined) fetchBodies.push(String(init.body))
  const [path, search] = raw.split('?')
  const key = path.replace('/astock/api/', '')
  if (key === 'generate-strategy') {
    if (generateError !== null) return { ok: false, status: 500, json: async () => ({ error: generateError }) }
    return { ok: true, status: 200, json: async () => generateFixture }
  }
  if (key === 'disclaimer') {
    if (init !== undefined && init.method === 'POST') {
      if (disclaimerAcceptFails) return { ok: false, status: 500, json: async () => ({ error: '写盘失败' }) }
      disclaimerAccepted = true
      return { ok: true, status: 200, json: async () => makeDisclaimer(true) }
    }
    return { ok: true, status: 200, json: async () => makeDisclaimer(disclaimerAccepted) }
  }
  if (key === 'custom-events') {
    const payload = JSON.parse(String((init && init.body) || '{}'))
    customEvents = Array.isArray(payload.items) ? payload.items : []
    const custom = customEvents.map((it) => ({
      date: it.date, kind: 'custom', title: it.title, announcedAt: it.announcedAt || null, actual: null,
      source: it.addedBy === 'manual' ? '手工添加（未核实）' : 'AI 联网检索（未核实）',
      url: it.source || '', verified: false,
    }))
    return {
      ok: true, status: 200,
      json: async () => ({
        code: payload.code, market: 'cn',
        events: EVENTS.events.concat(custom),
        counts: { meeting: 3, report: 0, exdiv: 1, custom: custom.length },
      }),
    }
  }
  if (key === 'events') {
    if (!eventsAvailable) return { ok: false, status: 500, json: async () => ({ error: '事件取数失败' }) }
    const code = new URLSearchParams(search || '').get('code')
    if (code !== '600519') {
      return {
        ok: true, status: 200,
        json: async () => ({
          code, market: 'hk', events: [], counts: { meeting: 0, report: 0, exdiv: 0, custom: 0 },
          errors: [],
          note: '港股事件来自港交所公告：只识别「董事会会议召开日期」与股东大会通告。',
        }),
      }
    }
    const custom = customEvents.map((it) => ({
      date: it.date, kind: 'custom', title: it.title, announcedAt: it.announcedAt || null, actual: null,
      source: 'AI 联网检索（未核实）', url: it.source || '', verified: false,
    }))
    return { ok: true, status: 200, json: async () => ({ ...EVENTS, events: EVENTS.events.concat(custom) }) }
  }
  if (key === 'quote') {
    const code = new URLSearchParams(search || '').get('code')
    const quote = QUOTES[code]
    if (quote === undefined) return { ok: false, status: 404, json: async () => ({ error: 'no quote for ' + code }) }
    return { ok: true, status: 200, json: async () => quote }
  }
  if (key === 'kline') {
    const symbol = new URLSearchParams(search || '').get('symbol')
    if (symbol === 'sh000300') {
      if (!indexAvailable) return { ok: false, status: 500, json: async () => ({ error: '指数取数失败' }) }
      return { ok: true, status: 200, json: async () => ({ source: 'stub', symbol: 'sh000300', bars: INDEX_BARS }) }
    }
    return { ok: true, status: 200, json: async () => FIXTURES.kline }
  }
  const data = FIXTURES[key]
  if (data === undefined) return { ok: false, status: 404, json: async () => ({ error: 'no fixture for ' + raw }) }
  return { ok: true, status: 200, json: async () => data }
}

let required = []
const mod = spec.factory((name) => {
  required.push(name)
  if (name === 'react') return ReactStub
  throw new Error('未预期的 require：' + name)
})

console.log('\n[2] 插件出口')
check("只 require('react')", required.length === 1 && required[0] === 'react', JSON.stringify(required))
check('导出 name', mod.name === 'astock', mod.name)
check('导出 inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))
check('导出 apply 函数', typeof mod.apply === 'function')

const registrations = []
let effectLabels = []
const ctx = {
  slots: {
    inject(key, callback) { callback() },
    register(meta, component) { registrations.push({ meta, component }); return () => {} },
  },
  effect(callback, label) { effectLabels.push(label); callback() },
}
mod.apply(ctx)

console.log('\n[3] slot 注册')
check('注册了 2 个 slot', registrations.length === 2, registrations.map((r) => JSON.stringify(r.meta)).join(' '))
const mainReg = registrations.find((r) => r.meta.name === 'main')
const iconReg = registrations.find((r) => r.meta.name === 'sidebar.panellist')
check('main 面板注册', mainReg !== undefined && mainReg.meta.key === 'astock')
check('侧边栏图标注册', iconReg !== undefined && iconReg.meta.id === 'astock' && iconReg.meta.label === 'A股港股', JSON.stringify(iconReg && iconReg.meta))
check('注册了样式副作用', effectLabels.includes('dsh-astock:styles'), JSON.stringify(effectLabels.filter(Boolean)))

// ---- 元素树工具 ----
const collectText = (node) => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node === 'object' && node.props) {
    // 函数组件：调用后再取文本，否则 CandleChart 等渲染出的内容会被漏掉。
    if (typeof node.type === 'function') return collectText(node.type(node.props))
    return collectText(node.props.children)
  }
  return ''
}
const collect = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out }
  if (typeof node === 'object' && node.props) {
    // 函数组件（CandleChart / EquityChart 等纯组件）：真正调用后再遍历结果，
    // 否则只看到 {type: fn}，看不到它渲染出的 svg。
    if (typeof node.type === 'function') return collect(node.type(node.props), out)
    out.push(node)
    collect(node.props.children, out)
  }
  return out
}
const findButton = (tree, label) => collect(tree).find((n) => n.type === 'button' && collectText(n).includes(label))

console.log('\n[4] 渲染（真实执行组件函数 + 真实数据流）')
const Panel = mainReg.component
const render = () => { hookIndex = 0; return Panel({}) }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let tree = null
let threw = null
try {
  tree = render()          // 挂载：effect 触发 watchlist 拉取
  await tick()
  tree = render()          // 自选股到位 -> 自动选中 -> 触发行情/K线/财务
  await tick()
  await tick()
  tree = render()          // 数据到位
} catch (error) { threw = error }
check('Panel 渲染不抛错', threw === null, threw ? String(threw.message) + '\n' + String(threw.stack).split('\n')[1] : '')
if (threw) { console.log('\n渲染失败，后续检查跳过'); process.exit(1) }

let text = collectText(tree)
check('标题渲染', text.includes('A股港股量化工作台'))
check('搜索框提示语', collect(tree).some((n) => n.type === 'input' && String(n.props.placeholder).includes('拼音')))
check('四个标签页都在', ['K线', '公司数据', '策略配置', '回测'].every((t) => findButton(tree, t) !== undefined))
check('渲染出根容器', collect(tree).some((n) => n.props.className === 'astk-root'))

console.log('\n[4b] 数据流（经 fetch stub 驱动）')
check('挂载时拉了自选股', fetchCalls.some((u) => u.includes('/astock/api/watchlist')), fetchCalls[0] || '')
check('自选股渲染到侧栏', text.includes('贵州茅台') && text.includes('600519'))
check('自动选中并拉了行情', fetchCalls.some((u) => u.includes('/astock/api/quote')))
check('拉了 K 线', fetchCalls.some((u) => u.includes('/astock/api/kline')))
check('拉了财务', fetchCalls.some((u) => u.includes('/astock/api/financials')))
check('行情条渲染出名称与价格', text.includes('贵州茅台 600519') && text.includes('1275.16'))
check('行情条带估值字段', text.includes('市盈率') && text.includes('19.57') && text.includes('总市值'))
check('K线图画出来了', collect(tree).some((n) => n.type === 'svg' && String(n.props.className).includes('astk-chart')))
check('K线根数显示正确', text.includes('共 800 根'), (text.match(/共 \d+ 根/) || [''])[0])
check('蜡烛图元素存在', collect(tree).filter((n) => n.type === 'rect').length > 200, collect(tree).filter((n) => n.type === 'rect').length + ' 个 rect')
check('均线路径存在', collect(tree).filter((n) => n.type === 'path' && n.props.stroke !== undefined).length >= 4, collect(tree).filter((n) => n.type === 'path').length + ' 条 path')

// 悬停路径：调用真实的 onMouseEnter，读数区应出现逐根数据与均线值。
const hit = collect(tree).find((n) => n.type === 'rect' && typeof n.props.onMouseEnter === 'function')
check('存在悬停热区', hit !== undefined)
if (hit !== undefined) {
  hit.props.onMouseEnter()
  tree = render()
  const hoverText = collectText(tree)
  check('悬停后出现逐根读数', hoverText.includes('开 ') && hoverText.includes('收 '))
  check('悬停后出现均线值', hoverText.includes('MA5') && hoverText.includes('MA60'))
  check('悬停后显示该根日期', /\d{4}-\d{2}-\d{2}/.test(hoverText), (hoverText.match(/\d{4}-\d{2}-\d{2}/) || [''])[0])
}

console.log('\n[5] 标签页切换（调用真实 onClick）')
const click = (label) => {
  const btn = findButton(tree, label)
  if (btn === undefined) throw new Error('找不到按钮：' + label)
  btn.props.onClick()
  tree = render()
  return collectText(tree)
}

const strategyText = click('策略配置')
check('策略页：六个模板都在', ['双均线金叉', 'MACD 金叉', 'RSI 超卖反转', '布林带均值回归', '唐奇安突破', '均线多头排列'].every((t) => strategyText.includes(t)))
check('策略页：表达式框有默认值', collect(tree).some((n) => n.type === 'textarea' && String(n.props.value).includes('CROSS(MA(5),MA(20))')))
check('策略页：回测参数可调', ['初始资金(元)', '佣金率', '印花税(卖)', '过户费', '滑点'].every((t) => strategyText.includes(t)))
check('策略页：有开始回测按钮', findButton(tree, '开始回测') !== undefined)

const btText = click('回测')
check('回测页：未跑时给出引导', btText.includes('还没有回测结果'))

const companyText = click('公司数据')
check('公司页：渲染表头', companyText.includes('报告期') && companyText.includes('ROE(%)'))
check('公司页：渲染财报行', companyText.includes('2026-06-30') && companyText.includes('16.75'))

const klineText = click('K线')
check('回到K线页', klineText.includes('日线') && klineText.includes('前复权'))
check('回到K线页后图表仍在', collect(tree).some((n) => String(n.props.className).includes('astk-chart')))

console.log('\n[5b] JavaScript 策略模式')

// 跑一次回测并切到可读状态（回测会跳到「回测」标签页）。
const runBacktestNow = async () => {
  const btn = findButton(tree, '开始回测')
  if (btn === undefined) throw new Error('找不到「开始回测」按钮')
  btn.props.onClick()
  tree = render()
  await tick(); await tick(); await tick()
  tree = render()
  return collectText(tree)
}
// 指标渲染成 <b>值</b><span>标签</span>，文本里是「值标签」的顺序。
const totalOf = (txt) => {
  const m = /(-?[\d.]+)%总收益/.exec(txt)
  return m === null ? null : m[1]
}
const tradesOf = (txt) => (/(\d+)交易次数/.exec(txt) || [])[1]
// 用 data-astk 锚点定位输入框——按「第几个 textarea」定位会被新增输入框打乱。
const byData = (key) => collect(tree).find((n) => n.props['data-astk'] === key)
const jsEditorValue = () => String(byData('js-source').props.value)
const setField = (key, value) => { byData(key).props.onChange({ target: { value } }); tree = render() }

click('策略配置')
check('策略页：有「表达式 / JavaScript」模式切换',
  findButton(tree, '表达式') !== undefined && findButton(tree, 'JavaScript') !== undefined)

// —— 基准：表达式模式 ——
const exprRun = await runBacktestNow()
const exprTotal = totalOf(exprRun)
const exprTrades = tradesOf(exprRun)
check('表达式模式回测出结果', exprTotal !== null && !exprRun.includes('错误'), '总收益 ' + exprTotal + '%')

// —— 切到 JS 模式 ——
click('策略配置')
byData('mode-js').props.onClick()
tree = render()
check('切到 JS 模式后出现代码编辑器', jsEditorValue().includes('return {'))
check('JS 模式默认示例可运行', jsEditorValue().includes('const fast = MA(C, 5)'), jsEditorValue().split('\n')[0])

findButton(tree, '双均线金叉').props.onClick()
tree = render()
check('JS 模式点模板填入等价 JS 代码', jsEditorValue().includes('const fast = MA(C, 5)') && jsEditorValue().includes('CROSS(fast, slow)'))

// —— 交叉验证：同一策略，两种模式必须得到完全相同的指标 ——
const jsRun = await runBacktestNow()
const jsTotal = totalOf(jsRun)
const jsTrades = tradesOf(jsRun)
check('JS 模式回测出结果', jsTotal !== null && !jsRun.includes('错误'), '总收益 ' + jsTotal + '%')
check('两种模式总收益完全一致（指标同源）', jsTotal !== null && jsTotal === exprTotal, 'JS ' + jsTotal + '% vs 表达式 ' + exprTotal + '%')
check('两种模式交易次数一致', jsTrades !== undefined && jsTrades === exprTrades, 'JS ' + jsTrades + ' 笔 vs 表达式 ' + exprTrades + ' 笔')

// —— JS 能表达表达式做不到的东西：循环 + 状态变量 + 分支 ——
const loopJs = [
  '// 表达式模式写不出来的东西：循环、累积变量、持仓状态',
  'const fast = MA(C, 5)',
  'const slow = MA(C, 20)',
  'const crossUp = CROSS(fast, slow)',
  'const below = LT(C, slow)',
  'const buy = new Array(C.length).fill(0)',
  'const sell = new Array(C.length).fill(0)',
  'let holdDays = 0',
  'let inPosition = false',
  'for (let i = 0; i < C.length; i++) {',
  '  if (!inPosition && crossUp[i]) { inPosition = true; holdDays = 0; buy[i] = 1; continue }',
  '  if (inPosition) {',
  '    holdDays++',
  '    // 至少持有 5 个交易日才允许卖出',
  '    if (holdDays >= 5 && below[i]) { inPosition = false; sell[i] = 1 }',
  '  }',
  '}',
  'return { buy, sell }',
].join('\n')
const setJs = (code) => {
  click('策略配置')
  setField('js-source', code)
}
setJs(loopJs)
const loopRun = await runBacktestNow()
check('循环 + 状态变量的策略可运行', !loopRun.includes('错误') && totalOf(loopRun) !== null, '总收益 ' + totalOf(loopRun) + '%')
check('该策略结果与纯交叉不同（代码确实生效）', totalOf(loopRun) !== exprTotal, 'loop ' + totalOf(loopRun) + '% vs 基准 ' + exprTotal + '%')

// —— 错误处理：四类错误都要给可读提示 ——
const expectError = async (code, label, fragment) => {
  setJs(code)
  const out = await runBacktestNow()
  const at = out.indexOf(fragment)
  // 详情截取错误附近，而不是页面开头——否则看不出到底报了什么。
  const detail = at < 0 ? '未出现「' + fragment + '」；文中含：' + out.slice(0, 60) : out.slice(Math.max(0, at - 16), at + 64)
  check(label, at >= 0, detail.replace(/\s+/g, ' '))
}
await expectError('const a = ', '语法错误有清晰提示', '语法错误')
await expectError('return 42', '返回值类型错误有提示', '必须 return')
await expectError('return { buy: [1,2], sell: [1,2] }', '信号长度不匹配有提示', '长度必须等于')
await expectError('throw new Error("boom")', '运行时异常有提示', '运行出错')

console.log('\n[5c] AI 生成策略')

click('策略配置')
check('策略页：有多轮对话入口', findButton(tree, '发送') !== undefined && byData('ai-description') !== undefined)

// 未填描述就点生成：给提示，且不应发请求
const callsBefore = fetchCalls.length
findButton(tree, '发送') !== undefined ? findButton(tree, '发送').props.onClick() : findButton(tree, '继续追问').props.onClick()
tree = render()
await tick()
tree = render()
check('未填描述时给出提示', collectText(tree).includes('先用一句话说明'))
check('未填描述时不请求模型', fetchCalls.length === callsBefore, '新增 ' + (fetchCalls.length - callsBefore) + ' 次请求')

// 正常生成
setField('ai-description', '10 日均线上穿 30 日均线买入，下穿卖出')
findButton(tree, '发送') !== undefined ? findButton(tree, '发送').props.onClick() : findButton(tree, '继续追问').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
let aiText = collectText(tree)
check('发起了生成请求', fetchCalls.some((u) => u.includes('generate-strategy')))
check('生成的代码填入编辑器', jsEditorValue().includes('const fast = MA(C, 10)'), jsEditorValue().split('\n')[0])
check('自动切到 JS 模式', aiText.includes('JavaScript：写任意代码'))
check('提示带模型名与用量', aiText.includes('stub-model') && aiText.includes('42 tokens'))
check('提示说明把真实事件日期交给了模型', aiText.includes('已把该股 27 条真实事件日期交给模型'))
check('生成后立即试运行校验通过', aiText.includes('已通过试运行校验'))

// 生成结果语法有错：仍填入便于手改，但提示试运行失败
setField('ai-description', '再改一版')
generateFixture = { code: 'const a = ', provider: 'stub', model: 'stub-model', usage: { outputTokens: 3 } }
findButton(tree, '发送') !== undefined ? findButton(tree, '发送').props.onClick() : findButton(tree, '继续追问').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
check('生成结果有问题时提示试运行报错', collectText(tree).includes('试运行报错'), (collectText(tree).match(/试运行报错：\S+/) || [''])[0])
check('有问题的代码仍填入编辑器', jsEditorValue() === 'const a = ')

// 联网查到的候选事件：必须由用户确认后才成为自定义事件
customEvents = []
setField('ai-description', '发布会前一天卖出，会后第二天买入')
generateFixture = {
  code: 'const sell = EVCUS(-1)\nconst buy = EVCUS(2)\nreturn { buy, sell }',
  provider: 'stub', model: 'stub-model', usage: { outputTokens: 60 },
  events: 27, searched: true, searches: 3, searchError: '',
  suggestedEvents: [
    { date: '2026-09-09', title: '秋季新品发布会', announcedAt: '2026-08-01', source: 'https://example.com/launch', evidence: '原文：定于 9 月 9 日' },
    { date: '2026-09-20', title: '投资者交流会', announcedAt: null, source: 'https://example.com/ir', evidence: '' },
  ],
}
findButton(tree, '发送') !== undefined ? findButton(tree, '发送').props.onClick() : findButton(tree, '继续追问').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
const suggestText = collectText(tree)
check('提示说明联网查了几次', suggestText.includes('联网查证 3 次'), (suggestText.match(/联网查证 \d+ 次/) || ['未找到'])[0])
check('提示说明有候选日期待确认', suggestText.includes('2 个候选日期待你确认'))
check('候选事件区块渲染出来', collect(tree).some((n) => n.props['data-astk'] === 'suggested-events'))
check('候选事件带日期与出处', suggestText.includes('2026-09-09') && suggestText.includes('https://example.com/launch'))
check('确认前不会写入自定义事件', customEvents.length === 0)
const acceptBtn = collect(tree).find((n) => n.props['data-astk'] === 'accept-suggested')
check('有确认按钮', acceptBtn !== undefined)
acceptBtn.props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
// 原有的自定义事件不能被覆盖掉，新确认的追加进去。
check('确认后写入了自定义事件（原有的一条保留）', customEvents.length === 3, JSON.stringify(customEvents.map((x) => x.date)))
check('写入时带上来源与公告日',
  customEvents.some((x) => x.date === '2026-09-09' && x.source === 'https://example.com/launch' && x.announcedAt === '2026-08-01'),
  JSON.stringify(customEvents.find((x) => x.date === '2026-09-09')))
check('确认后候选区块收起', collect(tree).every((n) => n.props['data-astk'] !== 'suggested-events'))
check('确认后给出反馈', collectText(tree).includes('已把 3 个日期加入该股自定义事件'))
// 试运行必须把「待确认的候选事件」算进去，否则明明能用也会先报一次错。
check('试运行把候选事件算进去了', collectText(tree).includes('已按「交易所事件 + 待确认候选事件」试运行通过'),
  (collectText(tree).match(/已按[^；]*试运行通过/) || ['未找到'])[0])

// 接口失败：显示可读错误（对话里出现一条失败气泡，输入框内容不丢）
generateError = '模型调用失败：配额不足'
setField('ai-description', '再来一版')
findButton(tree, '继续追问').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
check('接口失败时显示可读错误', collectText(tree).includes('配额不足'), (collectText(tree).match(/生成失败：\S+/) || [''])[0])
check('失败也在对话里留痕', collect(tree).some((n) => String(n.props.className || '').includes('astk-msg-err')))
check('失败后输入框内容不丢', byData('ai-description').props.value === '再来一版', byData('ai-description').props.value)
generateError = null

console.log('\n[5c2] 多轮对话 + 表达式模式')
{
  const lastGenerate = () => fetchBodies.map((b) => { try { return JSON.parse(b) } catch { return {} } })
    .filter((b) => typeof b.description === 'string').pop()
  const send = (text) => {
    if (byData('ai-description') === undefined) click('策略配置')
    setField('ai-description', text)
    const btn = findButton(tree, '发送') || findButton(tree, '继续追问')
    btn.props.onClick()
    tree = render()
  }

  // 清空对话重来，避免上一节的上下文干扰
  click('策略配置')
  if (collect(tree).some((n) => n.props['data-astk'] === 'chat-reset')) {
    collect(tree).find((n) => n.props['data-astk'] === 'chat-reset').props.onClick()
    tree = render()
  }
  check('清空后回到初始提示', collectText(tree).includes('一直追问下去'))

  // 第二轮：必须把上一轮的对话一起带上（否则模型不知道上下文）
  generateFixture = {
    code: 'const fast = MA(C, 5)\nreturn { buy: GT(C, fast), sell: LT(C, fast) }',
    provider: 'stub', model: 'stub-model', reply: '先用 5 日线做一版。', usage: { outputTokens: 20 },
  }
  send('写一个收盘价上穿 5 日线买入的策略')
  await tick(); await tick()
  tree = render()
  const firstReq = lastGenerate()
  check('第一轮不带历史', Array.isArray(firstReq.history) && firstReq.history.length === 0, JSON.stringify(firstReq.history))
  check('第一轮带上当前模式', firstReq.mode === 'js' || firstReq.mode === 'expr', String(firstReq.mode))
  check('AI 说明出现在气泡里', collectText(tree).includes('先用 5 日线做一版'))
  const bubbles = (role) => collect(tree).filter((n) => n.props['data-astk'] === 'chat-' + role).length
  check('对话里有一条用户消息与一条 AI 消息', bubbles('user') === 1 && bubbles('assistant') === 1,
    'user=' + bubbles('user') + ' assistant=' + bubbles('assistant'))

  generateFixture = {
    code: 'const fast = MA(C, 5)\nconst volUp = GT(V, MA(V, 20))\nreturn { buy: AND(GT(C, fast), volUp), sell: LT(C, fast) }',
    provider: 'stub', model: 'stub-model', reply: '加上了放量过滤。', usage: { outputTokens: 30 },
  }
  send('再加一个放量过滤')
  await tick(); await tick()
  tree = render()
  const secondReq = lastGenerate()
  check('第二轮把上一轮对话带上', Array.isArray(secondReq.history) && secondReq.history.length === 2,
    JSON.stringify((secondReq.history || []).map((h) => h.role)))
  check('历史里保留了上一轮的角色顺序',
    secondReq.history[0].role === 'user' && secondReq.history[1].role === 'assistant',
    JSON.stringify((secondReq.history || []).map((h) => h.role)))
  check('历史里带着上一轮产出的策略', String(secondReq.history[1].text).includes('MA(C, 5)'),
    String(secondReq.history[1].text).slice(0, 40))
  check('第二轮的新代码已应用', jsEditorValue().includes('volUp'), jsEditorValue().split('\n')[1])
  check('两轮都在对话里', collectText(tree).includes('写一个收盘价上穿 5 日线买入的策略') && collectText(tree).includes('再加一个放量过滤'))

  // 切到表达式模式：AI 必须输出表达式，并填进买入/卖出条件
  byData('mode-expr').props.onClick()
  tree = render()
  generateFixture = {
    mode: 'expr', expr: { buy: 'CROSS(MA(5),MA(20)) AND V>MA(V,20)', sell: 'C<MA(20)' },
    provider: 'stub', model: 'stub-model', reply: '改成金叉且放量买入。', usage: { outputTokens: 25 },
  }
  send('改成金叉且放量')
  await tick(); await tick()
  tree = render()
  check('表达式模式会要求表达式', lastGenerate().mode === 'expr', String(lastGenerate().mode))
  check('表达式填进了买入条件', byData('buy-expr').props.value === 'CROSS(MA(5),MA(20)) AND V>MA(V,20)', byData('buy-expr').props.value)
  check('表达式填进了卖出条件', byData('sell-expr').props.value === 'C<MA(20)', byData('sell-expr').props.value)
  check('说明里写明已更新为表达式并试运行通过', collectText(tree).includes('已更新为表达式策略，已通过试运行校验'),
    (collectText(tree).match(/已更新为表达式策略[^\n]{0,20}/) || ['未找到'])[0])
  const exprRestore = collect(tree).find((n) => n.props['data-astk'] === 'expr-restore')
  check('提供换回上一版表达式的入口', exprRestore !== undefined)

  // 表达式写错时要如实报错，而不是假装通过
  generateFixture = {
    mode: 'expr', expr: { buy: 'CROSS(MA(5)', sell: 'C<MA(20)' },
    provider: 'stub', model: 'stub-model', reply: '再改一版。', usage: { outputTokens: 12 },
  }
  send('改一下')
  await tick(); await tick()
  tree = render()
  check('表达式有语法错时如实报告试运行失败', collectText(tree).includes('试运行报错'),
    (collectText(tree).match(/试运行报错：\S+/) || ['未找到'])[0])

  // 换回上一版表达式
  collect(tree).find((n) => n.props['data-astk'] === 'expr-restore').props.onClick()
  tree = render()
  check('换回后是上一版表达式', byData('buy-expr').props.value === 'CROSS(MA(5),MA(20)) AND V>MA(V,20)',
    byData('buy-expr').props.value)

  // 模型只是反问：不改编辑器，气泡里显示问题
  generateFixture = { mode: '', plain: true, reply: '你想用几分钟均线？要不要加成交量过滤？', provider: 'stub', model: 'stub-model' }
  const buyBefore = byData('buy-expr').props.value
  send('你觉得呢')
  await tick(); await tick()
  tree = render()
  check('反问式回答显示在气泡里', collectText(tree).includes('你想用几分钟均线'))
  check('反问时不改动编辑器', byData('buy-expr').props.value === buyBefore, byData('buy-expr').props.value)
  check('反问时标明本轮未改动策略', collectText(tree).includes('本轮只回答，未改动策略'))

// 策略还指着不存在的事件时：把三条出路写清楚
generateFixture = {
  mode: 'expr', expr: { buy: 'EVCUS(1)', sell: 'EVCUS(-1)' },
  provider: 'stub', model: 'stub-model', reply: '查不到发布日期。', usage: { outputTokens: 18 },
  eventAdvice: '这段策略引用了 EVCUS，但该股当前没有对应的事件数据，直接回测会报错。三条出路：① 再追问一次…；② 到「公司数据」页用手动添加把日期填进去；③ 让它改成不依赖事件因子的写法。',
}
send('小米产品发布会之前卖出')
await tick(); await tick()
tree = render()
const adviceText = collectText(tree)
check('查不到事件时给出出路', adviceText.includes('三条出路') && adviceText.includes('手动添加'), (adviceText.match(/三条出路[^。]*/) || ['未找到'])[0])
// 复原两种模式各一条能跑的普通策略：后面的用例（港股每手股数）依赖这个状态。
byData('mode-expr').props.onClick()
tree = render()
setField('buy-expr', 'CROSS(MA(5),MA(20))')
setField('sell-expr', 'CROSS(MA(20),MA(5))')
byData('mode-js').props.onClick()
tree = render()
setField('js-source', 'const fast = MA(C, 5)\nconst slow = MA(C, 20)\nreturn { buy: CROSS(fast, slow), sell: CROSS(slow, fast) }')

// 宿主搜索坏了、但内置检索顶上时：必须说清楚「这次用的不是宿主搜索」以及怎么修
generateFixture = {
  code: 'return { buy: GT(C, MA(C, 20)), sell: LT(C, MA(C, 20)) }',
  provider: 'stub', model: 'stub-model', reply: '查了一下，用 20 日线。', usage: { outputTokens: 20 },
  searched: true, searches: 2, builtinSearch: true, searchSource: 'builtin',
  searchError: 'DeepSeek returned no web_search_tool_result blocks',
}
send('帮我查一下最近的说明会')
await tick(); await tick()
tree = render()
const searchNoteText = collectText(tree)
check('提示说明用了内置检索', searchNoteText.includes('内置财经资讯检索'), (searchNoteText.match(/联网查证[^，。]*/) || ['未找到'])[0])
check('提示给出修宿主搜索的路径', searchNoteText.includes('设置 → 插件 → 插件配置 → Web search'))
check('提示里带上宿主的原始报错', searchNoteText.includes('no web_search_tool_result'))

  // 清空对话
  collect(tree).find((n) => n.props['data-astk'] === 'chat-reset').props.onClick()
  tree = render()
  check('清空对话后气泡消失',
    collect(tree).every((n) => n.props['data-astk'] !== 'chat-user' && n.props['data-astk'] !== 'chat-assistant'))
}
console.log('\n[5d] 港股')

// 侧栏点击切到港股（汇丰控股，每手 400 股）
const clickWatch = (name) => {
  const item = collect(tree).find((n) => String(n.props.className || '').includes('astk-item') && collectText(n).includes(name))
  if (item === undefined) throw new Error('找不到自选股：' + name)
  item.props.onClick()
  tree = render()
  return collectText(tree)
}
const setNumber = (key, value) => { byData('num-' + key).props.onChange({ target: { value } }); tree = render() }

clickWatch('汇丰控股')
await tick(); await tick()
tree = render()
let hkText = collectText(tree)
check('切到港股并加载行情', fetchCalls.some((u) => u.includes('quote') && u.includes('code=00005')))
check('行情条标出港股', hkText.includes('港股') && hkText.includes('汇丰控股'))
check('显示币种 HKD', hkText.includes('HKD'))
check('显示每手 400 股', hkText.includes('每手股数') && hkText.includes('400'), (hkText.match(/每手股数\s*400/) || [''])[0])

// 事件为空时不能只说「没有」——宿主给了原因就要显示出来，并且提醒事件类策略跑不了。
click('公司数据')
const hkEventText = collectText(tree)
check('港股事件为空时说明原因', hkEventText.includes('港股事件来自港交所公告'), (hkEventText.match(/港股事件来自[^。]*/) || ['未找到原因'])[0])
click('策略配置')
check('没有事件数据时在 AI 面板预警', collect(tree).some((n) => n.props['data-astk'] === 'no-events-warn'))
// 手动添加：上游读不到、或数据源里根本没有的日期，用户自己填。
click('公司数据')
const addPosts = () => fetchCalls.filter((u) => u.includes('/astock/api/custom-events')).length
const beforeAdd = addPosts()
const lastPost = () => fetchBodies.map((b) => { try { return JSON.parse(b) } catch { return {} } })
  .filter((b) => Array.isArray(b.items)).pop()
const dateIn = collect(tree).find((n) => n.props['data-astk'] === 'event-date-in')
const titleIn = collect(tree).find((n) => n.props['data-astk'] === 'event-title-in')
check('事件表有手动添加输入框', dateIn !== undefined && titleIn !== undefined)
dateIn.props.onChange({ target: { value: '2026-10-15' } })
tree = render()
collect(tree).find((n) => n.props['data-astk'] === 'event-title-in').props.onChange({ target: { value: '秋季新品发布会' } })
tree = render()
collect(tree).find((n) => n.props['data-astk'] === 'event-add').props.onClick()
tree = render()
await tick(); await tick()
tree = render()
check('手动添加发出了保存请求', addPosts() === beforeAdd + 1, addPosts() + ' 次')
check('手动添加带上了日期/名称/来源',
  lastPost().items.some((x) => x.date === '2026-10-15' && x.title === '秋季新品发布会' && x.addedBy === 'manual'),
  JSON.stringify(lastPost().items))
check('添加后清空了草稿',
  collect(tree).filter((n) => n.type === 'input').every((n) => String(n.props.value) !== '2026-10-15'))
// 日期没填时不能瞎写
collect(tree).find((n) => n.props['data-astk'] === 'event-add').props.onClick()
tree = render()
await tick()
check('没选日期时不发请求', addPosts() === beforeAdd + 1)

// 上游限流是一时的：得让用户能自己重试，而不是等 30 分钟缓存过期。
click('公司数据')
const reloadBtn = collect(tree).find((n) => n.props['data-astk'] === 'events-reload')
check('事件表有重新加载按钮', reloadBtn !== undefined)
const before = fetchCalls.filter((u) => u.includes('/astock/api/events')).length
reloadBtn.props.onClick()
tree = render()
await tick(); await tick()
check('点重新加载会重新取事件', fetchCalls.filter((u) => u.includes('/astock/api/events')).length > before)
check('港股缺换手率/市净率时显示破折号而非 0', (hkText.match(/换手率—/) || hkText.match(/换手率\s*—/)) !== null, '')

click('策略配置')
let ruleText = collectText(tree)
check('策略页提示当前是港股规则', ruleText.includes('港股') && ruleText.includes('T+0'))
check('明确写出无涨跌停', ruleText.includes('无涨跌停'))

// 资金买不起 1 手（400 × 163 ≈ 65200）：应 0 交易并说清原因
// 注意：[5c] 故意留下了一段写坏的 JS，这里先切回表达式模式拿一个可用策略。
click('策略配置')
byData('mode-expr').props.onClick()
tree = render()
setNumber('capital', 30000)
const poor = await runBacktestNow()
const poorTrades = (poor.match(/\d+交易次数/) || [])[0]
check('买不起 1 手时 0 交易', poorTrades === '0交易次数', '实际 ' + (poorTrades || '未渲染出指标'))
check('提示指出资金不足', poor.includes('资金不足以买入 1 手'), (poor.match(/资金不足[^。]*/) || ['无此提示'])[0])
check('提示写明每手按 400 股', poor.includes('每手按 400 股'), (poor.match(/每手按 \d+ 股（[^）]*）/) || ['无此提示'])[0])
check('提示表明处于港股市场', poor.includes('按【港股】规则'))

// 资金够了就能成交 —— 证明前面挡住它的是每手股数，而不是策略没信号。
// （fixture 里的 K 线复用的是茅台价格 ~1275，400 股一手约需 51 万，故这里给 80 万。）
click('策略配置')
setNumber('capital', 800000)
const rich = await runBacktestNow()
const richTrades = (rich.match(/\d+交易次数/) || [])[0]
check('资金充足后能成交', richTrades !== undefined && richTrades !== '0交易次数', '实际 ' + (richTrades || '未渲染出指标'))
check('提示写明数据未经复权', rich.includes('不复权') || rich.includes('除权除息'), (rich.match(/数据口径[^。]*。/) || ['无此提示'])[0])

// 切回 A 股：规则应随之变回 T+1 与涨跌停
click('K线')
clickWatch('贵州茅台')
await tick(); await tick()
tree = render()
click('策略配置')
ruleText = collectText(tree)
check('切回 A 股后规则变回 T+1', ruleText.includes('A股') && ruleText.includes('T+1'))
check('A 股规则提到涨跌停', ruleText.includes('涨跌停'))

console.log('\n[5e] 回测区间')

click('策略配置')
check('顶部操作条有回测按钮', findButton(tree, '开始回测') !== undefined)
check('顶部有起止日期输入', byData('date-btFrom') !== undefined && byData('date-btTo') !== undefined)
check('有「全部」档位按钮', findButton(tree, '全部') !== undefined)

// 默认区间 = 三年
const currentYear = new Date().getFullYear()
const defFrom = String(byData('date-btFrom').props.value)
check('回测起始日默认为三年前', defFrom.startsWith(String(currentYear - 3) + '-'), defFrom)
check('默认结束日留空（取到最新）', byData('date-btTo').props.value === '')
check('年份快捷档位齐全', ['近1年', '近3年', '近5年', '近10年', '全部'].every((t) => findButton(tree, t) !== undefined))

// 设定区间后应先预告命中根数，再按区间回测
setField('date-btFrom', '2026-01-01')
setField('date-btTo', '2026-06-30')
check('设定区间后预告命中根数', collectText(tree).includes('所选区间命中'), (collectText(tree).match(/所选区间命中 \d+ 根 K 线/) || ['无此提示'])[0])

const ranged = await runBacktestNow()
const span = /回测区间：(\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})（(\d+) 根/.exec(ranged)
check('结果页显示实际回测区间', span !== null, span ? span[0] : '未找到区间行')
if (span !== null) {
  check('起始日不早于所选起点', span[1] >= '2026-01-01', span[1])
  check('结束日不晚于所选终点', span[2] <= '2026-06-30', span[2])
  check('根数确实少于全部区间', Number(span[3]) > 0 && Number(span[3]) < 800, span[3] + ' 根（全部 800 根）')
  check('提示说明区间被裁剪', ranged.includes('已按所选区间切出'), (ranged.match(/已按所选区间切出[^。]*。/) || ['无此提示'])[0])
}

// 区间太窄：给可读错误而不是静默 0
click('策略配置')
setField('date-btFrom', '2026-09-01')
setField('date-btTo', '2026-09-05')
const narrow = await runBacktestNow()
check('区间过窄时给出可读错误', narrow.includes('至少需要 30 根'), (narrow.match(/所选区间只有[^。]*。/) || ['无此提示'])[0])

// 起点早于已加载数据：提示去 K 线页调大年数
click('策略配置')
setField('date-btFrom', '2015-01-01')
setField('date-btTo', '')
const early = await runBacktestNow()
check('起点早于已加载数据时给出可读提示', early.includes('早于已加载'), (early.match(/起始日[^。]*。/) || ['无此提示'])[0])

// 全部区间：恢复
click('策略配置')
findButton(tree, '全部').props.onClick()
tree = render()
const full = await runBacktestNow()
const fullSpan = /回测区间：(\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})（(\d+) 根/.exec(full)
check('点「全部」档位后恢复全部 800 根', fullSpan !== null && Number(fullSpan[3]) === 800, fullSpan ? fullSpan[3] + ' 根' : '未找到')

// 年份档位：一键跳年，不用在原生日期选择器里按月翻
click('策略配置')
findButton(tree, '近1年').props.onClick()
tree = render()
check('「近1年」写入起始日', String(byData('date-btFrom').props.value).startsWith(String(currentYear - 1) + '-'), String(byData('date-btFrom').props.value))

const callsBeforeBump = fetchCalls.length
findButton(tree, '近10年').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
check('「近10年」写入起始日', String(byData('date-btFrom').props.value).startsWith(String(currentYear - 10) + '-'), String(byData('date-btFrom').props.value))
// 已加载只有 3 年，选 10 年时应自动多取数据，而不是给一个被静默裁剪的区间
check('选更长档位会自动调大 K 线年数并重新取数',
  fetchCalls.slice(callsBeforeBump).some((u) => u.includes('kline') && u.includes('years=10')),
  fetchCalls.slice(callsBeforeBump).filter((u) => u.includes('kline')).join(' | ') || '没有发起新的取数')

console.log('\n[5f] 免责声明')

const classNameOf = (n) => String(n.props.className || '')
const hasGate = () => collect(tree).some((n) => classNameOf(n) === 'astk-gate')

// 页脚常驻：无论确认与否都应可见，这是「即使弹窗没出来声明也在」的兜底
check('页脚常驻显示免责声明', collectText(tree).includes('不构成投资建议'), (collectText(tree).match(/⚠️[^⚠]{0,50}/) || ['未找到页脚'])[0])
check('已确认时不弹确认框', hasGate() === false)

// 翻成未确认并重新挂载（模拟首次打开）
disclaimerAccepted = false
hookState.length = 0
hookIndex = 0
tree = render()
await tick(); await tick()
tree = render()
const gateText = collectText(tree)
check('未确认时弹出确认框', hasGate())
check('弹窗显示条款标题', gateText.includes('免责声明与使用条款'))
check('弹窗列出全部条款', gateText.includes('不构成任何投资建议') && gateText.includes('不作任何保证'))
check('弹窗有确认按钮', findButton(tree, '我已阅读并理解') !== undefined)

findButton(tree, '我已阅读并理解').props.onClick()
tree = render()
await tick(); await tick()
tree = render()
check('确认后弹窗消失', hasGate() === false)
check('确认后页脚仍在', collectText(tree).includes('不构成投资建议'))

// 确认写盘失败：弹窗必须保留，不能「点了就等于同意」
disclaimerAccepted = false
disclaimerAcceptFails = true
hookState.length = 0
hookIndex = 0
tree = render()
await tick(); await tick()
tree = render()
check('（重置）未确认时再次弹出', hasGate())
findButton(tree, '我已阅读并理解').props.onClick()
tree = render()
await tick(); await tick()
tree = render()
check('确认失败时弹窗保留', hasGate())
check('确认失败时给出提示', collectText(tree).includes('免责声明确认未保存'), (collectText(tree).match(/免责声明确认未保存[^。]{0,30}/) || ['无提示'])[0])
disclaimerAcceptFails = false

console.log('\n[5g] 市场情绪因子')

// 干净重挂载并确保选中 A 股（前面的用例改过状态）
disclaimerAccepted = true
indexAvailable = true
hookState.length = 0
hookIndex = 0
tree = render()
await tick(); await tick(); await tick(); await tick()
tree = render()

click('策略配置')
const factorText = collectText(tree)
check('策略页有情绪因子面板', factorText.includes('市场情绪因子'))
check('因子面板给出了数值（不是「不可用」）', byData('factor-rs') !== undefined, factorText.includes('未取到大盘指数') ? '面板显示指数不可用' : '')
check('有两个用情绪因子的模板',
  findButton(tree, '相对强弱 RS 择时') !== undefined && findButton(tree, '大盘趋势 + 相对强弱') !== undefined)

// ---- 正确性：用 fixture 独立算一遍，和界面显示的比对 ----
// 面板取的是「最后一个非空值」，fixture 里就是最后一根。
const last = bars.length - 1
const benchClose = INDEX_BARS.map((b) => b[2])
const expectRs = (bars[last][2] / bars[last - 20][2]) / (benchClose[last] / benchClose[last - 20])
const shownRs = byData('factor-rs').props.children
check('RS(20) 与手算一致',
  Math.abs(Number(shownRs) - expectRs) < 5e-4,
  '显示 ' + shownRs + ' vs 手算 ' + expectRs.toFixed(3))

const expectIdxret = benchClose[last] / benchClose[last - 20] - 1
const shownIdxret = Number(String(byData('factor-idxret').props.children).replace('%', '')) / 100
check('IDXRET(20) 与手算一致',
  Math.abs(shownIdxret - expectIdxret) < 5e-5,
  '显示 ' + shownIdxret.toFixed(4) + ' vs 手算 ' + expectIdxret.toFixed(4))

// 指数偏离均线：正负号必须和「指数相对 60 日均线」一致
let ma60 = 0
for (let i = last - 59; i <= last; i++) ma60 += benchClose[i]
ma60 /= 60
const expectIdxdev = benchClose[last] / ma60 - 1
const shownIdxdev = Number(String(byData('factor-idxdev').props.children).replace('%', '')) / 100
check('IDXDEV(60) 与手算一致',
  Math.abs(shownIdxdev - expectIdxdev) < 5e-5,
  '显示 ' + shownIdxdev.toFixed(4) + ' vs 手算 ' + expectIdxdev.toFixed(4))

// ---- 因子真的能用进策略，并产生交易 ----
// 切到 JS 模式（前面的用例可能停在表达式模式），再写入策略
const useJs = (code) => {
  click('策略配置')
  if (byData('js-source') === undefined) {
    byData('mode-js').props.onClick()
    tree = render()
  }
  setField('js-source', code)
}
useJs([
  '// RS 恒为正，所以这个条件等价于「大盘没暴跌」，用来验证因子能参与信号',
  'const rs = RS(20)',
  'const fast = MA(C, 5)',
  'const slow = MA(C, 20)',
  'return {',
  '  buy: AND(CROSS(fast, slow), GT(rs, 0)),',
  '  sell: CROSS(slow, fast),',
  '}',
].join('\n'))
const rsRun = await runBacktestNow()
check('用 RS 的策略能跑通', !rsRun.includes('错误'), (rsRun.match(/JS 策略错误[^]{0,40}/) || [''])[0])
const rsTrades = (rsRun.match(/(\d+)交易次数/) || [])[1]
check('RS 条件参与后仍产生真实交易', rsTrades !== undefined && Number(rsTrades) > 0, rsTrades + ' 笔')

// ---- 指数取不到时，必须给可读错误而不是静默算错 ----
// 必须让 years 变成一个**从未取过**的值，否则指数缓存会直接命中：
// 区间档位只把 years 往大调，所以改走「K线」页的年数按钮设成 5 年。
indexAvailable = false
click('K线')
findButton(tree, '5年').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
useJs('return { buy: GT(RS(20), 0), sell: LT(RS(20), 0) }')
const noIndex = await runBacktestNow()
check('指数不可用时给出可读错误',
  noIndex.includes('市场情绪因子需要大盘指数'),
  (noIndex.match(/JS 策略错误[^]{0,70}/) || ['无错误信息'])[0])
indexAvailable = true

console.log('\n[5h] 交易明细：为什么买 / 为什么卖')

// 用一条「金叉 OR 恒假条件」的策略：交易照常发生，同时能验证界面会如实
// 展示**不成立**的条件，而不是只把成立的那条挑出来说。
click('策略配置')
if (byData('buy-expr') === undefined) {
  byData('mode-expr').props.onClick()
  tree = render()
}
setField('buy-expr', 'CROSS(MA(5),MA(20)) OR RSI(14)<0')
setField('sell-expr', 'CROSS(MA(20),MA(5)) OR RSI(14)>100')
const whyRun = await runBacktestNow()
const whyTrades = (whyRun.match(/(\d+)交易次数/) || [])[1]
check('该策略产生了交易', whyTrades !== undefined && Number(whyTrades) > 0, whyTrades + ' 笔')

const tRows = () => collect(tree).filter((n) => String(classNameOf(n)).split(' ')[0] === 'astk-trow')
check('交易行存在', tRows().length > 0, tRows().length + ' 行')
check('展开前没有明细行', collect(tree).every((n) => String(classNameOf(n)).split(' ')[0] !== 'astk-trow-detail'))

const firstRow = tRows()[0]
check('交易行可点击', typeof firstRow.props.onClick === 'function')
firstRow.props.onClick()
tree = render()

const detailText = collectText(tree)
check('点击后展开明细', collect(tree).some((n) => String(classNameOf(n)).split(' ')[0] === 'astk-trow-detail'))
check('明细里分列了买卖两段原因', detailText.includes('为什么买') && detailText.includes('为什么卖'))
check('写明了信号日与成交日的关系',
  detailText.includes('信号日') && detailText.includes('收盘') && detailText.includes('开盘'),
  (detailText.match(/信号日[^（]*（收盘） → 成交日[^（]*（开盘[^）]*）/) || ['未找到'])[0])

// 关键：必须把表达式**拆成一条条条件**，并给出可核对的数值
check('买入条件被拆解出来', detailText.includes('CROSS(MA(5), MA(20))'))
check('不成立的条件也被如实列出', detailText.includes('RSI(14) < 0'), '')
check('买卖两侧的条件都在', detailText.includes('CROSS(MA(20), MA(5))') && detailText.includes('RSI(14) > 100'))
const conds = collect(tree).filter((n) => String(classNameOf(n)).split(' ')[0] === 'astk-cond')
check('逐条件渲染成行', conds.length >= 4, conds.length + ' 条条件行')
check('给出了比较两侧的具体数值', detailText.includes('vs'), (detailText.match(/[\d.]+ {2}vs {2}[\d.]+/) || ['未找到数值证据'])[0])
const marks = collect(tree).filter((n) => String(classNameOf(n)).includes('astk-cond-m')).map((n) => collectText(n))
check('条件带成立/不成立标记', marks.includes('✓') && marks.includes('✗'), JSON.stringify(marks))

// 再点一次应收回
tRows()[0].props.onClick()
tree = render()
check('再次点击收起明细', collect(tree).every((n) => String(classNameOf(n)).split(' ')[0] !== 'astk-trow-detail'))

// ---- JS 模式（条件函数组合）：必须自动拆出「哪条条件成立、两边数值多少」 ----
useJs([
  'const fast = MA(C, 5)',
  'const slow = MA(C, 20)',
  'const volUp = GT(V, MA(V, 20))',
  '// 恒假条件：必须被如实列成 ✗，用来说明系统没有编造原因',
  'const never = GT(RSI(14), 200)',
  'const notDumping = NOT(LT(C, MA(C, 20)))',
  'const buy = AND(AND(CROSS(fast, slow), volUp), notDumping)',
  'const sell = OR(CROSS(slow, fast), never)',
  'function why(i, side) {',
  '  return side === "buy" ? "第 " + i + " 根：5 日线上穿 20 日线且放量" : "5 日线下穿 20 日线"',
  '}',
  'return { buy, sell, why }',
].join('\n'))
const jsWhyRun = await runBacktestNow()
check('JS 策略产生了交易', /(\d+)交易次数/.test(jsWhyRun), (jsWhyRun.match(/\d+交易次数/) || ['未渲染'])[0])
tRows()[0].props.onClick()
tree = render()
const jsDetail = collectText(tree)
check('JS 模式不再只说「无法定位」', jsDetail.includes('无法自动归因') === false)
check('JS 模式拆出了具体条件', jsDetail.includes('CROSS(MA(C, 5), MA(C, 20))'), (jsDetail.match(/CROSS\([^)]*\)[^ ]*/) || ['未找到'])[0])
check('JS 模式给条件配了数值证据', /今 [\d.]+ vs [\d.]+/.test(jsDetail), (jsDetail.match(/今 [\d.]+ vs [\d.]+/) || ['未找到'])[0])
check('交叉条件同时给出前一根', jsDetail.includes('／　前 '), (jsDetail.match(/前 [\d.]+ vs [\d.]+/) || ['未找到'])[0])
check('AND 逻辑节点被标出', jsDetail.includes('全部条件成立（AND）'))
check('OR 逻辑节点被标出', jsDetail.includes('任一条件成立（OR）'))
check('NOT 逻辑节点被标出', jsDetail.includes('取反（NOT）') && jsDetail.includes('C < MA(C, 20)'))
check('恒假条件被如实列成不成立', jsDetail.includes('RSI(14) > 200'))
check('why 钩子的自述原因被展示在明细里',
  jsDetail.includes('策略自述原因') && jsDetail.includes('5 日线上穿 20 日线且放量'))
const hitRows = collect(tree).filter((n) => String(classNameOf(n)).includes('astk-cond-hit'))
check('标出了本次实际触发项', hitRows.length > 0, hitRows.length + ' 条加重显示')
check('触发项里没有不成立的条件',
  hitRows.every((n) => collectText(n).includes('✓') || collectText(n).includes('·')),
  hitRows.map((n) => collectText(n).slice(0, 24)).join(' | '))
// OR 分支里恒假的那条不能算触发源——这正是「基于哪个点」的关键
check('OR 里没成立的分支不算触发源',
  hitRows.every((n) => collectText(n).includes('RSI(14) > 200') === false),
  hitRows.map((n) => collectText(n).slice(0, 20)).join(' | '))

// ---- 原生比较：拆不出来时必须如实说明，并给出两条可操作的出路 ----
const rawStrategy = [
  'const fast = MA(C, 5)',
  'const slow = MA(C, 20)',
  '// 故意用原生比较：系统拿不到条件函数留下的标记，只能给快照',
  'const buy = [], sell = []',
  'buy.push(0); sell.push(0)',
  'for (let i = 1; i < C.length; i++) {',
  '  buy.push(C[i] > slow[i] ? 1 : 0)',
  '  sell.push(C[i] < slow[i] ? 1 : 0)',
  '}',
  'return { buy, sell }',
].join('\n')
useJs(rawStrategy)
const rawRun = await runBacktestNow()
check('原生 JS 策略也能跑', /(\d+)交易次数/.test(rawRun), (rawRun.match(/\d+交易次数/) || ['未渲染'])[0])
tRows()[0].props.onClick()
tree = render()
const rawDetail = collectText(tree)
check('原生比较时如实说明无法自动归因', rawDetail.includes('无法自动归因'))
check('给出了两条出路（条件函数 / why 钩子）',
  rawDetail.includes('why(i, side)') && rawDetail.includes('GT / LT / GTE / LTE / CROSS'))
check('兜底仍给出指标快照', rawDetail.includes('指标快照') && rawDetail.includes('MACD()'))
check('兜底不假装自己是条件拆解',
  rawDetail.includes('全部条件成立') === false && rawDetail.includes('CROSS(MA(C, 5), MA(C, 20))') === false)

// ---- 一键改写：把「不可归因」的代码交给 AI 改成带证据的版本，且旧代码可换回 ----
const rawSource = rawStrategy
// 前面的用例把生成结果改成了语法错的半截代码，这里换回一段真实可归因的策略。
generateFixture = {
  code: [
    'const fast = MA(C, 10)',
    'const slow = MA(C, 30)',
    'const never = GT(RSI(14), 200)',
    'const buy = CROSS(fast, slow)',
    'const sell = OR(CROSS(slow, fast), never)',
    'const why = (i, side) => side === "buy" ? "10 日线上穿 30 日线" : "10 日线下穿 30 日线"',
    'return { buy, sell, why }',
  ].join('\n'),
  provider: 'stub', model: 'stub-model', usage: { outputTokens: 55 },
}
const rewriteBtn = collect(tree).find((n) => n.props['data-astk'] === 'why-rewrite')
check('兜底里给出一键改写按钮', rewriteBtn !== undefined)
rewriteBtn.props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
const rewriteReq = fetchBodies.map((b) => { try { return JSON.parse(b) } catch { return {} } })
  .find((b) => String(b.description || '').includes('买卖逻辑必须完全不变'))
check('改写请求带上了当前策略代码', rewriteReq !== undefined && rewriteReq.currentCode === rawSource)
check('改写指令要求用条件函数组合', String(rewriteReq.description).includes('原生比较'))
check('改写指令要求补 why 钩子', String(rewriteReq.description).includes('why(i, side)'))
check('改写后的代码进了编辑器', jsEditorValue() === generateFixture.code, jsEditorValue().slice(0, 40))
check('改写后自动切到策略页', byData('ai-description') !== undefined)

// 改写的意义就在这里：同一份逻辑，改写后明细里立刻有了执行证据。
const rewrittenRun = await runBacktestNow()
check('改写后的策略能跑通', /(\d+)交易次数/.test(rewrittenRun), (rewrittenRun.match(/\d+交易次数/) || ['未渲染'])[0])
tRows()[0].props.onClick()
tree = render()
const rewrittenDetail = collectText(tree)
check('改写后明细自动拆出了条件', rewrittenDetail.includes('CROSS(MA(C, 10), MA(C, 30))'))
check('改写后明细不再说「无法自动归因」', rewrittenDetail.includes('无法自动归因') === false)
check('改写后 why 自述也一并展示', rewrittenDetail.includes('10 日线上穿 30 日线'))

click('策略配置')
const restoreBtn = collect(tree).find((n) => n.props['data-astk'] === 'js-restore')
check('提供换回改写前代码的入口', restoreBtn !== undefined)
restoreBtn.props.onClick()
tree = render()
check('换回后编辑器内容是原策略', jsEditorValue() === rawSource, jsEditorValue().slice(0, 40))

console.log('\n[5i] 事件因子：真实日期 + 交易日换算 + 不许提前知道')

// 「公司开发布会的前一个交易日卖出、会后的第二个交易日买入」这类策略，缺的不是
// 写代码的能力，而是真实日期。这一节验证：日期是真实的、交易日换算按 K 线做、
// 而且**当天才公告的事件不许被提前埋伏**。
eventsAvailable = true
hookState.length = 0
hookIndex = 0
tree = render()
await tick(); await tick(); await tick(); await tick()
tree = render()

// 1) 公司数据页要能看到真实事件日期（用户得先能看见，才谈得上用它）
click('公司数据')
const evText = collectText(tree)
check('公司数据页有公司动态', evText.includes('公司动态'))
const evDates = collect(tree).filter((n) => n.props['data-astk'] === 'event-date').map((n) => collectText(n))
check('事件日期渲染出来了', evDates.includes(dayAt(I_A)) && evDates.includes(dayAt(I_C)), JSON.stringify(evDates))
check('事件类型带徽标', evText.includes('说明会') && evText.includes('除权除息'))
check('写明了事件日期事先公开', evText.includes('事先公开'))
check('写明了用的是预约披露日', evText.includes('预约披露日'))

click('策略配置')
check('有事件因子模板', findButton(tree, '说明会前后') !== undefined)

// 2) EVMEET 的语义：事件日映射、非交易日顺延、以及「当天才公告」的拦截
useJs([
  '// 会前一个交易日买、会后第 10 个交易日卖，全程只用真实事件日期',
  'return {',
  '  buy: EVMEET(-1),',
  '  sell: EVMEET(10),',
  '  why: (i) => "第 " + i + " 根：说明会前一个交易日",',
  '}',
].join('\n'))
const evRun = await runBacktestNow()
check('事件策略能跑通', !evRun.includes('错误'), (evRun.match(/JS 策略错误[^]{0,60}/) || [''])[0])
// 事件 C 当天才公告：EVMEET(-1) 若抓到它就会多出第三笔交易。
check('当天才公告的事件抓不到（只 2 笔交易）', tradesOf(evRun) === '2', tradesOf(evRun) + ' 笔')
check('事件策略产生两根交易行', tRows().length === 2, tRows().length + ' 行')

// 交易行是倒序渲染的：tRows()[0] 是最后一笔（事件 B）
tRows()[1].props.onClick()
tree = render()
const evDetailA = collectText(tree)
check('事件 A：买入信号落在会前一个交易日', evDetailA.includes('信号日 ' + dayAt(I_A - 1)),
  (evDetailA.match(/信号日 [\d-]+/) || ['未找到'])[0])
check('事件 A：卖出信号落在会后第 10 个交易日', evDetailA.includes('信号日 ' + dayAt(I_A + 10)))
check('明细写明命中的是哪个真实事件',
  evDetailA.includes('命中 ' + dayAt(I_A) + ' 2026年半年度业绩说明会'),
  (evDetailA.match(/命中[^，。]{0,40}/) || ['未找到命中说明'])[0])
check('事件条件被当作条件拆解（不是快照）',
  evDetailA.includes('EVMEET(-1)') && evDetailA.includes('无法自动归因') === false)
tRows()[1].props.onClick()
tree = render()

tRows()[0].props.onClick()
tree = render()
const evDetailB = collectText(tree)
// 事件 B 的日期落在两根 K 线之间（周末）：必须顺延到之后第一个交易日，
// 所以「会前一个交易日」是 I_B-1 —— 若错误地取前一根 K 线，这里会是 I_B-2。
check('非交易日的会议顺延到之后第一个交易日', evDetailB.includes('信号日 ' + dayAt(I_B - 1)),
  '期望 ' + dayAt(I_B - 1) + ' / 全文 ' + (evDetailB.match(/信号日 [\d-]+/) || ['未找到'])[0])
tRows()[0].props.onClick()
tree = render()

// 2b) 自定义事件：单独一类，只由 EVCUS 引用，界面上标成「未核实」
click('公司数据')
const customText = collectText(tree)
check('自定义事件渲染在事件表里', customText.includes('AI 查到的产品发布会') && customText.includes('自定义'))
check('自定义事件标为未核实', customText.includes('未核实'))
check('自定义事件给出出处链接',
  collect(tree).some((n) => n.type === 'a' && n.props.href === 'https://example.com/launch'))
check('自定义事件提示了公告日未知的处理方式', customText.includes('公告日未知（按事先已知处理）'))
check('自定义事件可以删除', collect(tree).some((n) => n.props['data-astk'] === 'event-del'))
// EVMEET 只认会议事件：自定义事件混进来的话，上面的「只 2 笔」就会变成 4 笔。
check('自定义事件没有混进 EVMEET', tradesOf(evRun) === '2', tradesOf(evRun) + ' 笔')

click('策略配置')
useJs([
  '// 自定义事件（AI 检索经用户确认）用自己的因子，与交易所事件互不干扰',
  'return {',
  '  buy: EVCUS(-1),',
  '  sell: EVCUS(2),',
  '  why: () => "AI 查到的发布会前一天买入",',
  '}',
].join('\n'))
const evcusRun = await runBacktestNow()
check('自定义事件策略能跑通', !evcusRun.includes('错误'), (evcusRun.match(/JS 策略错误[^]{0,60}/) || [''])[0])
check('自定义事件产生了交易', Number(tradesOf(evcusRun)) >= 1, tradesOf(evcusRun) + ' 笔')
tRows()[0].props.onClick()
tree = render()
const evcusDetail = collectText(tree)
check('自定义事件的买入信号落在事件前一交易日',
  evcusDetail.includes('信号日 ' + dayAt(BAR_N - 141)),
  (evcusDetail.match(/信号日 [\d-]+/) || ['未找到'])[0])
check('明细写明命中的自定义事件',
  evcusDetail.includes('命中 ' + dayAt(BAR_N - 140) + ' AI 查到的产品发布会'),
  (evcusDetail.match(/命中[^，。]{0,40}/) || ['未找到命中说明'])[0])

// 2c) 表达式模式也要能用事件因子（含负数参数）——AI 在表达式模式下会这么输出
click('策略配置')
byData('mode-expr').props.onClick()
tree = render()
setField('buy-expr', 'EVCUS(-1)')
setField('sell-expr', 'EVCUS(2)')
const exprEvRun = await runBacktestNow()
check('表达式模式的事件因子能跑通', !exprEvRun.includes('错误'), (exprEvRun.match(/表达式错误[^]{0,50}/) || [''])[0])
check('表达式模式的事件因子产生了交易', Number(tradesOf(exprEvRun)) >= 1, tradesOf(exprEvRun) + ' 笔')
tRows()[0].props.onClick()
tree = render()
check('表达式模式同样写明命中的事件',
  collectText(tree).includes('命中 ' + dayAt(BAR_N - 140) + ' AI 查到的产品发布会'),
  (collectText(tree).match(/命中[^，。]{0,40}/) || ['未找到命中说明'])[0])
tRows()[0].props.onClick()
tree = render()

// 3) 取不到事件数据时必须说清楚，而不是静默算成「没有信号」
eventsAvailable = false
hookState.length = 0
hookIndex = 0
tree = render()
await tick(); await tick(); await tick(); await tick()
tree = render()
click('公司数据')
check('事件取数失败时页面给出错误', collectText(tree).includes('事件日期加载失败'))
click('策略配置')
const evFail = await runBacktestNow()
check('没有事件数据时策略给出可读错误',
  evFail.includes('事件因子需要事件数据') && evFail.includes('手动添加日期'),
  (evFail.match(/JS 策略错误[^]{0,60}/) || ['无错误信息'])[0])
eventsAvailable = true

console.log('\n[6] 图标组件')
const icon = iconReg.component({ size: 20, active: true })
check('图标返回 svg', icon.type === 'svg' && icon.props.width === 20)
const iconIdle = iconReg.component({ size: 18, active: false })
check('非激活态使用次级色', collect(iconIdle).some((n) => String(n.props.stroke).includes('label-secondary')))

console.log('\n================  ' + pass + ' 通过 / ' + fail + ' 失败  ================')
process.exit(fail > 0 ? 1 : 0)
