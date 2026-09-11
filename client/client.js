/**
 * dsh-astock 客户端 bundle。
 *
 * 构建产物格式是 `__ModuleLoader__` 工厂块（与 harness 自带的客户端插件一致），
 * 由宿主通过 exports["./client"] 读取并注入页面。
 *
 * 与「动态插件」时代的差异：
 *   React      沙箱全局      -> require('react')
 *   styles.insert(css)      -> document 注入 <style>
 *   host.call(...)          -> fetch('/astock/api/...')
 *   ctx.get('slots')        -> ctx.slots（配合 inject: ['slots']）
 *
 * 策略引擎与回测引擎是纯函数，已由 astock-engine-test.mjs 离线回归验证。
 */
window.__ModuleLoader__.load({
  id: 'dsh-astock',
  factory: (require) => {
    const React = require('react')

    const CSS = [
      '.astk-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.astk-gate{position:absolute;inset:0;z-index:20;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.astk-gate-card{max-width:760px;width:100%;max-height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:20px 24px;box-shadow:0 12px 40px rgba(0,0,0,.28)}',
      '.astk-gate-card h3{margin:0 0 4px;font-size:16px}',
      '.astk-gate-card p{margin:0 0 10px;font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-primary)}',
      '.astk-foot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:6px 14px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
      '.astk-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.astk-title{font-weight:600;font-size:14px;white-space:nowrap}',
      '.astk-body{display:flex;flex:1 1 auto;min-height:0}',
      '.astk-side{width:230px;flex:0 0 auto;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}',
      '.astk-main{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 16px}',
      '.astk-item{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;cursor:pointer}',
      '.astk-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.astk-item-on{background:var(--dsw-alias-bg-layer-2);outline:1px solid var(--dsw-alias-border-l2)}',
      '.astk-code{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.astk-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}',
      '.astk-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.astk-btn-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.astk-in{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 9px;font-size:12px;min-width:190px}',
      '.astk-tabs{display:flex;gap:6px;margin:12px 0 8px}',
      '.astk-quote{display:flex;flex-wrap:wrap;align-items:baseline;gap:18px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.astk-px{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.astk-kv{display:flex;flex-direction:column;gap:1px}',
      '.astk-kv b{font-weight:500;font-variant-numeric:tabular-nums}',
      '.astk-kv span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.astk-up{color:var(--dsw-alias-state-error-primary)}',
      '.astk-down{color:var(--dsw-alias-state-success-primary)}',
      '.astk-flat{color:var(--dsw-alias-label-secondary)}',
      '.astk-note{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 0}',
      '.astk-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;padding:6px 0;line-height:1.6}',
      '.astk-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 0;white-space:pre-wrap}',
      '.astk-res{position:relative}',
      '.astk-menu{position:absolute;z-index:5;top:100%;left:0;margin-top:4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-width:250px;max-height:260px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.18)}',
      '.astk-menu div{padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:10px}',
      '.astk-menu div:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.astk-chart{width:100%;height:auto;display:block}',
      '.astk-readout{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 2px;font-variant-numeric:tabular-nums;min-height:24px}',
      'table.astk-tab{width:100%;border-collapse:collapse;font-size:12px}',
      'table.astk-tab th,table.astk-tab td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}',
      'table.astk-tab th:first-child,table.astk-tab td:first-child{text-align:left}',
      'table.astk-tab th{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.astk-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.astk-field input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 7px;font-size:12px;width:74px;font-variant-numeric:tabular-nums}',
      '.astk-date{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px;font-variant-numeric:tabular-nums}',
      '.astk-top{position:sticky;top:0;z-index:4;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-bottom:10px}',
      '.astk-ta{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}',
      '.astk-sec{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.astk-sec h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.astk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px 16px}',
      '.astk-metric{display:flex;flex-direction:column;gap:2px}',
      '.astk-metric b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.astk-metric span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.astk-legend{display:flex;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0 6px}',
    ].join('\n')

    // ---------------- 数据访问（HTTP 路由） ----------------

    async function unwrap(response) {
      let value = null
      try {
        value = await response.json()
      } catch {
        throw new Error('HTTP ' + response.status + '（响应不是 JSON）')
      }
      if (!response.ok) throw new Error(value && value.error ? String(value.error) : 'HTTP ' + response.status)
      return value
    }

    function api(path, params) {
      const query = params === undefined ? '' : '?' + new URLSearchParams(params).toString()
      return fetch('/astock/api/' + path + query, { headers: { accept: 'application/json' } }).then(unwrap)
    }

    function apiPost(path, body) {
      return fetch('/astock/api/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      }).then(unwrap)
    }

    // ---------------- 工具 ----------------

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get() { return state },
        set(patch) {
          state = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch)
          listeners.forEach((fn) => { fn() })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
    }

    function movingAverage(bars, n) {
      const out = new Array(bars.length)
      let sum = 0
      for (let i = 0; i < bars.length; i++) {
        sum += bars[i][2]
        if (i >= n) sum -= bars[i - n][2]
        out[i] = i >= n - 1 ? sum / n : null
      }
      return out
    }

    // ---------------- 表达式引擎 ----------------

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
          i = j; continue
        }
        if (/[A-Za-z_]/.test(ch)) {
          let j = i
          while (j < s.length && /[A-Za-z0-9_]/.test(s.charAt(j))) j += 1
          const word = s.slice(i, j).toUpperCase()
          if (word === 'AND') out.push({ t: 'op', v: '&&' })
          else if (word === 'OR') out.push({ t: 'op', v: '||' })
          else if (word === 'NOT') out.push({ t: 'op', v: '!' })
          else out.push({ t: 'id', v: word })
          i = j; continue
        }
        const two = s.slice(i, i + 2)
        if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '&&' || two === '||') { out.push({ t: 'op', v: two }); i += 2; continue }
        if ('+-*/()<>,!'.indexOf(ch) >= 0) { out.push({ t: 'op', v: ch }); i += 1; continue }
        throw new Error('无法识别的字符「' + ch + '」')
      }
      return out
    }

    function parseSource(src) {
      const toks = tokenizeSource(src)
      let pos = 0
      const peek = () => toks[pos]
      const isOp = (v) => { const tk = toks[pos]; return tk !== undefined && tk.t === 'op' && tk.v === v }
      const eat = (v) => { if (!isOp(v)) throw new Error('语法错误：期望「' + v + '」'); pos += 1 }
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
          node = { k: 'bin', op, a: node, b: parseAdd() }
        }
        return node
      }
      function parseAdd() {
        let node = parseMul()
        while (isOp('+') || isOp('-')) { const op = peek().v; pos += 1; node = { k: 'bin', op, a: node, b: parseMul() } }
        return node
      }
      function parseMul() {
        let node = parseUnary()
        while (isOp('*') || isOp('/')) { const op = peek().v; pos += 1; node = { k: 'bin', op, a: node, b: parseUnary() } }
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
            return { k: 'call', name: tk.v, args }
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

    // 不使用缓存：早期版本用「函数名#参数个数#参数形状」做键，会把
    // MA(MA(5),3) 与 MA(EMA(5),3) 误判为同一个键而静默算错（已由离线测试捕获）。
    function evalAst(ast, S) {
      const n = S.n
      const fill = (v) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = v; return a }
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
          const ch = S.C[i] - S.C[i - 1]
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
        // 已算好的序列：JS 策略把指标结果回传进来时走这条路径。
        if (node.k === 'series') return node.v
        if (node.k === 'var') {
          const map = { C: S.C, CLOSE: S.C, O: S.O, OPEN: S.O, H: S.H, HIGH: S.H, L: S.L, LOW: S.L, V: S.V, VOL: S.V, VOLUME: S.V }
          const arr = map[node.name]
          if (arr === undefined) throw new Error('未知变量「' + node.name + '」')
          return arr
        }
        if (node.k === 'neg') { const a = ev(node.a); return a.map((v) => (v === null ? null : -v)) }
        if (node.k === 'not') { const a = ev(node.a); return a.map((v) => (v ? 0 : 1)) }
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
          const callName = node.name
          const A = node.args.map(ev)
          let out = null
          if (callName === 'MA') out = sma(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'MA') : constArg(A[0], 'MA'))
          else if (callName === 'EMA') out = emaArr(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'EMA') : constArg(A[0], 'EMA'))
          else if (callName === 'SUM') { const src = A.length === 2 ? A[0] : S.C; const p = A.length === 2 ? constArg(A[1], 'SUM') : constArg(A[0], 'SUM'); out = sma(src, p).map((v) => (v === null ? null : v * p)) }
          else if (callName === 'STD') out = stdArr(A.length === 2 ? A[0] : S.C, A.length === 2 ? constArg(A[1], 'STD') : constArg(A[0], 'STD'))
          else if (callName === 'HHV') out = hhvArr(A.length === 2 ? A[0] : S.H, A.length === 2 ? constArg(A[1], 'HHV') : constArg(A[0], 'HHV'))
          else if (callName === 'LLV') out = llvArr(A.length === 2 ? A[0] : S.L, A.length === 2 ? constArg(A[1], 'LLV') : constArg(A[0], 'LLV'))
          else if (callName === 'RSI') out = rsiArr(A.length === 0 ? 14 : constArg(A[0], 'RSI'))
          else if (callName === 'DIF') { const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26); out = e12.map((v, i) => v - e26[i]) }
          else if (callName === 'DEA') { const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26); out = emaArr(e12.map((v, i) => v - e26[i]), 9) }
          else if (callName === 'MACD') {
            const e12 = emaArr(S.C, 12); const e26 = emaArr(S.C, 26)
            const dif = e12.map((v, i) => v - e26[i]); const dea = emaArr(dif, 9)
            out = dif.map((v, i) => (v - dea[i]) * 2)
          }
          else if (callName === 'BOLL_MID') out = sma(S.C, A.length === 0 ? 20 : constArg(A[0], 'BOLL_MID'))
          else if (callName === 'BOLL_UP' || callName === 'BOLL_LOW') {
            const p = A.length === 0 ? 20 : constArg(A[0], callName)
            const k = A.length < 2 ? 2 : constArg(A[1], callName)
            const mid = sma(S.C, p); const sd = stdArr(S.C, p)
            out = mid.map((v, i) => (v === null || sd[i] === null ? null : callName === 'BOLL_UP' ? v + k * sd[i] : v - k * sd[i]))
          }
          else if (callName === 'REF') { const p = constArg(A[1], 'REF'); const src = A[0]; out = src.map((_, i) => (i - p < 0 ? null : src[i - p])) }
          else if (callName === 'CROSS') {
            const a = A[0]; const b = A[1]
            out = new Array(n)
            for (let i = 0; i < n; i++) {
              if (i === 0 || a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) { out[i] = 0; continue }
              out[i] = (a[i - 1] <= b[i - 1] && a[i] > b[i]) ? 1 : 0
            }
          }
          else if (callName === 'ABS') out = A[0].map((v) => (v === null ? null : Math.abs(v)))
          else if (callName === 'MAX') out = A[0].map((v, i) => (v === null || A[1][i] === null ? null : Math.max(v, A[1][i])))
          else if (callName === 'MIN') out = A[0].map((v, i) => (v === null || A[1][i] === null ? null : Math.min(v, A[1][i])))
          else throw new Error('未知函数「' + callName + '」')
          return out
        }
        throw new Error('无法求值的节点')
      }
      return ev(ast)
    }

    const seriesOf = (bars) => {
      const n = bars.length; const C = []; const O = []; const H = []; const L = []; const V = []
      for (let i = 0; i < n; i++) { const b = bars[i]; O.push(b[1]); C.push(b[2]); H.push(b[3]); L.push(b[4]); V.push(b[5]) }
      return { n, C, O, H, L, V }
    }

    // ---------------- JavaScript 策略 ----------------
    //
    // 正式 bundle 的客户端跑在真实浏览器页面里，`new Function` 可用，因此这里
    // 能执行用户自写的策略代码（动态插件沙箱没有 eval，那时只能给表达式语言）。
    //
    // 设计要点：指标计算**全部经由 evalAst**，而不是另写一套。JS 侧的函数只是
    // 把 JS 值包装成 AST 节点再交给同一个求值器，所以两种模式的指标语义不可能漂移。

    /** 把 JS 值（数组 / 数字 / 已是 AST 节点）转成求值器认的节点。 */
    const jsNode = (v) => (Array.isArray(v) ? { k: 'series', v } : (typeof v === 'number' ? { k: 'num', v } : v))

    /**
     * 为一段序列构造 JS 策略可用的函数库。
     * @param S - seriesOf() 的结果。
     * @returns 供 new Function 逐项传入的函数集合。
     */
    function buildJsLib(S) {
      const call = (name, args) => evalAst({ k: 'call', name, args: args.map(jsNode) }, S)
      const bin = (op, a, b) => evalAst({ k: 'bin', op, a: jsNode(a), b: jsNode(b) }, S)
      // 双参形式 MA(x, n)；省略序列时用默认序列（HHV 用最高价、LLV 用最低价）。
      const seriesFn = (name, fallback) => (a, b) => (
        typeof a === 'number' || a === undefined ? call(name, [fallback, a === undefined ? b : a]) : call(name, [a, b])
      )
      // BOLL 在求值器里只吃 (周期, 倍数)，但允许用户写成 BOLL_UP(C, 20, 2)，多余序列忽略。
      const bollFn = (name) => (...args) => {
        const nums = args.filter((v) => typeof v === 'number')
        return call(name, [nums[0] === undefined ? 20 : nums[0], nums[1] === undefined ? 2 : nums[1]])
      }
      return {
        MA: seriesFn('MA', S.C),
        EMA: seriesFn('EMA', S.C),
        SUM: seriesFn('SUM', S.C),
        STD: seriesFn('STD', S.C),
        HHV: seriesFn('HHV', S.H),
        LLV: seriesFn('LLV', S.L),
        REF: (x, p) => call('REF', [x, p]),
        RSI: (p) => call('RSI', [p === undefined ? 14 : p]),
        DIF: () => call('DIF', []),
        DEA: () => call('DEA', []),
        MACD: () => call('MACD', []),
        BOLL_UP: bollFn('BOLL_UP'),
        BOLL_MID: bollFn('BOLL_MID'),
        BOLL_LOW: bollFn('BOLL_LOW'),
        CROSS: (a, b) => call('CROSS', [a, b]),
        ABS: (x) => call('ABS', [x]),
        MAX: (a, b) => call('MAX', [a, b]),
        MIN: (a, b) => call('MIN', [a, b]),
        GT: (a, b) => bin('>', a, b),
        LT: (a, b) => bin('<', a, b),
        GTE: (a, b) => bin('>=', a, b),
        LTE: (a, b) => bin('<=', a, b),
        AND: (a, b) => bin('&&', a, b),
        OR: (a, b) => bin('||', a, b),
        NOT: (a) => evalAst({ k: 'not', a: jsNode(a) }, S),
      }
    }

    /** new Function 的形参顺序，与 buildJsLib 的返回键一一对应。 */
    const JS_PARAMS = [
      'MA', 'EMA', 'SUM', 'STD', 'HHV', 'LLV', 'REF', 'RSI', 'DIF', 'DEA', 'MACD',
      'BOLL_UP', 'BOLL_MID', 'BOLL_LOW', 'CROSS', 'GT', 'LT', 'GTE', 'LTE', 'AND', 'OR', 'NOT',
      'ABS', 'MAX', 'MIN',
    ]

    /**
     * 编译并运行用户策略。
     * @param source - 用户代码（函数体，需 return { buy, sell }）。
     * @param S - seriesOf() 的结果。
     * @returns 校验过的 { buy, sell } 布尔序列。
     * @throws 语法错误、运行错误或返回值不合法时抛出可读信息。
     */
    function runJsStrategy(source, S) {
      const lib = buildJsLib(S)
      const head = ['C', 'O', 'H', 'L', 'V', 'N'].concat(JS_PARAMS)
      const args = [S.C, S.O, S.H, S.L, S.V, S.n].concat(JS_PARAMS.map((k) => lib[k]))
      let fn
      try {
        // eslint-disable-next-line no-new-func -- 用户自写策略的执行方式
        fn = new Function(...head, source)
      } catch (error) {
        throw new Error('语法错误：' + String((error && error.message) || error))
      }
      let out
      try {
        out = fn(...args)
      } catch (error) {
        throw new Error('运行出错：' + String((error && error.message) || error))
      }
      if (out === null || typeof out !== 'object') {
        throw new Error('策略必须 return { buy, sell }，实际返回了 ' + (out === null ? 'null' : typeof out))
      }
      if (!Array.isArray(out.buy) || !Array.isArray(out.sell)) {
        throw new Error('返回值缺少 buy / sell 数组（买入选股信号与卖出信号各一个长度 ' + S.n + ' 的数组）')
      }
      if (out.buy.length !== S.n || out.sell.length !== S.n) {
        throw new Error('信号数组长度必须等于 K 线根数 ' + S.n + '，实际 buy=' + out.buy.length + '、sell=' + out.sell.length)
      }
      return { buy: out.buy, sell: out.sell }
    }

    /** 新建 JS 策略时的默认内容，兼作可运行的示例。 */
    const DEFAULT_JS = [
      '// 写你的策略。可用（返回序列数组，索引与 K 线对齐）：',
      '//   C O H L V      收盘/开盘/最高/最低/成交量',
      '//   MA(x,n) EMA(x,n) SUM(x,n) STD(x,n) HHV(x,n) LLV(x,n) REF(x,n)',
      '//   RSI(n) DIF() DEA() MACD() BOLL_UP(p,k) BOLL_MID(p) BOLL_LOW(p,k)',
      '//   CROSS(a,b) GT(a,b) LT(a,b) GTE(a,b) LTE(a,b) AND(a,b) OR(a,b) NOT(a)',
      '// 必须 return { buy, sell }，两个数组长度都要等于 C.length。',
      '// 例：放量金叉才买，死叉或跌破长均线就卖。',
      'const fast = MA(C, 5)',
      'const slow = MA(C, 20)',
      'const volUp = GT(V, MA(V, 20))',
      'return {',
      '  buy: AND(CROSS(fast, slow), volUp),',
      '  sell: OR(CROSS(slow, fast), LT(C, slow)),',
      '}',
    ].join('\n')

    // ---------------- 策略模板 ----------------

    const TEMPLATES = [
      {
        id: 'ma', name: '双均线金叉', params: [['fast', '短均线', 5], ['slow', '长均线', 20]],
        buy: (p) => 'CROSS(MA(' + p.fast + '),MA(' + p.slow + '))',
        sell: (p) => 'CROSS(MA(' + p.slow + '),MA(' + p.fast + '))',
        js: (p) => [
          'const fast = MA(C, ' + p.fast + ')',
          'const slow = MA(C, ' + p.slow + ')',
          'return {',
          '  buy: CROSS(fast, slow),',
          '  sell: CROSS(slow, fast),',
          '}',
        ].join('\n'),
      },
      {
        id: 'macd', name: 'MACD 金叉', params: [],
        buy: () => 'CROSS(DIF(),DEA())',
        sell: () => 'CROSS(DEA(),DIF())',
        js: () => [
          'const dif = DIF()',
          'const dea = DEA()',
          'return {',
          '  buy: CROSS(dif, dea),',
          '  sell: CROSS(dea, dif),',
          '}',
        ].join('\n'),
      },
      {
        id: 'rsi', name: 'RSI 超卖反转', params: [['n', '周期', 14], ['low', '买入阈值', 30], ['high', '卖出阈值', 70]],
        buy: (p) => 'RSI(' + p.n + ')<' + p.low,
        sell: (p) => 'RSI(' + p.n + ')>' + p.high,
        js: (p) => [
          'const rsi = RSI(' + p.n + ')',
          'return {',
          '  buy: LT(rsi, ' + p.low + '),',
          '  sell: GT(rsi, ' + p.high + '),',
          '}',
        ].join('\n'),
      },
      {
        id: 'boll', name: '布林带均值回归', params: [['n', '周期', 20], ['k', '倍数', 2]],
        buy: (p) => 'C<BOLL_LOW(' + p.n + ',' + p.k + ')',
        sell: (p) => 'C>BOLL_UP(' + p.n + ',' + p.k + ')',
        js: (p) => [
          'const low = BOLL_LOW(' + p.n + ', ' + p.k + ')',
          'const up = BOLL_UP(' + p.n + ', ' + p.k + ')',
          'return {',
          '  buy: LT(C, low),',
          '  sell: GT(C, up),',
          '}',
        ].join('\n'),
      },
      {
        id: 'donchian', name: '唐奇安突破', params: [['n', '突破周期', 20], ['m', '离场周期', 10]],
        buy: (p) => 'C>REF(HHV(' + p.n + '),1)',
        sell: (p) => 'C<REF(LLV(' + p.m + '),1)',
        js: (p) => [
          'const upper = REF(HHV(H, ' + p.n + '), 1)',
          'const lower = REF(LLV(L, ' + p.m + '), 1)',
          'return {',
          '  buy: GT(C, upper),',
          '  sell: LT(C, lower),',
          '}',
        ].join('\n'),
      },
      {
        id: 'trend', name: '均线多头排列', params: [['fast', '短均线', 5], ['mid', '中均线', 10], ['slow', '长均线', 20]],
        buy: (p) => 'MA(' + p.fast + ')>MA(' + p.mid + ') AND MA(' + p.mid + ')>MA(' + p.slow + ')',
        sell: (p) => 'C<MA(' + p.slow + ')',
        js: (p) => [
          'const fast = MA(C, ' + p.fast + ')',
          'const mid = MA(C, ' + p.mid + ')',
          'const slow = MA(C, ' + p.slow + ')',
          '// 这里可以写任意 JS：循环、变量、条件分支都行',
          'return {',
          '  buy: AND(GT(fast, mid), GT(mid, slow)),',
          '  sell: LT(C, slow),',
          '}',
        ].join('\n'),
      },
    ]

    const templateById = (id) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]
    const defaultParams = (tpl) => {
      const out = {}
      for (const def of tpl.params) out[def[0]] = def[2]
      return out
    }

    // ---------------- 回测引擎 ----------------

    // ---------------- 市场档案 ----------------
    //
    // 每个市场的交易规则不同，直接套用 A 股的假设会算错：
    //   T+1 vs T+0、有无涨跌停、每手股数（港股逐股不同：汇丰 400、长和 500）、
    //   印花税单边还是双边。引擎按这里切换。
    const MARKETS = {
      cn: {
        id: 'cn', name: 'A股', currency: 'CNY', unit: '元',
        t1: true, lotDefault: 100,
        commission: 0.00025, stampTax: 0.0005, stampTaxBuy: 0, transferFee: 0.00001, slippage: 0.001,
        rule: 'T+1（当日买入不可卖出）；涨跌停 ±10%（创业板/科创板 ±20%，北交所 ±30%）；佣金 5 元起收；印花税卖出单边；过户费双边。',
      },
      hk: {
        id: 'hk', name: '港股', currency: 'HKD', unit: '港元',
        t1: false, lotDefault: 100,
        commission: 0.0005, stampTax: 0.001, stampTaxBuy: 0.001, transferFee: 0.00002, slippage: 0.001,
        rule: 'T+0（当日可回转交易）；无涨跌停；印花税买卖双边各 0.1%；每手股数按股票而定。佣金等为近似值，请按你的券商调整。',
      },
    }
    /** 代码 -> 市场 id。5 位是港股，6 位是 A 股。 */
    const marketOf = (code) => {
      const c = String(code || '').trim()
      if (/^[0-9]{5}$/.test(c)) return 'hk'
      return 'cn'
    }
    const marketProfile = (code) => MARKETS[marketOf(code)] || MARKETS.cn

    // ---------------- 回测区间 ----------------

    /** 默认回测多久 —— 三年。 */
    const DEFAULT_BT_YEARS = 3
    /** 年份快捷档位；0 表示全部区间。 */
    const BT_PRESETS = [1, 3, 5, 10, 0]

    /** Date -> YYYY-MM-DD。用本地时区逐段取值，避免 toISOString 的 UTC 偏移把日期挪一天。 */
    function toISODate(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }
    /** N 年前的今天（N=0 即今天）。 */
    function yearsAgoISO(n) {
      const d = new Date()
      d.setFullYear(d.getFullYear() - n)
      return toISODate(d)
    }

    /** 涨跌停幅度；港股无涨跌停，返回 0 表示不限制。 */
    function limitPctOf(code) {
      const c = String(code || '')
      if (marketOf(c) === 'hk') return 0
      if (/^(300|301|688|689)/.test(c)) return 0.20
      if (/^(4|8|920)/.test(c)) return 0.30
      return 0.10
    }

    function runEngine(bars, buySeries, sellSeries, cfg) {
      const n = bars.length
      const lot = cfg.lot > 0 ? cfg.lot : 100
      // limitPct 为 0 表示该市场没有涨跌停（港股），跳过封板判断。
      const hasLimit = cfg.limitPct > 0
      const stampTaxBuy = cfg.stampTaxBuy > 0 ? cfg.stampTaxBuy : 0
      let cash = cfg.capital
      let shares = 0
      let buyIdx = -1
      let buyPrice = 0
      let buyCost = 0
      let pending = null
      const equity = new Array(n)
      const trades = []
      let blockedBuy = 0
      let blockedSell = 0
      for (let i = 0; i < n; i++) {
        const b = bars[i]
        if (i > 0 && pending !== null) {
          const prevClose = bars[i - 1][2]
          const limitUp = Math.round(prevClose * (1 + cfg.limitPct) * 100) / 100
          const limitDown = Math.round(prevClose * (1 - cfg.limitPct) * 100) / 100
          const px = b[1]
          if (pending === 'buy' && shares === 0) {
            // 有涨跌停时，开盘封在涨停价上买不进；无涨跌停的市场直接放行。
            if (!hasLimit || px < limitUp - 1e-9) {
              const fill = px * (1 + cfg.slippage)
              // 按该股的每手股数取整，而不是写死 100。
              let qty = Math.floor(cash / (fill * lot)) * lot
              while (qty > 0) {
                const amount = qty * fill
                const fee = Math.max(5, amount * cfg.commission) + amount * cfg.transferFee + amount * stampTaxBuy
                if (amount + fee <= cash) break
                qty -= lot
              }
              if (qty > 0) {
                const amount = qty * fill
                const fee = Math.max(5, amount * cfg.commission) + amount * cfg.transferFee + amount * stampTaxBuy
                cash -= amount + fee
                shares = qty
                buyIdx = i
                buyPrice = fill
                buyCost = amount + fee
              }
            } else blockedBuy += 1
          } else if (pending === 'sell' && shares > 0 && i > buyIdx) {
            if (!hasLimit || px > limitDown + 1e-9) {
              const fill = px * (1 - cfg.slippage)
              const amount = shares * fill
              const fee = Math.max(5, amount * cfg.commission) + amount * cfg.stampTax + amount * cfg.transferFee
              cash += amount - fee
              const profit = amount - fee - buyCost
              trades.push({ bd: bars[buyIdx][0], sd: b[0], bp: buyPrice, sp: fill, ret: buyCost > 0 ? profit / buyCost : 0, days: i - buyIdx })
              shares = 0
              buyIdx = -1
            } else blockedSell += 1
          }
          pending = null
        }
        // 信号在收盘产生，在下一根开盘成交（无未来函数）。
        // T+1：买入当日不能发出卖出信号；T+0：当日收盘即可发出（次根开盘卖出）。
        if (shares === 0) { if (buySeries[i]) pending = 'buy' }
        else if ((cfg.t1 ? i > buyIdx : i >= buyIdx) && sellSeries[i]) pending = 'sell'
        equity[i] = cash + shares * b[2]
      }
      return { equity, trades, finalEquity: equity[n - 1], blockedBuy, blockedSell, holding: shares > 0 }
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
      for (const r of rets) mean += r
      if (rets.length > 0) mean /= rets.length
      let varr = 0
      for (const r of rets) varr += (r - mean) * (r - mean)
      const sd = rets.length > 1 ? Math.sqrt(varr / (rets.length - 1)) : 0
      const sharpe = sd > 0 ? mean / sd * Math.sqrt(250) : 0
      const calmar = maxDD > 0 ? annualized / maxDD : 0
      let wins = 0; let winSum = 0; let lossSum = 0; let lossN = 0
      for (const t of trades) {
        if (t.ret > 0) { wins += 1; winSum += t.ret } else { lossN += 1; lossSum += t.ret }
      }
      const winRate = trades.length > 0 ? wins / trades.length : 0
      const avgWin = wins > 0 ? winSum / wins : 0
      const avgLoss = lossN > 0 ? Math.abs(lossSum / lossN) : 0
      return { totalReturn, annualized, maxDD, sharpe, calmar, winRate, plRatio: avgLoss > 0 ? avgWin / avgLoss : 0, count: trades.length, finalEq, bars: n }
    }

    function alignBenchmark(bars, benchBars) {
      if (!benchBars || benchBars.length === 0) return null
      const map = {}
      for (const b of benchBars) map[b[0]] = b[2]
      const raw = new Array(bars.length)
      let last = null
      for (let i = 0; i < bars.length; i++) {
        const v = map[bars[i][0]]
        if (v !== undefined && v !== null) last = v
        raw[i] = last
      }
      let first = null
      for (const v of raw) if (v !== null) { first = v; break }
      if (first === null || first === 0) return null
      return raw.map((v) => (v === null ? null : v / first))
    }

    // ---------------- 插件本体 ----------------

    function apply(ctx) {
      if (ctx.slots === undefined) {
        console.error('[dsh-astock] slots 服务不可用，无法注册界面')
        return
      }
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-astock:styles')

      const firstTpl = templateById('ma')
      const store = createStore({
        watchlist: [], selected: null, tab: 'kline',
        period: 'day', fq: 'qfq', years: 3,
        bars: [], seriesKey: '', barsLoading: false, barsError: '', source: '',
        quote: null, quoteError: '',
        fins: [], finsError: '', finsLoading: false,
        span: 250, offset: 0, hover: null,
        menu: null, menuItems: [], note: '',
        templateId: firstTpl.id, params: defaultParams(firstTpl),
        strategyMode: 'expr',
        buyExpr: firstTpl.buy(defaultParams(firstTpl)), sellExpr: firstTpl.sell(defaultParams(firstTpl)),
        jsSource: DEFAULT_JS,
        aiDescription: '', aiBusy: false, aiError: '', aiNote: '',
        disclaimer: null, disclaimerBusy: false,
        capital: 1000000, commission: 0.00025, stampTax: 0.0005, stampTaxBuy: 0, transferFee: 0.00001, slippage: 0.001,
        btFrom: yearsAgoISO(DEFAULT_BT_YEARS), btTo: '',
        bt: null, btRunning: false,
      })

      function useStore(target) {
        const [snapshot, setSnapshot] = React.useState(target.get())
        React.useEffect(() => target.subscribe(() => { setSnapshot(target.get()) }), [])
        return snapshot
      }

      const fmt = (value, digits) => {
        if (value === null || value === undefined || !isFinite(value)) return '—'
        return Number(value).toFixed(digits === undefined ? 2 : digits)
      }
      const fmtCap = (value) => {
        if (value === null || value === undefined || !isFinite(value)) return '—'
        if (Math.abs(value) >= 10000) return (value / 10000).toFixed(2) + ' 万亿'
        return value.toFixed(2) + ' 亿'
      }
      // 成交额单位随市场不同：A 股行情给的是万元，港股给的是元。
      const fmtAmount = (quote) => {
        const v = quote && quote.amount
        if (v === null || v === undefined || !isFinite(v)) return '—'
        if (quote.amountUnit === 'wan') return (v / 10000).toFixed(2) + ' 亿'
        if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
        if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万'
        return v.toFixed(0)
      }
      const fmtPct = (value, digits) => {
        if (value === null || value === undefined || !isFinite(value)) return '—'
        return (value * 100).toFixed(digits === undefined ? 2 : digits) + '%'
      }
      // A股习惯：红涨绿跌，故涨用 error 色、跌用 success 色。
      const tone = (value) => {
        if (value === null || value === undefined || !isFinite(value) || value === 0) return 'astk-flat'
        return value > 0 ? 'astk-up' : 'astk-down'
      }

      function persist(list) {
        apiPost('watchlist', { items: list })
          .then(() => { store.set({ note: '' }) })
          .catch((error) => { store.set({ note: '自选股未能保存：' + String((error && error.message) || error) }) })
      }

      function loadBars() {
        const state = store.get()
        if (!state.selected) return
        const key = state.selected + '|' + state.period + '|' + state.fq + '|' + state.years
        store.set({ barsLoading: true, barsError: '', seriesKey: key, bt: null })
        api('kline', { code: state.selected, period: state.period, fq: state.fq, years: String(state.years) })
          .then((res) => {
            if (store.get().seriesKey !== key) return
            store.set({
              bars: Array.isArray(res.bars) ? res.bars : [],
              barsLoading: false, source: String(res.source || ''), offset: 0, hover: null,
            })
          })
          .catch((error) => {
            if (store.get().seriesKey !== key) return
            store.set({ bars: [], barsLoading: false, barsError: String((error && error.message) || error) })
          })
      }

      function loadQuote(code) {
        api('quote', { code })
          .then((q) => { if (store.get().selected === code) store.set({ quote: q, quoteError: '' }) })
          .catch((error) => {
            if (store.get().selected === code) store.set({ quote: null, quoteError: String((error && error.message) || error) })
          })
      }

      function loadFins(code) {
        store.set({ finsLoading: true, finsError: '' })
        api('financials', { code })
          .then((res) => {
            if (store.get().selected === code) store.set({ fins: Array.isArray(res.rows) ? res.rows : [], finsLoading: false })
          })
          .catch((error) => {
            if (store.get().selected === code) store.set({ fins: [], finsLoading: false, finsError: String((error && error.message) || error) })
          })
      }

      function select(code) {
        store.set({ selected: code, quote: null, quoteError: '', fins: [], finsError: '', hover: null, offset: 0, bt: null })
        loadQuote(code); loadFins(code); loadBars()
      }

      function search(q) {
        if (q.trim() === '') { store.set({ menu: null, menuItems: [] }); return }
        api('search', { q })
          .then((res) => store.set({ menu: 'search', menuItems: Array.isArray(res.items) ? res.items : [] }))
          .catch((error) => store.set({ menu: null, menuItems: [], note: '搜索失败：' + String((error && error.message) || error) }))
      }

      function addStock(item) {
        const list = store.get().watchlist.slice()
        if (list.some((x) => x.code === item.code)) { store.set({ menu: null }); return }
        list.push({ code: item.code, name: item.name })
        store.set({ watchlist: list, menu: null, menuItems: [] })
        persist(list)
        select(item.code)
      }

      function removeStock(code) {
        const list = store.get().watchlist.filter((x) => x.code !== code)
        const next = store.get().selected === code ? (list.length > 0 ? list[0].code : null) : store.get().selected
        store.set({ watchlist: list, selected: next, quote: null, bars: [], fins: [], bt: null })
        persist(list)
        if (next) select(next)
      }

      function pickTemplate(id) {
        const tpl = templateById(id)
        const p = defaultParams(tpl)
        // 模板按钮填当前生效的那个编辑器：表达式模式填两行条件，JS 模式填等价代码。
        const patch = { templateId: id, params: p, buyExpr: tpl.buy(p), sellExpr: tpl.sell(p) }
        if (typeof tpl.js === 'function') patch.jsSource = tpl.js(p)
        store.set(patch)
      }

      function setParam(key, value) {
        const s = store.get()
        const tpl = templateById(s.templateId)
        const p = Object.assign({}, s.params)
        p[key] = value
        const patch = { params: p, buyExpr: tpl.buy(p), sellExpr: tpl.sell(p) }
        if (typeof tpl.js === 'function') patch.jsSource = tpl.js(p)
        store.set(patch)
      }

      /**
       * 提交免责声明确认，落盘后不再弹出。
       */
      async function acceptDisclaimer() {
        store.set({ disclaimerBusy: true })
        try {
          const res = await apiPost('disclaimer', { accept: true })
          store.set({ disclaimer: res, disclaimerBusy: false })
        } catch (error) {
          store.set({ disclaimerBusy: false, note: '免责声明确认未保存：' + String((error && error.message) || error) })
        }
      }

      /**
       * 让宿主的默认模型根据自然语言描述生成策略代码。
       *
       * 拿到代码后**立刻用当前 K 线试运行一遍**：语法错、运行错、信号长度不对
       * 都能当场暴露，而不是等用户点了回测才发现。试运行失败也会把代码填进去，
       * 方便用户看见并手动修。
       */
      async function generateWithAi() {
        const s = store.get()
        const description = s.aiDescription.trim()
        if (description === '') {
          store.set({ aiError: '先用一句话描述你想要的策略，例如「20 日均线上穿 60 日均线买入，跌破 20 日线卖出」', aiNote: '' })
          return
        }
        store.set({ aiBusy: true, aiError: '', aiNote: '' })
        try {
          const res = await apiPost('generate-strategy', {
            description,
            // 只在 JS 模式下把现有代码交给模型，让它在此基础上改。
            currentCode: s.strategyMode === 'js' ? s.jsSource : '',
          })
          const code = String(res.code || '')
          if (code === '') throw new Error('模型没有返回代码')
          let note = '已由 ' + String(res.model || '模型') + ' 生成'
          if (res.usage && typeof res.usage.outputTokens === 'number') note += '（输出 ' + res.usage.outputTokens + ' tokens）'
          try {
            const bars = store.get().bars
            if (bars && bars.length >= 30) {
              runJsStrategy(code, seriesOf(bars))
              note += '，已通过试运行校验'
            }
          } catch (error) {
            note += '；但试运行报错：' + String((error && error.message) || error)
          }
          store.set({ jsSource: code, strategyMode: 'js', aiBusy: false, aiNote: note, aiError: '' })
        } catch (error) {
          store.set({ aiBusy: false, aiNote: '', aiError: '生成失败：' + String((error && error.message) || error) })
        }
      }

      /**
       * 套用年份快捷档位。
       *
       * 需要的年数超过已加载范围时，连带把 K 线年数调大并重新取数——否则用户会
       * 拿到一个被静默裁剪的区间，还得自己想起来去「K线」页调年数。
       * @param years - 档位年数；0 表示全部区间。
       */
      function applyBtPreset(years) {
        if (years === 0) {
          store.set({ btFrom: '', btTo: '' })
          return
        }
        const s = store.get()
        const patch = { btFrom: yearsAgoISO(years), btTo: '' }
        if (years > s.years) {
          patch.years = years
          store.set(patch)
          loadBars()
          return
        }
        store.set(patch)
      }

      function runBacktest() {
        const s = store.get()
        if (!s.bars || s.bars.length < 30) {
          store.set({ bt: { error: 'K线不足 30 根，无法回测' }, tab: 'backtest' })
          return
        }
        // 回测区间：客户端按日期切已加载的 K 线，不重新取数（切换区间是瞬时的）。
        const allBars = s.bars
        const from = String(s.btFrom || '')
        const to = String(s.btTo || '')
        const bars = (from === '' && to === '') ? allBars
          : allBars.filter((b) => (from === '' || b[0] >= from) && (to === '' || b[0] <= to))
        if (bars.length < 30) {
          store.set({
            btRunning: false,
            bt: {
              error: '所选区间只有 ' + bars.length + ' 根 K 线，至少需要 30 根。'
                + (from !== '' && allBars.length > 0 && from < allBars[0][0] ? ' 起始日早于已加载的数据（最早 ' + allBars[0][0] + '），请到「K线」页把年数调大。' : ''),
            },
            tab: 'backtest',
          })
          return
        }
        store.set({ btRunning: true, bt: null })
        let buySeries = null
        let sellSeries = null
        try {
          const S = seriesOf(bars)
          if (s.strategyMode === 'js') {
            const signals = runJsStrategy(s.jsSource, S)
            buySeries = signals.buy
            sellSeries = signals.sell
          } else {
            buySeries = evalAst(parseSource(s.buyExpr), S)
            sellSeries = evalAst(parseSource(s.sellExpr), S)
          }
        } catch (error) {
          const label = s.strategyMode === 'js' ? 'JS 策略错误：' : '表达式错误：'
          store.set({ btRunning: false, bt: { error: label + String((error && error.message) || error) }, tab: 'backtest' })
          return
        }
        const profile = marketProfile(s.selected)
        // 每手股数优先用行情里的真实值（港股逐股不同），拿不到才退回市场默认。
        const lot = (s.quote && s.quote.lot > 0) ? s.quote.lot : profile.lotDefault
        const lotSource = (s.quote && s.quote.lot > 0) ? '来自行情' : '按市场默认'
        const result = runEngine(bars, buySeries, sellSeries, {
          capital: s.capital, commission: s.commission, stampTax: s.stampTax, stampTaxBuy: s.stampTaxBuy,
          transferFee: s.transferFee, slippage: s.slippage,
          limitPct: limitPctOf(s.selected), t1: profile.t1, lot,
        })
        const metrics = computeMetrics(result.equity, result.trades, s.capital)
        // 无交易时给出可操作的原因，而不是一个沉默的 0。
        const hints = []
        if (metrics.count === 0) {
          let minOpen = Infinity
          for (const b of bars) if (b[1] > 0 && b[1] < minOpen) minOpen = b[1]
          const lotCost = minOpen * lot
          hints.push('区间内最低开盘价 ' + minOpen.toFixed(2) + ' ' + profile.unit + '，买入 1 手（' + lot + ' 股）需约 ' + lotCost.toFixed(0) + ' ' + profile.unit + '（含滑点更高），当前初始资金 ' + s.capital + '。')
          if (s.capital < lotCost) hints.push('资金不足以买入 1 手，因此引擎从未建仓——请调高初始资金，或换一只价格较低的股票。')
          else hints.push('资金足够，说明买入条件在该区间从未触发' + (profile.t1 ? '，或触发时正好遇到涨停无法成交。' : '。'))
        }
        if (result.blockedBuy > 0) hints.push('有 ' + result.blockedBuy + ' 次买入信号因次日开盘涨停未能成交。')
        if (result.blockedSell > 0) hints.push('有 ' + result.blockedSell + ' 次卖出信号因次日开盘跌停未能成交。')
        hints.push('本回测按【' + profile.name + '】规则：' + profile.rule + ' 每手按 ' + lot + ' 股（' + lotSource + '）。')
        if (profile.id === 'hk') hints.push('数据口径：腾讯不提供港股复权价，本段 K 线为不复权，除权除息日会有价格跳空，长期收益会略被低估。')
        if (result.holding) hints.push('注意：回测结束时仍有持仓，期末权益按最后一根收盘价计入，未平仓。')
        // 区间被裁过或数据不全时说明，免得用户以为策略没生效。
        if ((from !== '' || to !== '') && bars.length < allBars.length) {
          hints.push('已按所选区间切出 ' + bars.length + ' 根（共加载 ' + allBars.length + ' 根）。')
        }
        if (from !== '' && allBars.length > 0 && from < allBars[0][0]) {
          hints.push('起始日 ' + from + ' 早于已加载的最早数据 ' + allBars[0][0] + '，该段未参与回测；需要更早数据请到「K线」页把年数调大。')
        }
        const payload = {
          metrics, equity: result.equity, trades: result.trades, bench: null, capital: s.capital,
          error: '', hints, market: profile.id, currency: profile.unit,
          firstDate: bars[0][0], lastDate: bars[bars.length - 1][0], loadedBars: allBars.length,
        }
        store.set({ tab: 'backtest' })
        api('kline', { symbol: 'sh000300', period: 'day', fq: '', years: String(s.years) })
          .then((res) => { payload.bench = alignBenchmark(bars, res && res.bars) })
          .catch(() => {})
          .then(() => { store.set({ btRunning: false, bt: payload }) })
      }

      function CandleChart(props) {
        const bars = props.bars || []
        const { start, end, hover, onHover } = props
        const W = 980; const H = 470
        const padL = 8; const padR = 66; const padT = 10; const padB = 22
        const volH = 86; const gapY = 14
        const priceH = H - padT - padB - volH - gapY
        const volTop = padT + priceH + gapY
        const plotW = W - padL - padR
        const count = Math.max(1, end - start)
        let lo = Infinity; let hi = -Infinity; let vmax = 0
        for (let i = start; i < end; i++) {
          const b = bars[i]; if (!b) continue
          if (b[4] < lo) lo = b[4]
          if (b[3] > hi) hi = b[3]
          if (b[5] > vmax) vmax = b[5]
        }
        if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = 0; hi = 1 }
        const padP = (hi - lo) * 0.05 || 1
        lo -= padP; hi += padP
        const range = hi - lo || 1
        const bw = plotW / count
        const xOf = (k) => padL + (k + 0.5) * bw
        const yOf = (p) => padT + (hi - p) / range * priceH
        const vyOf = (v) => volTop + volH - (vmax > 0 ? (v / vmax) * volH : 0)
        const children = []

        const ticks = []
        for (let t = 0; t <= 4; t++) {
          const p = lo + range * t / 4
          const y = yOf(p)
          ticks.push(React.createElement('g', { key: 't' + t },
            React.createElement('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
            React.createElement('text', { x: padL + plotW + 6, y: y + 3.5, fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, p.toFixed(2))))
        }
        children.push(React.createElement('g', { key: 'grid' }, ticks))

        const maDefs = [
          { series: props.ma5, color: 'var(--dsw-alias-brand-primary)' },
          { series: props.ma10, color: 'var(--dsw-alias-state-warn-primary)' },
          { series: props.ma20, color: 'var(--dsw-alias-state-success-primary)' },
          { series: props.ma60, color: 'var(--dsw-alias-label-secondary)' },
        ]
        const maNodes = []
        for (let m = 0; m < maDefs.length; m++) {
          const series = maDefs[m].series
          if (!series) continue
          let d = ''; let open = false
          for (let i = start; i < end; i++) {
            const v = series[i]
            if (v === null || v === undefined || !isFinite(v)) { open = false; continue }
            d += (open ? 'L' : 'M') + xOf(i - start).toFixed(2) + ' ' + yOf(v).toFixed(2)
            open = true
          }
          if (d !== '') maNodes.push(React.createElement('path', { key: 'ma' + m, d, fill: 'none', stroke: maDefs[m].color, strokeWidth: 1.1, opacity: 0.9 }))
        }
        children.push(React.createElement('g', { key: 'mas' }, maNodes))

        const nodes = []
        for (let i = start; i < end; i++) {
          const b = bars[i]; if (!b) continue
          const k = i - start
          const cx = xOf(k)
          const up = b[2] >= b[1]
          const color = up ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'
          const yO = yOf(b[1]); const yC = yOf(b[2])
          const bodyW = Math.max(1.4, bw * 0.64)
          nodes.push(React.createElement('line', { key: 'w' + k, x1: cx, y1: yOf(b[3]), x2: cx, y2: yOf(b[4]), stroke: color, strokeWidth: Math.max(1, Math.min(2, bw * 0.16)) }))
          nodes.push(React.createElement('rect', { key: 'b' + k, x: cx - bodyW / 2, y: Math.min(yO, yC), width: bodyW, height: Math.max(1, Math.abs(yC - yO)), fill: up ? 'var(--dsw-alias-bg-base)' : color, stroke: color, strokeWidth: 1 }))
          nodes.push(React.createElement('rect', { key: 'v' + k, x: cx - bodyW / 2, y: vyOf(b[5]), width: bodyW, height: Math.max(0.6, volTop + volH - vyOf(b[5])), fill: color, opacity: 0.45 }))
        }
        children.push(React.createElement('g', { key: 'candles' }, nodes))

        if (hover !== null && hover >= start && hover < end) {
          const cx = xOf(hover - start)
          children.push(React.createElement('line', { key: 'cross', x1: cx, y1: padT, x2: cx, y2: volTop + volH, stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8 }))
        }

        const step = Math.max(1, Math.floor(count / 6))
        const labels = []
        for (let i = start; i < end; i += step) {
          const b = bars[i]; if (!b) continue
          labels.push(React.createElement('text', { key: 'x' + i, x: xOf(i - start), y: H - 6, fontSize: 11, textAnchor: 'middle', fill: 'var(--dsw-alias-label-secondary)' }, String(b[0]).slice(2)))
        }
        children.push(React.createElement('g', { key: 'xlabels' }, labels))

        if (onHover) {
          const hit = []
          for (let i = start; i < end; i++) {
            hit.push(React.createElement('rect', { key: 'h' + (i - start), x: padL + (i - start) * bw, y: padT, width: bw, height: volTop + volH - padT, fill: 'transparent', onMouseEnter: () => onHover(i) }))
          }
          children.push(React.createElement('g', { key: 'hit' }, hit))
        }

        return React.createElement('svg', {
          className: 'astk-chart',
          viewBox: '0 0 ' + W + ' ' + H,
          onMouseLeave: onHover ? () => onHover(null) : undefined,
        }, children)
      }

      function EquityChart(props) {
        const equity = props.equity || []
        const { bench, capital } = props
        const n = equity.length
        if (n === 0) return null
        const W = 980; const H = 260
        const padL = 8; const padR = 62; const padT = 12; const padB = 22
        const plotW = W - padL - padR
        const plotH = H - padT - padB
        const strat = new Array(n)
        for (let i = 0; i < n; i++) strat[i] = capital > 0 ? equity[i] / capital : 1
        let lo = Infinity; let hi = -Infinity
        for (const v of strat) { if (v < lo) lo = v; if (v > hi) hi = v }
        if (bench) for (const v of bench) { if (v === null || v === undefined) continue; if (v < lo) lo = v; if (v > hi) hi = v }
        if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = 0.9; hi = 1.1 }
        const padP = (hi - lo) * 0.06 || 0.01
        lo -= padP; hi += padP
        const range = hi - lo || 1
        const xOf = (i) => padL + (n <= 1 ? 0 : i / (n - 1)) * plotW
        const yOf = (v) => padT + (hi - v) / range * plotH
        const pathOf = (series) => {
          let d = ''; let open = false
          for (let i = 0; i < n; i++) {
            const v = series[i]
            if (v === null || v === undefined || !isFinite(v)) { open = false; continue }
            d += (open ? 'L' : 'M') + xOf(i).toFixed(2) + ' ' + yOf(v).toFixed(2)
            open = true
          }
          return d
        }
        const children = []
        const ticks = []
        for (let t = 0; t <= 4; t++) {
          const v = lo + range * t / 4
          const y = yOf(v)
          ticks.push(React.createElement('g', { key: 't' + t },
            React.createElement('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
            React.createElement('text', { x: padL + plotW + 6, y: y + 3.5, fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, ((v - 1) * 100).toFixed(1) + '%')))
        }
        children.push(React.createElement('g', { key: 'g' }, ticks))
        const baseY = yOf(1)
        children.push(React.createElement('line', { key: 'base', x1: padL, y1: baseY, x2: padL + plotW, y2: baseY, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: '4 3' }))
        if (bench) children.push(React.createElement('path', { key: 'bench', d: pathOf(bench), fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1.2, opacity: 0.85 }))
        children.push(React.createElement('path', { key: 'strat', d: pathOf(strat), fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.6 }))
        return React.createElement('svg', { className: 'astk-chart', viewBox: '0 0 ' + W + ' ' + H }, children)
      }

      function Panel() {
        const s = useStore(store)

        React.useEffect(() => {
          let alive = true
          api('watchlist').then((res) => {
            if (!alive) return
            const items = Array.isArray(res.items) ? res.items : []
            if (items.length > 0) { store.set({ watchlist: items }); select(items[0].code) }
          }).catch(() => {})
          return () => { alive = false }
        }, [])

        // 拉取免责声明确认状态。失败时保持 null（不弹窗）——页脚的常驻声明
        // 仍然可见，所以不会出现「既没弹窗也看不到声明」的空档。
        React.useEffect(() => {
          let alive = true
          api('disclaimer')
            .then((res) => { if (alive) store.set({ disclaimer: res }) })
            .catch(() => { if (alive) store.set({ disclaimer: null }) })
          return () => { alive = false }
        }, [])

        const bars = s.bars || []
        const n = bars.length
        const span = Math.min(s.span, Math.max(1, n))
        const maxOffset = Math.max(0, n - span)
        const offset = Math.min(s.offset, maxOffset)
        const end = n - offset
        const start = Math.max(0, end - span)
        const ma5 = n > 0 ? movingAverage(bars, 5) : null
        const ma10 = n > 0 ? movingAverage(bars, 10) : null
        const ma20 = n > 0 ? movingAverage(bars, 20) : null
        const ma60 = n > 0 ? movingAverage(bars, 60) : null
        const hb = s.hover !== null && s.hover >= 0 && s.hover < n ? bars[s.hover] : null
        const prev = s.hover !== null && s.hover > 0 ? bars[s.hover - 1] : null
        const hChg = hb && prev ? (hb[2] - prev[2]) / prev[2] * 100 : null
        const q = s.quote

        const head = React.createElement('div', { className: 'astk-head' },
          React.createElement('div', { className: 'astk-title' }, 'A股港股量化工作台'),
          React.createElement('div', { className: 'astk-res' },
            React.createElement('input', {
              className: 'astk-in',
              placeholder: '代码 / 名称 / 拼音，回车搜索',
              onChange: (e) => search(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') search(e.target.value) },
            }),
            s.menu === 'search' && s.menuItems.length > 0
              ? React.createElement('div', { className: 'astk-menu' },
                  s.menuItems.map((it, idx) => React.createElement('div', { key: it.code + idx, onClick: () => addStock(it) },
                    React.createElement('span', null, it.name),
                    React.createElement('span', { className: 'astk-code' }, it.code + (it.board ? ' · ' + it.board : '')))))
              : null))

        const sideItems = s.watchlist.map((w) => React.createElement('div', {
          key: w.code,
          className: 'astk-item' + (s.selected === w.code ? ' astk-item-on' : ''),
          onClick: () => { if (s.selected !== w.code) select(w.code) },
        },
        React.createElement('div', null,
          React.createElement('div', null, w.name),
          React.createElement('div', { className: 'astk-code' }, w.code)),
        React.createElement('button', { className: 'astk-btn', onClick: (e) => { e.stopPropagation(); removeStock(w.code) } }, '移除')))

        const side = React.createElement('div', { className: 'astk-side' },
          React.createElement('div', { className: 'astk-note' }, '自选股（' + s.watchlist.length + '）'),
          s.watchlist.length === 0
            ? React.createElement('div', { className: 'astk-note' }, '用上方搜索框添加，例如输入「茅台」或 600519。')
            : React.createElement('div', null, sideItems),
          s.note ? React.createElement('div', { className: 'astk-err' }, s.note) : null)

        let content = null
        if (s.selected === null) {
          content = React.createElement('div', { className: 'astk-note' }, '尚未选择股票。先在左侧添加一只。')
        } else if (s.tab === 'kline') {
          const toolbar = React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' } },
            ['day', 'week', 'month'].map((p) => React.createElement('button', {
              key: p,
              className: 'astk-btn' + (s.period === p ? ' astk-btn-on' : ''),
              onClick: () => { store.set({ period: p, offset: 0 }); loadBars() },
            }, { day: '日线', week: '周线', month: '月线' }[p])),
            React.createElement('span', { style: { width: '10px' } }),
            [['qfq', '前复权'], ['hfq', '后复权'], ['', '不复权']].map((pair) => React.createElement('button', {
              key: pair[0] === '' ? 'none' : pair[0],
              className: 'astk-btn' + (s.fq === pair[0] ? ' astk-btn-on' : ''),
              onClick: () => { store.set({ fq: pair[0], offset: 0 }); loadBars() },
            }, pair[1])),
            React.createElement('span', { style: { width: '10px' } }),
            [1, 3, 5, 10].map((y) => React.createElement('button', {
              key: 'y' + y,
              className: 'astk-btn' + (s.years === y ? ' astk-btn-on' : ''),
              onClick: () => { store.set({ years: y, offset: 0 }); loadBars() },
            }, y + '年')),
            React.createElement('span', { style: { width: '10px' } }),
            [60, 120, 250, 500].map((sp) => React.createElement('button', {
              key: 's' + sp,
              className: 'astk-btn' + (s.span === sp ? ' astk-btn-on' : ''),
              onClick: () => { store.set({ span: sp, offset: 0 }) },
            }, sp + '根')))

          const readout = React.createElement('div', { className: 'astk-readout' },
            hb ? [
              React.createElement('span', { key: 'd' }, hb[0]),
              React.createElement('span', { key: 'o' }, '开 ' + fmt(hb[1])),
              React.createElement('span', { key: 'h' }, '高 ' + fmt(hb[3])),
              React.createElement('span', { key: 'l' }, '低 ' + fmt(hb[4])),
              React.createElement('span', { key: 'c' }, '收 ' + fmt(hb[2])),
              React.createElement('span', { key: 'g', className: tone(hChg) }, (hChg === null ? '—' : (hChg >= 0 ? '+' : '') + hChg.toFixed(2) + '%')),
              React.createElement('span', { key: 'v' }, '量 ' + (hb[5] === null ? '—' : hb[5])),
              React.createElement('span', { key: 'm', style: { color: 'var(--dsw-alias-brand-primary)' } }, 'MA5 ' + fmt(ma5 ? ma5[s.hover] : null)),
              React.createElement('span', { key: 'm1', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, 'MA10 ' + fmt(ma10 ? ma10[s.hover] : null)),
              React.createElement('span', { key: 'm2', style: { color: 'var(--dsw-alias-state-success-primary)' } }, 'MA20 ' + fmt(ma20 ? ma20[s.hover] : null)),
              React.createElement('span', { key: 'm3' }, 'MA60 ' + fmt(ma60 ? ma60[s.hover] : null)),
            ] : [
              React.createElement('span', { key: 'tip' }, '鼠标移到图上查看逐根数据'),
              React.createElement('span', { key: 'r' }, '区间 ' + start + '–' + end + ' / 共 ' + n + ' 根' + (s.source ? '（源：' + s.source + '）' : '')),
            ])

          const slider = n > span
            ? React.createElement('input', {
                type: 'range', min: 0, max: maxOffset, value: maxOffset - offset, style: { width: '100%' },
                onChange: (e) => { store.set({ offset: maxOffset - Number(e.target.value) }) },
              })
            : null

          content = React.createElement('div', null,
            toolbar, readout,
            s.barsLoading ? React.createElement('div', { className: 'astk-note' }, '加载K线中…') : null,
            s.barsError ? React.createElement('div', { className: 'astk-err' }, 'K线加载失败：' + s.barsError) : null,
            n > 0 ? React.createElement(CandleChart, {
              bars, start, end, hover: s.hover, ma5, ma10, ma20, ma60,
              onHover: (i) => store.set({ hover: i }),
            }) : null,
            slider)
        } else if (s.tab === 'company') {
          const rows = s.fins.map((r) => React.createElement('tr', { key: r.date },
            React.createElement('td', null, r.date),
            React.createElement('td', null, fmt(r.eps)),
            React.createElement('td', null, fmt(r.bps)),
            React.createElement('td', null, fmt(r.roe)),
            React.createElement('td', null, fmt(r.gross))))
          content = React.createElement('div', null,
            s.finsLoading ? React.createElement('div', { className: 'astk-note' }, '加载财务数据中…') : null,
            s.finsError ? React.createElement('div', { className: 'astk-err' }, '财务数据加载失败：' + s.finsError) : null,
            s.fins.length > 0
              ? React.createElement('table', { className: 'astk-tab' },
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', null, '报告期'),
                    React.createElement('th', null, '每股收益(元)'),
                    React.createElement('th', null, '每股净资产(元)'),
                    React.createElement('th', null, 'ROE(%)'),
                    React.createElement('th', null, '毛利率(%)'))),
                  React.createElement('tbody', null, rows))
              : (s.finsLoading ? null : React.createElement('div', { className: 'astk-note' }, '暂无财务数据。')))
        } else if (s.tab === 'strategy') {
          const tpl = templateById(s.templateId)
          // 当前标的所属市场 —— 决定 T+1/T+0、涨跌停、费率与每手股数。
          const activeProfile = marketProfile(s.selected)
          const tplButtons = TEMPLATES.map((t) => React.createElement('button', {
            key: t.id,
            className: 'astk-btn' + (s.templateId === t.id ? ' astk-btn-on' : ''),
            onClick: () => pickTemplate(t.id),
          }, t.name))
          const paramFields = tpl.params.map((def) => React.createElement('label', { key: def[0], className: 'astk-field' }, def[1],
            React.createElement('input', {
              type: 'number',
              value: s.params[def[0]] === undefined ? def[2] : s.params[def[0]],
              onChange: (e) => setParam(def[0], Number(e.target.value)),
            })))
          const numField = (key, label, step) => React.createElement('label', { key, className: 'astk-field' }, label,
            React.createElement('input', {
              type: 'number', step, value: s[key], 'data-astk': 'num-' + key,
              onChange: (e) => { const patch = {}; patch[key] = Number(e.target.value); store.set(patch) },
            }))
          const modeButtons = [['expr', '表达式'], ['js', 'JavaScript']].map((pair) => React.createElement('button', {
            key: pair[0],
            className: 'astk-btn' + (s.strategyMode === pair[0] ? ' astk-btn-on' : ''),
            onClick: () => store.set({ strategyMode: pair[0] }),
          }, pair[1]))

          // 两个模式各自的条件编辑区。JS 模式允许循环、变量与分支。
          const editor = s.strategyMode === 'js'
            ? React.createElement('div', { className: 'astk-sec' },
                React.createElement('h4', null, '策略代码（JavaScript）'),
                React.createElement('textarea', {
                  className: 'astk-ta', rows: 16, spellCheck: false, value: s.jsSource,
                  'data-astk': 'js-source',
                  onChange: (e) => store.set({ jsSource: e.target.value }),
                }),
                React.createElement('div', { className: 'astk-note' },
                  '可用（都是与 K 线等长的数组，索引可直接用）：C O H L V；MA(x,n) EMA(x,n) SUM(x,n) STD(x,n) HHV(x,n) LLV(x,n) REF(x,n)；RSI(n) DIF() DEA() MACD() BOLL_UP(p,k) BOLL_MID(p) BOLL_LOW(p,k)；CROSS(a,b) GT LT GTE LTE AND OR NOT，以及 ABS/MAX/MIN。'),
                React.createElement('div', { className: 'astk-note' },
                  '必须 return { buy, sell }，两个数组长度都要等于 C.length。可以写任意 JS：循环、变量、多条件分支、自定义中间量。'),
                React.createElement('div', { className: 'astk-warn' },
                  '注意：代码在你的浏览器里执行。请避免死循环（如 while(true)）——主线程被占满会让界面卡住，刷新页面即可恢复。'))
            : React.createElement('div', { className: 'astk-sec' },
                React.createElement('h4', null, '买入条件'),
                React.createElement('textarea', {
                  className: 'astk-ta', rows: 3, value: s.buyExpr,
                  'data-astk': 'buy-expr',
                  onChange: (e) => store.set({ buyExpr: e.target.value }),
                }),
                React.createElement('h4', { style: { marginTop: '10px' } }, '卖出条件'),
                React.createElement('textarea', {
                  className: 'astk-ta', rows: 3, value: s.sellExpr,
                  'data-astk': 'sell-expr',
                  onChange: (e) => store.set({ sellExpr: e.target.value }),
                }),
                React.createElement('div', { className: 'astk-note' },
                  '可用：C O H L V（收/开/高/低/量）、MA(n) EMA(n) SUM(n) STD(n)、RSI(n)、DIF() DEA() MACD()、BOLL_UP(n,k) BOLL_MID(n) BOLL_LOW(n,k)、HHV(n) LLV(n) REF(x,n) CROSS(a,b)、ABS/MAX/MIN，以及 + - * / > < >= <= == != AND OR NOT 与括号。'),
                React.createElement('div', { className: 'astk-note' },
                  '说明：信号在收盘产生、次日开盘成交（无未来函数）；买入当日不可卖出（T+1）。需要循环或多分支时切到 JavaScript 模式。'))

          // AI 生成：描述需求 -> 宿主默认模型产出 JS 代码 -> 立即试运行校验。
          // 置顶操作条：回测区间 + 开始回测。主要动作放最上面，不用翻到底部。
          const loadedSpan = s.bars.length > 0 ? (s.bars[0][0] + ' ~ ' + s.bars[s.bars.length - 1][0]) : '（尚未加载 K 线）'
          const dateField = (key, label) => React.createElement('label', { key, className: 'astk-field' }, label,
            React.createElement('input', {
              type: 'date', className: 'astk-date', value: s[key], 'data-astk': 'date-' + key,
              onChange: (e) => store.set({ [key]: e.target.value }),
            }))
          const rangeSection = React.createElement('div', { className: 'astk-top' },
            React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
              React.createElement('button', {
                className: 'astk-btn astk-btn-on',
                onClick: () => runBacktest(),
              }, s.btRunning ? '回测中…' : '开始回测'),
              dateField('btFrom', '起始'),
              React.createElement('span', { className: 'astk-field' }, '~'),
              dateField('btTo', '结束')),
            // 年份快捷档位：原生日期选择器只能按月步进，这里给年到年的跳转。
            React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' } },
              React.createElement('span', { className: 'astk-field' }, '快捷区间'),
              BT_PRESETS.map((y) => React.createElement('button', {
                key: 'p' + y,
                className: 'astk-btn' + (y === DEFAULT_BT_YEARS && s.btFrom === yearsAgoISO(y) && s.btTo === '' ? ' astk-btn-on' : ''),
                onClick: () => applyBtPreset(y),
              }, y === 0 ? '全部' : '近' + y + '年')),
              React.createElement('span', { className: 'astk-note', style: { padding: 0 } },
                '已加载 ' + s.bars.length + ' 根：' + loadedSpan + '（选更长的档位会自动多取数据）')),
            (s.btFrom !== '' || s.btTo !== '') && s.bars.length > 0
              ? React.createElement('div', { className: 'astk-note' }, (() => {
                const hit = s.bars.filter((b) => (s.btFrom === '' || b[0] >= s.btFrom) && (s.btTo === '' || b[0] <= s.btTo)).length
                return hit < 30
                  ? '所选区间只有 ' + hit + ' 根 K 线，不足以回测（至少 30 根）。'
                  : '所选区间命中 ' + hit + ' 根 K 线。'
              })())
              : null)

          const aiSection = React.createElement('div', { className: 'astk-sec' },
            React.createElement('h4', null, '让 AI 生成策略（用文字描述）'),
            React.createElement('textarea', {
              className: 'astk-ta', rows: 3, value: s.aiDescription,
              'data-astk': 'ai-description',
              placeholder: '例如：20 日均线上穿 60 日均线时买入，跌破 20 日均线时卖出，成交量低于 20 日均量时不做买入。',
              onChange: (e) => store.set({ aiDescription: e.target.value }),
            }),
            React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' } },
              React.createElement('button', {
                className: 'astk-btn astk-btn-on',
                disabled: s.aiBusy,
                onClick: () => { void generateWithAi() },
              }, s.aiBusy ? '生成中…' : 'AI 生成代码'),
              React.createElement('span', { className: 'astk-note', style: { padding: 0 } },
                s.strategyMode === 'js'
                  ? '当前是 JS 模式：会把你现有的代码一起交给模型，让它在此基础上改。'
                  : '生成后会切到 JavaScript 模式并填入代码。')),
            s.aiNote ? React.createElement('div', { className: 'astk-note' }, '✓ ' + s.aiNote) : null,
            s.aiError ? React.createElement('div', { className: 'astk-err' }, s.aiError) : null,
            React.createElement('div', { className: 'astk-note' },
              'AI 生成的策略代码仅供参考，未经审核，可能有逻辑错误或隐含风险；请自行阅读并验证后再用于回测。'))

          content = React.createElement('div', null,
            rangeSection,
            aiSection,
            React.createElement('div', { className: 'astk-sec' },
              React.createElement('h4', null, '策略方式'),
              React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } }, modeButtons),
              React.createElement('div', { className: 'astk-note' }, s.strategyMode === 'js'
                ? 'JavaScript：写任意代码，最灵活。'
                : '表达式：一行条件，简单直观；不支持循环与变量。')),
            React.createElement('div', { className: 'astk-sec' },
              React.createElement('h4', null, s.strategyMode === 'js' ? '策略模板（点击填入等价 JS 代码）' : '策略模板（点击填入表达式，之后可直接编辑）'),
              React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } }, tplButtons),
              paramFields.length > 0
                ? React.createElement('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, paramFields)
                : React.createElement('div', { className: 'astk-note' }, '该模板无可调参数。')),
            editor,
            React.createElement('div', { className: 'astk-sec' },
              React.createElement('h4', null, '回测参数'),
              React.createElement('div', { className: 'astk-note' },
                '当前标的：' + (s.selected || '—') + '，按【' + activeProfile.name + '】规则回测。'),
              React.createElement('div', { className: 'astk-warn' }, activeProfile.rule),
              React.createElement('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', marginTop: '8px' } },
                numField('capital', '初始资金(' + activeProfile.unit + ')', 10000),
                numField('commission', '佣金率', 0.00001),
                numField('stampTax', '印花税(卖)', 0.0001),
                numField('stampTaxBuy', '印花税(买)', 0.0001),
                numField('transferFee', '其他费率', 0.00001),
                numField('slippage', '滑点', 0.0005)),
              React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' } },
                React.createElement('button', {
                  className: 'astk-btn',
                  onClick: () => store.set({
                    commission: activeProfile.commission, stampTax: activeProfile.stampTax,
                    stampTaxBuy: activeProfile.stampTaxBuy, transferFee: activeProfile.transferFee,
                    slippage: activeProfile.slippage,
                  }),
                }, '套用' + activeProfile.name + '默认费率'),
                React.createElement('span', { className: 'astk-note', style: { padding: 0 } },
                  '每手股数取自行情（' + activeProfile.name + '默认 ' + activeProfile.lotDefault + ' 股）')),
              React.createElement('div', { className: 'astk-note' }, '回测区间在页面顶部的操作条里设置。')))
        } else {
          const bt = s.bt
          if (s.btRunning) content = React.createElement('div', { className: 'astk-note' }, '回测计算中…')
          else if (!bt) content = React.createElement('div', { className: 'astk-note' }, '还没有回测结果。到「策略配置」页配置条件后点「开始回测」。')
          else if (bt.error) content = React.createElement('div', { className: 'astk-err' }, bt.error)
          else {
            const m = bt.metrics
            const metric = (label, value, cls) => React.createElement('div', { className: 'astk-metric' },
              React.createElement('b', { className: cls || '' }, value),
              React.createElement('span', null, label))
            const grid = React.createElement('div', { className: 'astk-grid' },
              metric('总收益', fmtPct(m.totalReturn), tone(m.totalReturn)),
              metric('年化收益', fmtPct(m.annualized), tone(m.annualized)),
              metric('最大回撤', fmtPct(-m.maxDD), 'astk-down'),
              metric('夏普比率', fmt(m.sharpe)),
              metric('卡玛比率', fmt(m.calmar)),
              metric('胜率', fmtPct(m.winRate)),
              metric('盈亏比', fmt(m.plRatio)),
              metric('交易次数', String(m.count)),
              metric('期末权益', fmt(m.finalEq, 0) + ' ' + (bt.currency || '元')),
              metric('回测根数', m.bars + ' 根'))
            const spanLine = bt.firstDate
              ? React.createElement('div', { className: 'astk-note' },
                  '回测区间：' + bt.firstDate + ' ~ ' + bt.lastDate + '（' + m.bars + ' 根'
                  + (bt.loadedBars && bt.loadedBars !== m.bars ? '，已加载 ' + bt.loadedBars + ' 根' : '') + '）')
              : null
            const hintNodes = (bt.hints || []).map((text, i) => React.createElement('div', { className: 'astk-warn', key: 'h' + i }, '· ' + text))
            const legend = React.createElement('div', { className: 'astk-legend' },
              React.createElement('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, '— 策略'),
              bt.bench ? React.createElement('span', null, '— 沪深300基准') : React.createElement('span', null, '（基准数据不可用）'))
            const tradeRows = bt.trades.slice().reverse().slice(0, 200).map((t, idx) => React.createElement('tr', { key: idx },
              React.createElement('td', null, t.bd),
              React.createElement('td', null, fmt(t.bp)),
              React.createElement('td', null, t.sd),
              React.createElement('td', null, fmt(t.sp)),
              React.createElement('td', { className: tone(t.ret) }, (t.ret >= 0 ? '+' : '') + (t.ret * 100).toFixed(2) + '%'),
              React.createElement('td', null, t.days)))
            content = React.createElement('div', null,
              React.createElement('div', { className: 'astk-sec' }, grid, spanLine,
                React.createElement('div', { className: 'astk-warn' },
                  '以上为历史数据回测结果，不代表未来表现，也不构成任何投资建议。')),
              hintNodes.length > 0 ? React.createElement('div', { className: 'astk-sec' }, React.createElement('h4', null, '提示'), hintNodes) : null,
              React.createElement('div', { className: 'astk-sec' },
                React.createElement('h4', null, '资金曲线（归一化，虚线为 1.0 基准）'),
                legend,
                React.createElement(EquityChart, { equity: bt.equity, bench: bt.bench, capital: bt.capital })),
              React.createElement('div', { className: 'astk-sec' },
                React.createElement('h4', null, '交易明细（共 ' + bt.trades.length + ' 笔，最多显示 200 笔）'),
                bt.trades.length === 0
                  ? React.createElement('div', { className: 'astk-note' }, '该策略在此区间没有产生完整交易对。')
                  : React.createElement('table', { className: 'astk-tab' },
                      React.createElement('thead', null, React.createElement('tr', null,
                        React.createElement('th', null, '买入日'),
                        React.createElement('th', null, '买入价'),
                        React.createElement('th', null, '卖出日'),
                        React.createElement('th', null, '卖出价'),
                        React.createElement('th', null, '净收益率'),
                        React.createElement('th', null, '持有天数'))),
                      React.createElement('tbody', null, tradeRows))))
          }
        }

        const tabs = [['kline', 'K线'], ['company', '公司数据'], ['strategy', '策略配置'], ['backtest', '回测']].map((pair) => React.createElement('button', {
          key: pair[0],
          className: 'astk-btn' + (s.tab === pair[0] ? ' astk-btn-on' : ''),
          onClick: () => store.set({ tab: pair[0] }),
        }, pair[1]))

        const quoteBar = q
          ? React.createElement('div', { className: 'astk-quote' },
              React.createElement('div', null,
                React.createElement('div', { style: { fontWeight: 600, fontSize: '15px' } },
                  q.name + ' ' + q.code + (q.market === 'hk' ? ' · 港股' : ' · A股')),
                React.createElement('div', { className: 'astk-px ' + tone(q.changePct) }, fmt(q.price)),
                React.createElement('div', { className: tone(q.changePct) }, (q.change >= 0 ? '+' : '') + fmt(q.change) + '  ' + (q.changePct >= 0 ? '+' : '') + fmt(q.changePct) + '%')),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '今开'), React.createElement('b', null, fmt(q.open))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '昨收'), React.createElement('b', null, fmt(q.prevClose))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '最高'), React.createElement('b', { className: 'astk-up' }, fmt(q.high))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '最低'), React.createElement('b', { className: 'astk-down' }, fmt(q.low))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '成交额'), React.createElement('b', null, fmtAmount(q))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '换手率'), React.createElement('b', null, q.turnover === null || q.turnover === undefined ? '—' : fmt(q.turnover) + '%')),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '市盈率'), React.createElement('b', null, fmt(q.pe))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '市净率'), React.createElement('b', null, fmt(q.pb))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '总市值'), React.createElement('b', null, fmtCap(q.marketCap))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '流通市值'), React.createElement('b', null, fmtCap(q.floatCap))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '每手股数'), React.createElement('b', null, String(q.lot || '—'))),
              React.createElement('div', { className: 'astk-kv' }, React.createElement('span', null, '币种'), React.createElement('b', null, String(q.currency || '—'))))
          : React.createElement('div', null, s.quoteError ? React.createElement('div', { className: 'astk-err' }, '行情加载失败：' + s.quoteError) : null)

        const main = React.createElement('div', { className: 'astk-main' },
          quoteBar,
          React.createElement('div', { className: 'astk-tabs' }, tabs),
          content)

        // 首次使用（或条款版本变更）时的强制确认。落盘后不再出现。
        const d = s.disclaimer
        const gate = d !== null && d.accepted !== true
          ? React.createElement('div', { className: 'astk-gate' },
              React.createElement('div', { className: 'astk-gate-card' },
                React.createElement('h3', null, d.title || '免责声明'),
                React.createElement('div', { className: 'astk-note' }, '请阅读并确认后继续使用。'),
                (d.paragraphs || []).map((text, i) => React.createElement('p', { key: 'p' + i }, text)),
                React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '6px' } },
                  React.createElement('button', {
                    className: 'astk-btn astk-btn-on',
                    disabled: s.disclaimerBusy,
                    onClick: () => { void acceptDisclaimer() },
                  }, s.disclaimerBusy ? '提交中…' : '我已阅读并理解，开始使用'),
                  React.createElement('span', { className: 'astk-note', style: { padding: 0 } },
                    '确认后不再弹出；条款有实质修改时会重新提示。'))))
          : null

        // 常驻页脚：即使弹窗因接口失败没能出现，声明也始终可见。
        const footText = d !== null && typeof d.short === 'string' && d.short !== ''
          ? d.short
          : '本工具仅用于研究与学习，不构成投资建议。数据来自第三方，回测不代表未来收益，据此操作风险自负。'
        const foot = React.createElement('div', { className: 'astk-foot' }, '⚠️ ' + footText)

        return React.createElement('div', { className: 'astk-root' },
          head,
          React.createElement('div', { className: 'astk-body' }, side, main),
          foot,
          gate)
      }

      function Icon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 18
        const color = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
        return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
          React.createElement('path', { d: 'M3.5 20.5h17', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' }),
          React.createElement('rect', { x: 6, y: 9, width: 3.6, height: 8, rx: 0.8, fill: color, opacity: 0.9 }),
          React.createElement('path', { d: 'M7.8 6v3M7.8 17v2.5', stroke: color, strokeWidth: 1.3, strokeLinecap: 'round' }),
          React.createElement('rect', { x: 14.4, y: 6.5, width: 3.6, height: 6.5, rx: 0.8, fill: color, opacity: 0.5 }),
          React.createElement('path', { d: 'M16.2 4v2.5M16.2 13v3', stroke: color, strokeWidth: 1.3, strokeLinecap: 'round' }))
      }

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'astock' }, Panel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'astock', order: 60, label: 'A股港股',
      }, Icon))
    }

    return { name: 'astock', inject: ['slots'], apply }
  },
})
