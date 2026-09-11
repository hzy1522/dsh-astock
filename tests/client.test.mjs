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
// 让测试可以模拟「指数取不到」的情况
let indexAvailable = true
// AI 生成接口的响应可被测试改写，用来验证成功与失败两条路径。
let generateFixture = {
  code: 'const fast = MA(C, 10)\nconst slow = MA(C, 30)\nreturn { buy: CROSS(fast, slow), sell: CROSS(slow, fast) }',
  provider: 'stub', model: 'stub-model', usage: { inputTokens: 120, outputTokens: 42 },
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
globalThis.fetch = async (url, init) => {
  const raw = String(url)
  fetchCalls.push(raw)
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
findButton(tree, 'JavaScript').props.onClick()
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
check('策略页：有 AI 生成入口', findButton(tree, 'AI 生成代码') !== undefined && byData('ai-description') !== undefined)

// 未填描述就点生成：给提示，且不应发请求
const callsBefore = fetchCalls.length
findButton(tree, 'AI 生成代码').props.onClick()
tree = render()
await tick()
tree = render()
check('未填描述时给出提示', collectText(tree).includes('先用一句话描述'))
check('未填描述时不请求模型', fetchCalls.length === callsBefore, '新增 ' + (fetchCalls.length - callsBefore) + ' 次请求')

// 正常生成
setField('ai-description', '10 日均线上穿 30 日均线买入，下穿卖出')
findButton(tree, 'AI 生成代码').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
let aiText = collectText(tree)
check('发起了生成请求', fetchCalls.some((u) => u.includes('generate-strategy')))
check('生成的代码填入编辑器', jsEditorValue().includes('const fast = MA(C, 10)'), jsEditorValue().split('\n')[0])
check('自动切到 JS 模式', aiText.includes('JavaScript：写任意代码'))
check('提示带模型名与用量', aiText.includes('stub-model') && aiText.includes('42 tokens'))
check('生成后立即试运行校验通过', aiText.includes('已通过试运行校验'))

// 生成结果语法有错：仍填入便于手改，但提示试运行失败
generateFixture = { code: 'const a = ', provider: 'stub', model: 'stub-model', usage: { outputTokens: 3 } }
findButton(tree, 'AI 生成代码').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
check('生成结果有问题时提示试运行报错', collectText(tree).includes('试运行报错'), (collectText(tree).match(/试运行报错：\S+/) || [''])[0])
check('有问题的代码仍填入编辑器', jsEditorValue() === 'const a = ')

// 接口失败：显示可读错误
generateError = '模型调用失败：配额不足'
findButton(tree, 'AI 生成代码').props.onClick()
tree = render()
await tick(); await tick(); await tick()
tree = render()
check('接口失败时显示可读错误', collectText(tree).includes('配额不足'), (collectText(tree).match(/生成失败：\S+/) || [''])[0])
generateError = null

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
check('港股缺换手率/市净率时显示破折号而非 0', (hkText.match(/换手率—/) || hkText.match(/换手率\s*—/)) !== null, '')

click('策略配置')
let ruleText = collectText(tree)
check('策略页提示当前是港股规则', ruleText.includes('港股') && ruleText.includes('T+0'))
check('明确写出无涨跌停', ruleText.includes('无涨跌停'))

// 资金买不起 1 手（400 × 163 ≈ 65200）：应 0 交易并说清原因
// 注意：[5c] 故意留下了一段写坏的 JS，这里先切回表达式模式拿一个可用策略。
click('策略配置')
findButton(tree, '表达式').props.onClick()
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
    findButton(tree, 'JavaScript').props.onClick()
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

console.log('\n[6] 图标组件')
const icon = iconReg.component({ size: 20, active: true })
check('图标返回 svg', icon.type === 'svg' && icon.props.width === 20)
const iconIdle = iconReg.component({ size: 18, active: false })
check('非激活态使用次级色', collect(iconIdle).some((n) => String(n.props.stroke).includes('label-secondary')))

console.log('\n================  ' + pass + ' 通过 / ' + fail + ' 失败  ================')
process.exit(fail > 0 ? 1 : 0)
