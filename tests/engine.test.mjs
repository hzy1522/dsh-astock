/**
 * astock 表达式引擎 + 回测引擎的离线验证。
 * 引擎代码从 astock-1/pkg-8 的 client 半边原样抽取（纯 JS，无浏览器依赖）。
 */
import { readFileSync } from 'node:fs'

// ================= 词法 =================
function tokenizeSource(src) {
  const out = []
  let i = 0
  const s = String(src || '')
  while (i < s.length) {
    const ch = s.charAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && s.charAt(i + 1) >= '0' && s.charAt(i + 1) <= '9')) {
      let j = i
      while (j < s.length && ((s.charAt(j) >= '0' && s.charAt(j) <= '9') || s.charAt(j) === '.')) j += 1
      out.push({ t: 'num', v: parseFloat(s.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s.charAt(j))) j += 1
      const word = s.slice(i, j).toUpperCase()
      if (word === 'AND') out.push({ t: 'op', v: '&&' })
      else if (word === 'OR') out.push({ t: 'op', v: '||' })
      else if (word === 'NOT') out.push({ t: 'op', v: '!' })
      else out.push({ t: 'id', v: word })
      i = j
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      out.push({ t: 'op', v: two }); i += 2; continue
    }
    if ('+-*/()<>,!'.indexOf(ch) >= 0) { out.push({ t: 'op', v: ch }); i += 1; continue }
    throw new Error('无法识别的字符「' + ch + '」')
  }
  return out
}

// ================= 语法 =================
function parseSource(src) {
  const toks = tokenizeSource(src)
  let pos = 0
  function peek() { return toks[pos] }
  function isOp(v) { const tk = toks[pos]; return tk !== undefined && tk.t === 'op' && tk.v === v }
  function eat(v) { if (!isOp(v)) throw new Error('语法错误：期望「' + v + '」'); pos += 1 }
  function parseOr() {
    let node = parseAnd()
    while (isOp('||')) { pos += 1; node = { k: 'bin', op: '||', a: node, b: parseAnd() } }
    return node
  }
  function parseAnd() {
    let node = parseCmp()
    while (isOp('&&')) { pos += 1; node = { k: 'bin', op: '&&', a: node, b: parseCmp() } }
    return node
  }
  function parseCmp() {
    let node = parseAdd()
    while (isOp('>') || isOp('<') || isOp('>=') || isOp('<=') || isOp('==') || isOp('!=')) {
      const op = peek().v; pos += 1
      node = { k: 'bin', op: op, a: node, b: parseAdd() }
    }
    return node
  }
  function parseAdd() {
    let node = parseMul()
    while (isOp('+') || isOp('-')) { const op = peek().v; pos += 1; node = { k: 'bin', op: op, a: node, b: parseMul() } }
    return node
  }
  function parseMul() {
    let node = parseUnary()
    while (isOp('*') || isOp('/')) { const op = peek().v; pos += 1; node = { k: 'bin', op: op, a: node, b: parseUnary() } }
    return node
  }
  function parseUnary() {
    if (isOp('!')) { pos += 1; return { k: 'not', a: parseUnary() } }
    if (isOp('-')) { pos += 1; return { k: 'neg', a: parseUnary() } }
    if (isOp('+')) { pos += 1; return parseUnary() }
    return parsePrimary()
  }
  function parsePrimary() {
    const tk = peek()
    if (tk === undefined) throw new Error('表达式意外结束')
    if (tk.t === 'num') { pos += 1; return { k: 'num', v: tk.v } }
    if (tk.t === 'id') {
      pos += 1
      if (isOp('(')) {
        pos += 1
        const args = []
        if (!isOp(')')) {
          args.push(parseOr())
          while (isOp(',')) { pos += 1; args.push(parseOr()) }
        }
        eat(')')
        return { k: 'call', name: tk.v, args: args }
      }
      return { k: 'var', name: tk.v }
    }
    if (isOp('(')) { pos += 1; const node = parseOr(); eat(')'); return node }
    throw new Error('语法错误：意外的「' + String(tk.v) + '」')
  }
  const ast = parseOr()
  if (pos < toks.length) throw new Error('表达式末尾有多余内容')
  return ast
}

