// ============================================================================
// 个人提示词效能工作台 · 客户端半区
// ============================================================================
// 手写、零构建。格式照官方模板：
//   window.__ModuleLoader__.load({ id: <包名>, factory(require) { ... return 插件 } })
// 三条硬约束（来自宿主实现）：
//   1. `id` 必须等于包名，否则宿主报 "loaded without registering"；
//   2. factory 只注册、不产生副作用，真正的注册放到 apply(ctx) 里；
//   3. React 从浏览器模块表拿（require('react')），不要另外装一份。
//
// 界面挂三处：
//   conversation.input.right  → 「✨ 优化」按钮
//   conversation.input.dock   → 推荐横幅
//   settings.section          → 「提示词工作台」页（改进清单 / 资产库 / 复盘）
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-conversation-digest',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'pwb'
    const API = '/pwb'

    // —— 文案 ——
    const zh = {
      optimize: '优化',
      optimizing: '优化中…',
      optimizeTitle: '发送前优化',
      applied: '本次补上的约束',
      nothingApplied: '没有需要补的约束，只做了措辞整理。',
      apply: '替换输入框',
      useThis: '用这条',
      usedIssues: '参考了 {n} 条你的历史改进项',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
      failed: '失败',
      recommendPrefix: '你上次做类似任务时补上这条约束后效果更好，要不要带上？',
      insert: '带上',
      ignore: '忽略',
      sectionTitle: '提示词工作台',
      sectionDesc: '把「复盘发现的问题」变成「下次自动补齐的约束」，再沉淀成模板。',
      issues: '改进清单',
      assets: '提示词资产库',
      reviews: '复盘记录',
      emptyIssues: '还没有改进项。先跑一次复盘。',
      emptyAssets: '还没有沉淀的模板。优化被采纳后会自动归档。',
      startReview: '开始复盘',
      reviewing: '复盘中…（会调用模型，几十秒）',
      reviewDone: '复盘完成：新增 {n} 条，合并 {m} 条',
      reviewScope: '共分析 {s} 个会话 / {u} 条你的提问 / {f} 次工具失败',
      forceReview: '强制重跑（会重新分析已看过的会话，更费 token）',
      dismiss: '忽略',
      restore: '恢复',
      active: '生效中',
      dismissed: '已忽略',
      times: '出现 {n} 次',
      copyRewrite: '复制改写草稿',
      settings: '设置',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      cancel: '取消',
      enabled: '启用插件',
      enabledHint: '关掉后不再推荐，但仍可手动优化',
      variants: '生成哪几档',
      variantsHint: '至少保留一档；档位越少越快越省',
      defaultVariant: '默认版本',
      defaultVariantHint: '这一档排在最前并标「推荐」',
      autoRecommend: '输入时自动推荐',
      autoRecommendHint: '边打字边匹配历史模板与该补的约束',
      threshold: '推荐灵敏度',
      thresholdHint: '越小越容易推荐（0–20）',
      windowDays: '复盘回看天数',
      windowDaysHint: '只看最近这么多天的会话（1–365）',
      maxSessions: '单次复盘会话数',
      maxSessionsHint: '越多越慢越费 token（1–20）',
      includeIssues: '优化时参考哪些改进项',
      includeIssuesHint: 'matched-only = 只带与任务类型匹配的；all-active = 全部生效中',
      clearAll: '清空档案',
      clearConfirm: '确定清空全部改进项与资产？',
      clearYes: '确定清空',
      loadFailed: '读取档案失败',
      noModel: '还没有选择默认模型',
    }
    const en = {
      optimize: 'Optimize',
      optimizing: 'Optimizing…',
      optimizeTitle: 'Pre-send optimization',
      applied: 'Constraints added',
      nothingApplied: 'Nothing to add — only wording was tidied.',
      apply: 'Replace draft',
      useThis: 'Use this',
      usedIssues: 'Drew on {n} of your past findings',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
      failed: 'Failed',
      recommendPrefix: 'Last time a similar task went better after you added this. Want to include it?',
      insert: 'Include',
      ignore: 'Dismiss',
      sectionTitle: 'Prompt workbench',
      sectionDesc: 'Turn review findings into constraints added automatically, then into reusable templates.',
      issues: 'Findings',
      assets: 'Prompt library',
      reviews: 'Reviews',
      emptyIssues: 'No findings yet. Run a review first.',
      emptyAssets: 'No templates yet. Adopted optimizations land here automatically.',
      startReview: 'Run review',
      reviewing: 'Reviewing… (calls the model, may take a while)',
      reviewDone: 'Review done: {n} new, {m} merged',
      reviewScope: '{s} sessions / {u} of your prompts / {f} tool failures',
      forceReview: 'Force re-run (re-analyzes old sessions, costs more tokens)',
      dismiss: 'Dismiss',
      restore: 'Restore',
      active: 'Active',
      dismissed: 'Dismissed',
      times: 'seen {n}×',
      copyRewrite: 'Copy rewrite',
      settings: 'Settings',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      cancel: 'Cancel',
      enabled: 'Enable plugin',
      enabledHint: 'Off disables recommendations; manual optimize still works',
      variants: 'Versions to generate',
      variantsHint: 'Keep at least one; fewer is faster and cheaper',
      defaultVariant: 'Default version',
      defaultVariantHint: 'Shown first and marked recommended',
      autoRecommend: 'Recommend while typing',
      autoRecommendHint: 'Match past templates and missing constraints as you type',
      threshold: 'Recommendation sensitivity',
      thresholdHint: 'Lower means easier to trigger (0–20)',
      windowDays: 'Review lookback (days)',
      windowDaysHint: 'Only sessions from the last N days (1–365)',
      maxSessions: 'Sessions per review',
      maxSessionsHint: 'More is slower and costs more tokens (1–20)',
      includeIssues: 'Findings used by optimize',
      includeIssuesHint: 'matched-only = task-type matches; all-active = every active finding',
      clearAll: 'Clear profile',
      clearConfirm: 'Delete all findings and assets?',
      clearYes: 'Yes, clear',
      loadFailed: 'Failed to load profile',
      noModel: 'No default model selected',
    }

    // —— 样式（跟随宿主主题变量）——
    const CSS = `
.pwb-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;line-height:1.4;cursor:pointer;transition:background .15s,border-color .15s;white-space:nowrap}
.pwb-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pwb-btn:disabled{opacity:.5;cursor:not-allowed}
.pwb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pwb-panel{position:absolute;bottom:calc(100% + 8px);right:0;width:min(560px,86vw);max-height:60vh;overflow:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:14px;z-index:40;font-size:13px;color:var(--dsw-alias-label-primary)}
.pwb-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.pwb-title{font-weight:600;font-size:13px}
.pwb-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.pwb-pre{white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;margin:8px 0;max-height:32vh;overflow:auto;font-size:12.5px;line-height:1.55}
.pwb-chip{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;margin:2px 4px 2px 0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pwb-banner{display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;margin:6px 0;font-size:12.5px}
.pwb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.pwb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.pwb-sev-high{color:var(--dsw-alias-state-error-primary)}
.pwb-sev-medium{color:var(--dsw-alias-state-warn-primary)}
.pwb-sev-low{color:var(--dsw-alias-state-idle-primary)}
.pwb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:6px}
.pwb-wrap{position:relative;display:inline-flex}
`

    // —— HTTP ——
    // timeoutMs：宿主卡住（模型不返回）时不要无限转圈，到点主动放弃并给出提示
    async function call(path, options, timeoutMs = 60000) {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        try { controller.abort() } catch (err) {}
      }, timeoutMs)
      try {
        const response = await fetch(API + path, Object.assign(
          { headers: { 'content-type': 'application/json' }, signal: controller.signal },
          options,
        ))
        let payload = null
        try {
          payload = await response.json()
        } catch (err) {
          throw new Error(`服务返回了非 JSON（HTTP ${response.status}）`)
        }
        if (!response.ok || (payload && payload.ok === false)) {
          throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        }
        return payload
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），宿主可能正忙或模型未返回`)
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeoutMs) => call(path, { method: 'POST', body: JSON.stringify(body || {}) }, timeoutMs)

    // —— ① 发送前优化按钮 ——

    function OptimizeButton(props) {
      const { useInput, inputActions, t } = props
      const readDraft = typeof useInput === 'function' ? useInput : null
      const draft = readDraft ? readDraft((state) => state.draft) : ''
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [copied, setCopied] = useState(-1)
      const wrapRef = useRef(null)

      const run = useCallback(async () => {
        const text = String(draft || '').trim()
        if (!text) return
        setBusy(true)
        setError(null)
        setCopied(-1)
        try {
          const payload = await post('/optimize', { draft: text }, 180000)
          setResult(payload)
          setOpen(true)
        } catch (err) {
          setError(err.message)
          setOpen(true)
        } finally {
          setBusy(false)
        }
      }, [draft])

      const applyOption = useCallback(async (option) => {
        if (!option || !inputActions || typeof inputActions.setDraft !== 'function') return
        inputActions.setDraft(option.text)
        // 采纳即沉淀：这是资产库唯一的自动来源
        try {
          await post('/assets', {
            body: option.text,
            category: result && result.category,
            tags: result && result.tags,
            issueIds: (option.applied || []).map((a) => a.issueId),
            source: 'optimize',
          })
        } catch (err) {
          /* 沉淀失败不应该拦住用户发送 */
        }
        setResult(null)
        setOpen(false)
      }, [result, inputActions])

      const copyOption = useCallback(async (option, index) => {
        if (!option) return
        try {
          await navigator.clipboard.writeText(option.text)
          setCopied(index)
        } catch (err) {
          setError('剪贴板不可用')
        }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const tr = (key, vars) => {
        const dict = t ? t : null
        let text = dict ? dict(key) : null
        if (!text || text === key) text = (props.__zh ? zh : en)[key] || key
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v))
        return text
      }

      return h('span', { className: 'pwb-wrap', ref: wrapRef },
        h('button', {
          type: 'button',
          className: 'pwb-btn',
          title: tr('optimizeTitle'),
          disabled: busy || !String(draft || '').trim(),
          onClick: run,
        }, busy ? tr('optimizing') : '✨ ' + tr('optimize')),
        open ? h('div', { className: 'pwb-panel' },
          h('div', { className: 'pwb-row' },
            h('span', { className: 'pwb-title' }, tr('optimizeTitle')),
            h('button', { type: 'button', className: 'pwb-btn', onClick: () => setOpen(false) }, tr('close')),
          ),
          error ? h('div', { className: 'pwb-err' }, tr('failed') + '：' + error) : null,
          result ? h('div', null,
            // 三个版本并排展示，每个都能单独复制或直接替换输入框
            (result.options && result.options.length ? result.options : [{ label: '标准', text: result.rewritten, applied: result.applied || [] }])
              .map((option, index) => h('div', { key: index, className: 'pwb-card', style: { marginTop: 10 } },
                h('div', { className: 'pwb-row', style: { marginBottom: 6 } },
                  h('span', null,
                    h('span', { className: 'pwb-chip', style: { fontWeight: 600 } }, option.label),
                    h('span', { className: 'pwb-muted' }, String(option.text || '').length + ' 字'),
                  ),
                  h('span', { style: { display: 'flex', gap: 6 } },
                    h('button', { type: 'button', className: 'pwb-btn', onClick: () => copyOption(option, index) },
                      copied === index ? tr('copied') : tr('copy')),
                    h('button', { type: 'button', className: 'pwb-btn pwb-btn-primary', onClick: () => applyOption(option) },
                      tr('useThis')),
                  ),
                ),
                h('div', { className: 'pwb-pre', style: { margin: 0 } }, option.text),
                (option.applied && option.applied.length)
                  ? h('div', { style: { marginTop: 6 } }, option.applied.map((item, i) =>
                      h('span', { key: i, className: 'pwb-chip' }, item.note || item.issueId)))
                  : null,
              )),
            result.category ? h('div', { style: { marginTop: 10 } },
              h('span', { className: 'pwb-chip' }, result.category),
              (result.tags || []).map((tag, index) => h('span', { key: index, className: 'pwb-chip' }, tag))) : null,
            h('div', { className: 'pwb-muted', style: { marginTop: 8 } }, tr('usedIssues', { n: result.usedIssues || 0 })),
          ) : null,
        ) : null,
      )
    }

    // —— ② 推荐横幅 ——

    function RecommendBanner(props) {
      const { useInput, inputActions, t } = props
      const readDraft = typeof useInput === 'function' ? useInput : null
      const draft = readDraft ? readDraft((state) => state.draft) : ''
      const [item, setItem] = useState(null)
      const timer = useRef(null)

      const tr = (key) => {
        const text = t ? t(key) : null
        return text && text !== key ? text : (props.__zh ? zh : en)[key] || key
      }

      useEffect(() => {
        const text = String(draft || '')
        if (text.trim().length < 6) {
          setItem(null)
          return undefined
        }
        // 输入时不要每敲一个字就打一次接口
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(async () => {
          try {
            const payload = await post('/recommend', { draft: text })
            const first = payload.items && payload.items[0]
            setItem(first && first.payload ? first : null)
          } catch (err) {
            setItem(null)
          }
        }, 900)
        return () => {
          if (timer.current) clearTimeout(timer.current)
        }
      }, [draft])

      if (!item) return null

      const insert = () => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return
        const next = String(draft || '').replace(/\s+$/, '') + '\n\n' + item.payload
        inputActions.setDraft(next)
        setItem(null)
      }

      return h('div', { className: 'pwb-banner' },
        h('span', { className: 'pwb-dot' }),
        h('span', { style: { flex: 1 } }, tr('recommendPrefix') + '（' + item.title + '）'),
        h('button', { type: 'button', className: 'pwb-btn', onClick: insert }, tr('insert')),
        h('button', { type: 'button', className: 'pwb-btn', onClick: () => setItem(null) }, tr('ignore')),
      )
    }

    // —— ③ 设置页 ——

    // —— 设置面板 ——

    function SettingsPanel(props) {
      const { settings, tr, onSave, onClear } = props
      const [draft, setDraft] = useState(settings)
      const [state, setState] = useState('idle') // idle | saving | saved
      const [error, setError] = useState(null)
      const [confirmClear, setConfirmClear] = useState(false)

      // 外面刷新了档案就同步回来（比如别处改了设置）
      useEffect(() => {
        setDraft(settings)
      }, [settings])

      const set = (patch) => {
        setDraft((prev) => Object.assign({}, prev, patch))
        setState('idle')
      }

      const toggleVariant = (label) => {
        const list = Array.isArray(draft.optimizeVariants) ? draft.optimizeVariants : []
        const next = list.includes(label) ? list.filter((x) => x !== label) : [...list, label]
        // 至少留一档，否则没有可生成的版本
        if (!next.length) return
        const ordered = ['简洁', '标准', '严谨'].filter((x) => next.includes(x))
        const defaultLabel = ordered.includes(draft.optimizeDefault) ? draft.optimizeDefault : ordered[0]
        set({ optimizeVariants: ordered, optimizeDefault: defaultLabel })
      }

      const save = async () => {
        setState('saving')
        setError(null)
        try {
          await onSave(draft)
          setState('saved')
        } catch (err) {
          setError(err.message)
          setState('idle')
        }
      }

      const row = (label, control, hint) => h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', null,
          h('div', null, label),
          hint ? h('div', { className: 'pwb-muted' }, hint) : null,
        ),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, control),
      )

      const seg = (value, options, onPick) => h('div', { style: { display: 'flex', gap: 4 } },
        options.map((option) => h('button', {
          key: option,
          type: 'button',
          className: option === value ? 'pwb-btn pwb-btn-primary' : 'pwb-btn',
          onClick: () => onPick(option),
        }, option)))

      const numberInput = (value, onChange, min, max) => h('input', {
        type: 'number',
        value,
        min,
        max,
        style: { width: 72, padding: '4px 6px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
        onChange: (event) => onChange(Number(event.target.value)),
      })

      return h('div', null,
        row(tr('enabled'), h('input', {
          type: 'checkbox',
          checked: Boolean(draft.enabled),
          onChange: (event) => set({ enabled: event.target.checked }),
        }), tr('enabledHint')),

        row(tr('variants'), h('div', { style: { display: 'flex', gap: 4 } },
          ['简洁', '标准', '严谨'].map((label) => h('button', {
            key: label,
            type: 'button',
            className: (draft.optimizeVariants || []).includes(label) ? 'pwb-btn pwb-btn-primary' : 'pwb-btn',
            onClick: () => toggleVariant(label),
          }, label))), tr('variantsHint')),

        row(tr('defaultVariant'), seg(draft.optimizeDefault, (draft.optimizeVariants || ['标准']), (label) => set({ optimizeDefault: label })), tr('defaultVariantHint')),

        row(tr('autoRecommend'), h('input', {
          type: 'checkbox',
          checked: Boolean(draft.autoRecommend),
          onChange: (event) => set({ autoRecommend: event.target.checked }),
        }), tr('autoRecommendHint')),

        row(tr('threshold'), numberInput(draft.recommendThreshold, (value) => set({ recommendThreshold: value }), 0, 20), tr('thresholdHint')),

        row(tr('windowDays'), numberInput(draft.reviewWindowDays, (value) => set({ reviewWindowDays: value }), 1, 365), tr('windowDaysHint')),

        row(tr('maxSessions'), numberInput(draft.reviewMaxSessions, (value) => set({ reviewMaxSessions: value }), 1, 20), tr('maxSessionsHint')),

        row(tr('includeIssues'), seg(draft.optimizeIncludeIssues, ['matched-only', 'all-active'], (value) => set({ optimizeIncludeIssues: value })), tr('includeIssuesHint')),

        h('div', { className: 'pwb-row', style: { marginTop: 14, marginBottom: 0 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', className: 'pwb-btn pwb-btn-primary', onClick: save, disabled: state === 'saving' },
              state === 'saving' ? tr('saving') : state === 'saved' ? tr('saved') : tr('save')),
            error ? h('span', { className: 'pwb-err', style: { marginTop: 0 } }, error) : null,
          ),
          confirmClear
            ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { className: 'pwb-muted' }, tr('clearConfirm')),
                h('button', { type: 'button', className: 'pwb-btn', onClick: async () => { await onClear(); setConfirmClear(false) } }, tr('clearYes')),
                h('button', { type: 'button', className: 'pwb-btn', onClick: () => setConfirmClear(false) }, tr('cancel')),
              )
            : h('button', { type: 'button', className: 'pwb-btn', onClick: () => setConfirmClear(true) }, tr('clearAll')),
        ),
      )
    }

    // —— 设置页 ——

    function WorkbenchSection(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [reviewId, setReviewId] = useState(null)
      const [reviewState, setReviewState] = useState(null)
      const [tab, setTab] = useState('issues')
      const [needForce, setNeedForce] = useState(false)

      const tr = (key, vars) => {
        const text = t ? t(key) : null
        let out = text && text !== key ? text : (props.__zh ? zh : en)[key] || key
        if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
        return out
      }

      const load = useCallback(async () => {
        try {
          const payload = await call('/profile')
          setData(payload)
          setError(null)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      // 复盘是异步任务：轮询到结束为止
      useEffect(() => {
        if (!reviewId) return undefined
        let stopped = false
        const poll = async () => {
          try {
            const payload = await call('/review?id=' + encodeURIComponent(reviewId))
            if (stopped) return
            setReviewState(payload.job)
            if (payload.job && payload.job.status !== 'running') {
              setReviewId(null)
              load()
            }
          } catch (err) {
            if (!stopped) setError(err.message)
          }
        }
        const id = setInterval(poll, 1500)
        poll()
        return () => {
          stopped = true
          clearInterval(id)
        }
      }, [reviewId, load])

      const startReview = useCallback(async (force) => {
        setError(null)
        setReviewState(null)
        setNeedForce(false)
        try {
          const payload = await post('/review', force ? { force: true } : {}, 30000)
          setReviewId(payload.reviewId)
        } catch (err) {
          setError(err.message)
          // 增量复盘会在"没有新会话"时拒绝 —— 告知用户可以强制重跑
          if (String(err.message || '').includes('force')) setNeedForce(true)
        }
      }, [])

      const setStatus = useCallback(async (id, status) => {
        try {
          await post('/profile', { action: 'set-issue-status', id, status })
          load()
        } catch (err) {
          setError(err.message)
        }
      }, [load])

      const clearProfile = useCallback(async () => {
        try {
          await post('/profile', { action: 'clear' })
          await load()
        } catch (err) {
          setError(err.message)
        }
      }, [load])

      const saveSettings = useCallback(async (next) => {
        // 失败要抛回给设置面板，让它显示错误并保持未保存状态
        await post('/profile', { action: 'update-settings', settings: next })
        await load()
      }, [load])

      const copy = useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
        } catch (err) {
          setError('剪贴板不可用')
        }
      }, [])

      if (!data) {
        return h('div', { style: { padding: 16, fontSize: 13 } }, error ? tr('loadFailed') + '：' + error : '…')
      }

      const issues = data.issues || []
      const assets = data.assets || []
      const busy = Boolean(reviewId) || Boolean(reviewState && reviewState.status === 'running')

      return h('div', { style: { padding: '16px 18px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        h('div', { className: 'pwb-title', style: { fontSize: 15 } }, tr('sectionTitle')),
        h('div', { className: 'pwb-muted', style: { marginTop: 4 } }, tr('sectionDesc')),

        h('div', { className: 'pwb-row', style: { marginTop: 14 } },
          h('div', null,
            h('span', { className: 'pwb-chip' }, tr('issues') + ' ' + issues.length),
            h('span', { className: 'pwb-chip' }, tr('assets') + ' ' + assets.length),
            h('span', { className: 'pwb-chip' }, tr('reviews') + ' ' + (data.reviews || []).length),
          ),
          h('button', {
            type: 'button',
            className: 'pwb-btn pwb-btn-primary',
            disabled: busy,
            onClick: () => startReview(false),
          }, busy ? tr('reviewing') : tr('startReview')),
        ),

        reviewState && reviewState.status === 'running' ? h('div', { className: 'pwb-muted', style: { marginTop: 8 } }, tr('reviewing')) : null,
        reviewState && reviewState.status === 'failed' ? h('div', { className: 'pwb-err' }, tr('failed') + '：' + reviewState.error) : null,
        reviewState && reviewState.status === 'done' && reviewState.result ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'pwb-muted' }, tr('reviewDone', { n: reviewState.result.added, m: reviewState.result.merged })),
          h('div', { className: 'pwb-muted' }, tr('reviewScope', {
            s: reviewState.result.sessions,
            u: reviewState.result.userMessages,
            f: reviewState.result.toolFailures,
          })),
        ) : null,
        error ? h('div', { className: 'pwb-err' }, error) : null,
        needForce ? h('button', {
          type: 'button',
          className: 'pwb-btn',
          style: { marginTop: 6 },
          onClick: () => startReview(true),
        }, tr('forceReview')) : null,

        h('div', { style: { display: 'flex', gap: 8, marginTop: 14, marginBottom: 10 } },
          h('button', {
            type: 'button',
            className: tab === 'issues' ? 'pwb-btn pwb-btn-primary' : 'pwb-btn',
            onClick: () => setTab('issues'),
          }, tr('issues')),
          h('button', {
            type: 'button',
            className: tab === 'assets' ? 'pwb-btn pwb-btn-primary' : 'pwb-btn',
            onClick: () => setTab('assets'),
          }, tr('assets')),
          h('button', {
            type: 'button',
            className: tab === 'settings' ? 'pwb-btn pwb-btn-primary' : 'pwb-btn',
            onClick: () => setTab('settings'),
          }, tr('settings')),
        ),

        tab === 'settings' ? h(SettingsPanel, {
          settings: data.settings,
          tr,
          onSave: saveSettings,
          onClear: clearProfile,
        }) : tab === 'issues' ? (
          issues.length === 0 ? h('div', { className: 'pwb-muted' }, tr('emptyIssues'))
            : issues.map((issue) => h('div', { key: issue.id, className: 'pwb-card' },
                h('div', { className: 'pwb-row', style: { marginBottom: 4 } },
                  h('span', { className: 'pwb-title' }, issue.title),
                  h('span', { className: 'pwb-muted' },
                    h('span', { className: 'pwb-sev-' + issue.severity }, issue.severity),
                    ' · ' + tr('times', { n: issue.occurrences }),
                    ' · ' + (issue.status === 'active' ? tr('active') : tr('dismissed')),
                  ),
                ),
                issue.detail ? h('div', { className: 'pwb-muted' }, issue.detail) : null,
                issue.rewrite ? h('div', { className: 'pwb-pre' }, issue.rewrite) : null,
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  issue.rewrite ? h('button', { type: 'button', className: 'pwb-btn', onClick: () => copy(issue.rewrite) }, tr('copyRewrite')) : null,
                  h('button', {
                    type: 'button',
                    className: 'pwb-btn',
                    onClick: () => setStatus(issue.id, issue.status === 'active' ? 'dismissed' : 'active'),
                  }, issue.status === 'active' ? tr('dismiss') : tr('restore')),
                ),
                (issue.appliesTo || []).length
                  ? h('div', { style: { marginTop: 6 } }, issue.appliesTo.map((tag, index) => h('span', { key: index, className: 'pwb-chip' }, tag)))
                  : null,
              ))
        ) : (
          assets.length === 0 ? h('div', { className: 'pwb-muted' }, tr('emptyAssets'))
            : assets.map((asset) => h('div', { key: asset.id, className: 'pwb-card' },
                h('div', { className: 'pwb-row', style: { marginBottom: 4 } },
                  h('span', { className: 'pwb-title' }, asset.title),
                  h('span', { className: 'pwb-muted' }, asset.category + ' · ×' + asset.stats.adoptedCount),
                ),
                h('div', { className: 'pwb-pre' }, asset.body),
                h('button', { type: 'button', className: 'pwb-btn', onClick: () => copy(asset.body) }, tr('copy')),
              ))
        ),
      )
    }

    // —— 插件本体 ——

    return {
      name: 'dsh-conversation-digest',
      inject: ['slots', 'locale'],

      apply(ctx) {
        // 任何一处注册失败都不应该拖垮整个客户端半区：
        // 界面少一个按钮是可接受的降级，整页白屏/插件完全消失不是。
        const safe = (label, fn) => {
          try {
            return fn()
          } catch (err) {
            try {
              console.warn('[dsh-conversation-digest] ' + label + ' 注册失败：' + ((err && err.message) || err))
            } catch (inner) {}
            return undefined
          }
        }

        safe('样式', () => {
          ctx.effect(() => {
            if (typeof document === 'undefined' || !document.head) return () => {}
            const style = document.createElement('style')
            style.setAttribute('data-plugin', 'dsh-conversation-digest')
            style.textContent = CSS
            document.head.appendChild(style)
            return () => style.remove()
          })
        })

        safe('语言包', () => ctx.effect(() => ctx.locale.register(NS, { zh, en })))

        // locale 不可用时退化为本地字典，界面仍然是中文
        let t = (key) => key
        safe('locale 绑定', () => {
          t = ctx.locale.bind(NS)
        })

        const withLocale = (props) => Object.assign({ t, __zh: true }, props)

        safe('优化按钮', () => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'pwb-optimize',
          order: 100,
          label: () => t('optimize'),
          locale: NS,
        }, (props) => h(OptimizeButton, withLocale(props)))))

        safe('推荐横幅', () => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'pwb-recommend',
          order: 20,
          locale: NS,
        }, (props) => h(RecommendBanner, withLocale(props)))))

        safe('设置页', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'pwb-settings',
          order: 200,
          label: () => t('sectionTitle'),
          locale: NS,
        }, (props) => h(WorkbenchSection, withLocale(props)))))
      },
    }
  },
})