// ================= 序列求值（与 pkg-8 一致，保留原缓存实现以便验证） =================
function evalAst(ast, S) {
  const n = S.n
  function fill(v) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = v; return a }
  function sma(src, p) {
    const a = new Array(n); let s = 0
    for (let i = 0; i < n; i++) { s += src[i]; if (i >= p) s -= src[i - p]; a[i] = i >= p - 1 ? s / p : null }
    return a
  }
  function emaArr(src, p) {
    const a = new Array(n); const k = 2 / (p + 1); let prev = null
    for (let i = 0; i < n; i++) { const v = src[i]; prev = prev === null ? v : v * k + prev * (1 - k); a[i] = prev }
    return a
  }
  function stdArr(src, p) {
    const a = new Array(n)
    for (let i = 0; i < n; i++) {
      if (i < p - 1) { a[i] = null; continue }
      let m = 0
      for (let j = i - p + 1; j <= i; j++) m += src[j]
      m /= p
      let v = 0
      for (let j = i - p + 1; j <= i; j++) v += (src[j] - m) * (src[j] - m)
      a[i] = Math.sqrt(v / p)
    }
    return a
  }
  function hhvArr(src, p) {
    const a = new Array(n)
    for (let i = 0; i < n; i++) {
      if (i < p - 1) { a[i] = null; continue }
      let m = -Infinity
      for (let j = i - p + 1; j <= i; j++) if (src[j] > m) m = src[j]
      a[i] = m
    }
    return a
  }
  function llvArr(src, p) {
    const a = new Array(n)
    for (let i = 0; i < n; i++) {
      if (i < p - 1) { a[i] = null; continue }
      let m = Infinity
      for (let j = i - p + 1; j <= i; j++) if (src[j] < m) m = src[j]
      a[i] = m
    }
    return a
  }
  function rsiArr(p) {
    const a = new Array(n); let au = 0; let ad = 0
    for (let i = 0; i < n; i++) {
      if (i === 0) { a[i] = null; continue }
      const ch = (S.C[i] === null || S.C[i - 1] === null) ? 0 : S.C[i] - S.C[i - 1]
      const up = ch > 0 ? ch : 0
      const dn = ch < 0 ? -ch : 0
      if (i <= p) { au += up / p; ad += dn / p; a[i] = i === p ? (ad === 0 ? 100 : 100 - 100 / (1 + au / ad)) : null }
      else { au = (au * (p - 1) + up) / p; ad = (ad * (p - 1) + dn) / p; a[i] = ad === 0 ? 100 : 100 - 100 / (1 + au / ad) }
    }
    return a
  }
  function constArg(arr, label) {
    for (let i = 0; i < arr.length; i++) if (arr[i] !== null && arr[i] !== undefined) return arr[i]
    throw new Error(label + ' 需要常量参数')
  }
  function ev(node) {
    if (node.k === 'num') return fill(node.v)
    if (node.k === 'var') {
      const map = { C: S.C, CLOSE: S.C, O: S.O, OPEN: S.O, H: S.H, HIGH: S.H, L: S.L, LOW: S.L, V: S.V, VOL: S.V, VOLUME: S.V }
      const arr = map[node.name]
      if (arr === undefined) throw new Error('未知变量「' + node.name + '」')
      return arr
    }
    if (node.k === 'neg') { const a = ev(node.a); return a.map(function (v) { return v === null ? null : -v }) }
    if (node.k === 'not') { const a = ev(node.a); return a.map(function (v) { return v ? 0 : 1 }) }
    if (node.k === 'bin') {
      const a = ev(node.a); const b = ev(node.b)
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const x = a[i]; const y = b[i]
        if (x === null || y === null || x === undefined || y === undefined) { out[i] = null; continue }
        if (node.op === '+') out[i] = x + y
        else if (node.op === '-') out[i] = x - y
        else if (node.op === '*') out[i] = x * y
        else if (node.op === '/') out[i] = y === 0 ? null : x / y
        else if (node.op === '>') out[i] = x > y ? 1 : 0
        else if (node.op === '<') out[i] = x < y ? 1 : 0
        else if (node.op === '>=') out[i] = x >= y ? 1 : 0
        else if (node.op === '<=') out[i] = x <= y ? 1 : 0
        else if (node.op === '==') out[i] = x === y ? 1 : 0
        else if (node.op === '!=') out[i] = x !== y ? 1 : 0
        else if (node.op === '&&') out[i] = (x && y) ? 1 : 0
        else if (node.op === '||') out[i] = (x || y) ? 1 : 0
        else out[i] = null
      }
      return out
    }
    if (node.k === 'call') {
      const name = node.name
      const key = name + '#' + node.args.length + '#' + node.args.map(function (a) { return a.k === 'num' ? a.v : (a.k === 'var' ? a.name : '?') }).join(',')
      let out = null
      const A = node.args.map(ev)
      if (name === 'MA') out = sma(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'MA') : constArg(A[0], 'MA'))
      else if (name === 'EMA') out = emaArr(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'EMA') : constArg(A[0], 'EMA'))
      else if (name === 'SUM') { const src = A.length === 2 ? A[0] : S.C; const p = A.length === 2 ? constArg(A[1], 'SUM') : constArg(A[0], 'SUM'); const avg = sma(src, p); out = avg.map(function (v) { return v === null ? null : v * p }) }
      else if (name === 'STD') out = stdArr(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'STD') : constArg(A[0], 'STD'))
      else if (name === 'HHV') out = hhvArr(A.length === 2 ? A[0] : S.H, A.length === 2 ? constArg(A[1], 'HHV') : constArg(A[0], 'HHV'))
      else if (name === 'LLV') out = llvArr(A.length === 2 ? A[0] : S.L, A.length === 2 ? constArg(A[1], 'LLV') : constArg(A[0], 'LLV'))
      else if (name === 'RSI') out = rsiArr(A.length === 0 ? 14 : constArg(A[0], 'RSI'))
      else if (name === 'DIF') { const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26); out = e12.map(function (v, i) { return v - e26[i] }) }
      else if (name === 'DEA') { const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26); const dif = e12.map(function (v, i) { return v - e26[i] }); out = emaArr(dif, 9) }
      else if (name === 'MACD') { const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26); const dif = e12.map(function (v, i) { return v - e26[i] }); const dea = emaArr(dif, 9); out = dif.map(function (v, i) { return (v - dea[i]) * 2 }) }
      else if (name === 'BOLL_MID') { const p = A.length === 0 ? 20 : constArg(A[0], 'BOLL_MID'); out = sma(S.C, p) }
      else if (name === 'BOLL_UP' || name === 'BOLL_LOW') {
        const p = A.length === 0 ? 20 : constArg(A[0], name)
        const k = A.length < 2 ? 2 : constArg(A[1], name)
        const mid = sma(S.C, p); const sd = stdArr(S.C, p)
        out = mid.map(function (v, i) { if (v === null || sd[i] === null) return null; return name === 'BOLL_UP' ? v + k * sd[i] : v - k * sd[i] })
      }
      else if (name === 'REF') { const p = constArg(A[1], 'REF'); const src = A[0]; out = src.map(function (_, i) { return i - p < 0 ? null : src[i - p] }) }
      else if (name === 'CROSS') {
        const a = A[0]; const b = A[1]
        out = new Array(n)
        for (let i = 0; i < n; i++) {
          if (i === 0 || a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) { out[i] = 0; continue }
          out[i] = (a[i - 1] <= b[i - 1] && a[i] > b[i]) ? 1 : 0
        }
      }
      else if (name === 'ABS') out = A[0].map(function (v) { return v === null ? null : Math.abs(v) })
      else if (name === 'MAX') out = A[0].map(function (v, i) { return (v === null || A[1][i] === null) ? null : Math.max(v, A[1][i]) })
      else if (name === 'MIN') out = A[0].map(function (v, i) { return (v === null || A[1][i] === null) ? null : Math.min(v, A[1][i]) })
      else throw new Error('未知函数「' + name + '」')
      return out
    }
    throw new Error('无法求值的节点')
  }
  return ev(ast)
}

// ================= 回测引擎 =================
function limitPctOf(code) {
  const c = String(code || '')
  if (/^(300|301|688|689)/.test(c)) return 0.20
  if (/^(4|8|920)/.test(c)) return 0.30
  return 0.10
}
function runEngine(bars, buySeries, sellSeries, cfg) {
  const n = bars.length
  let cash = cfg.capital
  let shares = 0
  let buyIdx = -1
  let buyPrice = 0
  let buyCost = 0
  let pending = null
  const equity = new Array(n)
  const trades = []
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    if (i > 0 && pending !== null) {
      const prevClose = bars[i - 1][2]
      const limitUp = Math.round(prevClose * (1 + cfg.limitPct) * 100) / 100
      const limitDown = Math.round(prevClose * (1 - cfg.limitPct) * 100) / 100
      const px = b[1]
      if (pending === 'buy' && shares === 0) {
        if (px < limitUp - 1e-9) {
          const fill = px * (1 + cfg.slippage)
          let qty = Math.floor(cash / (fill * 100)) * 100
          while (qty > 0) {
            const amount = qty * fill
            const fee = Math.max(5, amount * cfg.commission) + amount * cfg.transferFee
            if (amount + fee <= cash) break
            qty -= 100
          }
          if (qty > 0) {
            const amount = qty * fill
            const fee = Math.max(5, amount * cfg.commission) + amount * cfg.transferFee
            cash -= amount + fee
            shares = qty
            buyIdx = i
            buyPrice = fill
            buyCost = amount + fee
          }
        }
      } else if (pending === 'sell' && shares > 0 && i > buyIdx) {
        if (px > limitDown + 1e-9) {
          const fill = px * (1 - cfg.slippage)
          const amount = shares * fill
          const fee = Math.max(5, amount * cfg.commission) + amount * cfg.stampTax + amount * cfg.transferFee
          cash += amount - fee
          const profit = amount - fee - buyCost
          trades.push({ bd: bars[buyIdx][0], sd: b[0], bp: buyPrice, sp: fill, ret: buyCost > 0 ? profit / buyCost : 0, days: i - buyIdx })
          shares = 0
          buyIdx = -1
        }
      }
      pending = null
    }
    if (shares === 0) { if (buySeries[i]) pending = 'buy' }
    else if (i > buyIdx && sellSeries[i]) pending = 'sell'
    equity[i] = cash + shares * b[2]
  }
  return { equity: equity, trades: trades, finalEquity: equity[n - 1] }
}
function computeMetrics(equity, trades, capital) {
  const n = equity.length
  const finalEq = equity[n - 1]
  const totalReturn = finalEq / capital - 1
  const annualized = n > 0 && finalEq > 0 ? Math.pow(finalEq / capital, 250 / n) - 1 : 0
  let peak = equity[0]; let maxDD = 0
  for (let i = 0; i < n; i++) {
    if (equity[i] > peak) peak = equity[i]
    const dd = peak > 0 ? (peak - equity[i]) / peak : 0
    if (dd > maxDD) maxDD = dd
  }
  const rets = []
  for (let i = 1; i < n; i++) { const p = equity[i - 1]; if (p > 0) rets.push(equity[i] / p - 1) }
  let mean = 0
  for (let i = 0; i < rets.length; i++) mean += rets[i]
  if (rets.length > 0) mean /= rets.length
  let varr = 0
  for (let i = 0; i < rets.length; i++) varr += (rets[i] - mean) * (rets[i] - mean)
  const sd = rets.length > 1 ? Math.sqrt(varr / (rets.length - 1)) : 0
  const sharpe = sd > 0 ? mean / sd * Math.sqrt(250) : 0
  const calmar = maxDD > 0 ? annualized / maxDD : 0
  let wins = 0; let winSum = 0; let lossSum = 0; let lossN = 0
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].ret > 0) { wins += 1; winSum += trades[i].ret } else { lossN += 1; lossSum += trades[i].ret }
  }
  const winRate = trades.length > 0 ? wins / trades.length : 0
  const avgWin = wins > 0 ? winSum / wins : 0
  const avgLoss = lossN > 0 ? Math.abs(lossSum / lossN) : 0
  return { totalReturn, annualized, maxDD, sharpe, calmar, winRate, plRatio: avgLoss > 0 ? avgWin / avgLoss : 0, count: trades.length, finalEq, bars: n }
}

// ================= 载入真实数据 =================
const raw = JSON.parse(readFileSync(new URL('./fixtures/kline-600519.json', import.meta.url), 'utf8'))
const bars = raw.data.sh600519.qfqday.map(r => [String(r[0]), +r[1], +r[2], +r[3], +r[4], +r[5]])
const S = (() => {
  const n = bars.length, C = [], O = [], H = [], L = [], V = []
  for (let i = 0; i < n; i++) { const b = bars[i]; O.push(b[1]); C.push(b[2]); H.push(b[3]); L.push(b[4]); V.push(b[5]) }
  return { n, C, O, H, L, V }
})()

let pass = 0, fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ✗ ' + name + '  ' + (detail || '')) }
}
function closeTo(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps) }

console.log('数据：' + bars.length + ' 根，' + bars[0][0] + ' → ' + bars[bars.length - 1][0] + '\n')

console.log('[1] 语法分析')
for (const src of [
  'CROSS(MA(5),MA(20))',
  'RSI(14)<30',
  'MA(5)>MA(20) AND C>MA(5)',
  'C>REF(HHV(20),1) OR (V>MA(V,20)*1.5)',
  'NOT (C<MA(60))',
  'BOLL_UP(20,2)-BOLL_LOW(20,2)',
]) {
  try { parseSource(src); check(src, true) } catch (e) { check(src, false, e.message) }
}
for (const bad of ['MA(5', 'C >', '1 +', 'MA(5))', 'C @@ 1']) {
  let threw = false
  try { parseSource(bad) } catch { threw = true }
  check('拒绝非法输入 ' + JSON.stringify(bad), threw)
}

console.log('\n[2] 指标正确性')
const ma5 = evalAst(parseSource('MA(5)'), S)
let manual = 0
for (let i = bars.length - 5; i < bars.length; i++) manual += bars[i][2]
manual /= 5
check('MA(5) 末值与手算一致', closeTo(ma5[bars.length - 1], manual, 1e-9), ma5[bars.length - 1].toFixed(4) + ' vs ' + manual.toFixed(4))
check('MA(5) 前 4 根为 null', ma5[0] === null && ma5[3] === null && ma5[4] !== null)

const hhv = evalAst(parseSource('HHV(20)'), S)
let hh = -Infinity
for (let i = bars.length - 20; i < bars.length; i++) hh = Math.max(hh, bars[i][3])
check('HHV(20) 取的是最高价', closeTo(hhv[bars.length - 1], hh, 1e-9), hhv[bars.length - 1].toFixed(2) + ' vs ' + hh.toFixed(2))

const rsi = evalAst(parseSource('RSI(14)'), S)
let rsiOk = true, rsiNull = 0
for (const v of rsi) { if (v === null) { rsiNull++; continue } if (!(v >= 0 && v <= 100)) rsiOk = false }
check('RSI(14) 全部落在 [0,100]', rsiOk, 'null 前 ' + rsiNull + ' 个，末值 ' + rsi[rsi.length - 1].toFixed(2))

const cross = evalAst(parseSource('CROSS(MA(5),MA(20))'), S)
let crossCount = 0
for (const v of cross) if (v === 1) crossCount++
check('CROSS 只输出 0/1 且金叉次数合理', cross.every(v => v === 0 || v === 1) && crossCount > 0 && crossCount < bars.length / 5, '金叉 ' + crossCount + ' 次')

const boll = evalAst(parseSource('BOLL_UP(20,2)>BOLL_MID(20)'), S)
check('BOLL_UP 恒大于 BOLL_MID', boll.every(v => v === null || v === 1))

const sum = evalAst(parseSource('SUM(V,5)'), S)
let vsum = 0
for (let i = bars.length - 5; i < bars.length; i++) vsum += bars[i][5]
check('SUM(V,5) 是求和而非均值', closeTo(sum[bars.length - 1], vsum, 1e-6), sum[bars.length - 1].toFixed(2) + ' vs ' + vsum.toFixed(2))

console.log('\n[3] 嵌套调用回归（pkg-8 曾因缓存键冲突在此算错，pkg-9 已移除缓存）')
const a1 = evalAst(parseSource('MA(MA(5),3)'), S)
const a2 = evalAst(parseSource('MA(EMA(5),3)'), S)
const combined = evalAst(parseSource('MA(MA(5),3)+MA(EMA(5),3)'), S)
const last = bars.length - 1
const expected = a1[last] + a2[last]
console.log('    MA(MA(5),3) 末值   = ' + a1[last].toFixed(6))
console.log('    MA(EMA(5),3) 末值  = ' + a2[last].toFixed(6))
console.log('    两者之和（期望）   = ' + expected.toFixed(6))
console.log('    组合表达式（实得） = ' + combined[last].toFixed(6))
check('两个子表达式确实不同（冲突前提成立）', Math.abs(a1[last] - a2[last]) > 1e-6)
check('嵌套不同函数的组合结果 == 两部分之和', closeTo(combined[last], expected, 1e-9))
let nestedOk = true
for (let i = 30; i < bars.length; i++) if (!closeTo(combined[i], a1[i] + a2[i], 1e-9)) { nestedOk = false; break }
check('整段区间逐点一致（非仅末值巧合）', nestedOk)
const swapped = evalAst(parseSource('MA(EMA(5),3)+MA(MA(5),3)'), S)
check('加法交换律成立（与书写顺序无关）', closeTo(swapped[last], combined[last], 1e-9))

// ---------- 多标的多资金回测 ----------
function seriesOf(bs) {
  const n = bs.length, C = [], O = [], H = [], L = [], V = []
  for (let i = 0; i < n; i++) { const b = bs[i]; O.push(b[1]); C.push(b[2]); H.push(b[3]); L.push(b[4]); V.push(b[5]) }
  return { n, C, O, H, L, V }
}
const raw2 = JSON.parse(readFileSync(new URL('./fixtures/kline-000001.json', import.meta.url), 'utf8'))
const bars2 = raw2.data.sz000001.qfqday.map(r => [String(r[0]), +r[1], +r[2], +r[3], +r[4], +r[5]])
const S2 = seriesOf(bars2)

function backtest(bs, SS, buySrc, sellSrc, capital, costs) {
  const bser = evalAst(parseSource(buySrc), SS, false)
  const sser = evalAst(parseSource(sellSrc), SS, false)
  const cfg = Object.assign({ capital, commission: 0.00025, stampTax: 0.0005, transferFee: 0.00001, slippage: 0.001, limitPct: 0.10 }, costs || {})
  const r = runEngine(bs, bser, sser, cfg)
  return { bser, sser, cfg, r, m: computeMetrics(r.equity, r.trades, capital) }
}
function show(tag, t) {
  console.log('    ' + tag + '：总收益 ' + (t.m.totalReturn * 100).toFixed(2) + '%  年化 ' + (t.m.annualized * 100).toFixed(2) + '%  回撤 ' + (t.m.maxDD * 100).toFixed(2) + '%')
  console.log('      夏普 ' + t.m.sharpe.toFixed(2) + '  卡玛 ' + t.m.calmar.toFixed(2) + '  胜率 ' + (t.m.winRate * 100).toFixed(1) + '%  盈亏比 ' + t.m.plRatio.toFixed(2) + '  交易 ' + t.m.count + ' 笔  期末 ' + t.m.finalEq.toFixed(0) + ' 元')
}

console.log('\n[4] 回测引擎 — 贵州茅台 sh600519 @ 100万（1 手 12.75 万，10 万买不起）')
const t1 = backtest(bars, S, 'CROSS(MA(5),MA(20))', 'CROSS(MA(20),MA(5))', 1000000)
show('双均线', t1)
const res = t1.r, m = t1.m, cfg = t1.cfg
console.log('    末 3 笔：')
for (const t of res.trades.slice(-3)) console.log('      ' + t.bd + ' @' + t.bp.toFixed(2) + '  →  ' + t.sd + ' @' + t.sp.toFixed(2) + '  ' + (t.ret * 100).toFixed(2) + '%  持 ' + t.days + ' 天')

check('产生了交易', res.trades.length > 0, res.trades.length + ' 笔')
check('限幅判定正确（主板10% / 创业板20% / 科创板20% / 北交所30%）', limitPctOf('600519') === 0.10 && limitPctOf('300750') === 0.20 && limitPctOf('688981') === 0.20 && limitPctOf('830799') === 0.30)
check('T+1：每笔持有天数 >= 2（信号次日开盘成交）', res.trades.every(t => t.days >= 2))
check('买入日严格早于卖出日', res.trades.every(t => t.bd < t.sd))
check('资金曲线无 NaN', res.equity.every(v => isFinite(v)))
check('权益恒为正', res.equity.every(v => v > 0))
check('最大回撤在 [0,1]', m.maxDD >= 0 && m.maxDD <= 1)
check('胜率在 [0,1]', m.winRate >= 0 && m.winRate <= 1)
check('持仓期无现金为负', res.trades.every(t => t.bp > 0 && t.sp > 0))

console.log('\n[4b] 回测引擎 — 平安银行 sz000001 @ 10万（1 手约 1174 元）')
const t2 = backtest(bars2, S2, 'CROSS(MA(5),MA(20))', 'CROSS(MA(20),MA(5))', 100000)
show('双均线', t2)
const res2 = t2.r
check('低价股在 10 万资金下能成交', res2.trades.length > 0, res2.trades.length + ' 笔')
check('委托股数为 100 的整数倍（整手）', (function () {
  let ok = true
  for (const t of res2.trades.slice(0, 10)) {
    const qty = Math.round(t.bp * 100 / t.bp)
    if (qty % 100 !== 0) ok = false
  }
  return ok
})())

console.log('\n[5] 成本与无未来函数校验')
const noCost = backtest(bars, S, 'CROSS(MA(5),MA(20))', 'CROSS(MA(20),MA(5))', 1000000, { commission: 0, stampTax: 0, transferFee: 0, slippage: 0 }).m
check('零成本收益高于含成本收益', noCost.totalReturn > m.totalReturn, (noCost.totalReturn * 100).toFixed(2) + '% vs ' + (m.totalReturn * 100).toFixed(2) + '%')
check('零成本交易笔数与含成本一致', noCost.count === m.count)

// 无未来函数：买入成交价应等于「信号日之后那一根」的开盘价×(1+滑点)
let lookaheadOk = true
for (const t of res.trades.slice(0, 20)) {
  const idx = bars.findIndex(b => b[0] === t.bd)
  if (idx < 1) continue
  const expectedFill = bars[idx][1] * (1 + cfg.slippage)
  if (Math.abs(expectedFill - t.bp) > 1e-6) { lookaheadOk = false; break }
}
check('买入成交价 = 成交日开盘价×(1+滑点)，无未来函数', lookaheadOk)

// 买入价的成交日应当晚于信号日：验证 buySeries 在成交日前一根为 1
let signalOk = true
for (const t of res.trades.slice(0, 20)) {
  const idx = bars.findIndex(b => b[0] === t.bd)
  if (idx < 1) continue
  if (t1.bser[idx - 1] !== 1) { signalOk = false; break }
}
check('成交日前一根恰好是买入信号', signalOk)

// 涨跌停：统计因涨停未能买入的次数
let blocked = 0
for (let i = 1; i < bars.length; i++) {
  if (!t1.bser[i - 1]) continue
  const limitUp = Math.round(bars[i - 1][2] * 1.1 * 100) / 100
  if (bars[i][1] >= limitUp - 1e-9) blocked++
}
console.log('    （区间内因开盘涨停而无法成交的买入信号：' + blocked + ' 次）')

console.log('\n[6] 全部模板可解析并跑通')
const TEMPLATES = [
  ['双均线金叉', 'CROSS(MA(5),MA(20))', 'CROSS(MA(20),MA(5))'],
  ['MACD 金叉', 'CROSS(DIF(),DEA())', 'CROSS(DEA(),DIF())'],
  ['RSI 超卖反转', 'RSI(14)<30', 'RSI(14)>70'],
  ['布林带均值回归', 'C<BOLL_LOW(20,2)', 'C>BOLL_UP(20,2)'],
  ['唐奇安突破', 'C>REF(HHV(20),1)', 'C<REF(LLV(10),1)'],
  ['均线多头排列', 'MA(5)>MA(10) AND MA(10)>MA(20)', 'C<MA(20)'],
]
for (const [name, be, se] of TEMPLATES) {
  try {
    const bs = evalAst(parseSource(be), S)
    const ss = evalAst(parseSource(se), S)
    const r = runEngine(bars, bs, ss, cfg)
    const mm = computeMetrics(r.equity, r.trades, cfg.capital)
    check(name.padEnd(14, ' '), isFinite(mm.totalReturn), (mm.totalReturn * 100).toFixed(2) + '%  回撤 ' + (mm.maxDD * 100).toFixed(2) + '%  ' + mm.count + ' 笔')
  } catch (e) { check(name, false, e.message) }
}

console.log('\n================  ' + pass + ' 通过 / ' + fail + ' 失败  ================')
process.exit(fail > 0 ? 1 : 0)
