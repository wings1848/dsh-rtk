/**
 * Browser half of dsh-rtk: the row configuration page on the Web Plugins page.
 *
 * Loaded by \`dsh-client-modules\` from package.json \`exports["./client"]\`, so the
 * whole file keeps the module-loader wrapper shape (a factory receiving
 * \`require\`). Only \`react\` is requested; it is a baseline platform module.
 *
 * Two surfaces live here:
 * - the five configuration fields, staged locally and committed through the form
 *   the Plugins page hands a row-config slot;
 * - the Gain panel, which reads `rtk gain` from the host through its exact
 *   fetch route `/api/dsh-rtk/gain` (under the connection's authenticated
 *   `/api` prefix). The host answers from this plugin's *isolated* ledger
 *   database, so the numbers are the savings this plugin produced, not the
 *   user's global rtk ledger.
 */
window.__ModuleLoader__.load({
  id: '@wingsbutterfly/dsh-rtk',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-rtk.settings'
    /** Row-config registration key: package name#row id, as the bundle patch declares it. */
    const ROW_KEY = '@wingsbutterfly/dsh-rtk#rtk'

    /** Simplified Chinese copy. */
    const zh = {
      summary: '命令改写与输出压缩的 5 项设置；底部按工作区与时间展示 rtk 台账收益。',
      title: 'dsh-rtk 设置',
      description: '改写命令并压缩工具输出，减少进入上下文的字符。',
      overridden: '已覆盖',
      resetField: '恢复默认',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      discard: '放弃修改',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      loading: '读取配置中…',
      gainTitle: '收益',
      gainDescription: '这个插件改写过的命令在 rtk 台账里省下的 token。数字读自插件隔离的历史数据库，不含终端的全局台账。',
      gainUnavailable: '当前部署没有可用的台账通道：收益只在 Web 宿主里可读。',
      gainWorkspace: '工作区',
      gainAllWorkspaces: '全部工作区',
      gainRange: '时间范围',
      gainRangeToday: '今日',
      gainRangeWeek: '近 7 天',
      gainRangeMonth: '近 30 天',
      gainRangeAll: '全部',
      gainRefresh: '刷新',
      gainLoading: '读取台账中…',
      gainRate: '节省率',
      gainRateCaption: '原始 token 中被 rtk 省掉的比例，越大越省',
      gainMeterAria: '节省率计量条',
      gainBefore: '原始输出',
      gainAfter: 'rtk 处理后',
      gainSaved: '省下',
      gainCommands: '改写命令',
      gainAvgTime: '平均耗时',
      gainBreakdown: '明细',
      gainViewDaily: '按天',
      gainViewCommand: '按命令',
      gainColDate: '日期',
      gainColSavedDay: '省下',
      gainColCalls: '命令数',
      gainColCommand: '命令',
      gainColBefore: '处理前',
      gainColAfter: '处理后',
      gainColRatio: '省下比例',
      gainTipSavedDay: '当天省下的 token：原始输出减去 rtk 处理后的量',
      gainTipCallsDay: '当天被 rtk 改写并执行的命令条数',
      gainTipBefore: '命令原始输出换算的 token（rtk 处理前）',
      gainTipAfter: 'rtk 处理后实际进入上下文的 token',
      gainTipSaved: '原始输出与处理后之差',
      gainTipRatio: '省下的 token ÷ 原始 token',
      gainTipCalls: '该范围内被改写的命令总条数',
      gainTipAvgTime: '每条改写命令的平均执行耗时',
      gainEmptyCommands: '这个范围还没有按命令的明细。',
      gainDatabase: '数据源',
      gainTokens: 'tokens',
      gainEmpty: '这个范围还没有改写记录。换个工作区或时间范围看看，或者先跑几条命令。',
      gainFailed: '读取 rtk 台账失败：',
      gainRtkMissing: '找不到 rtk，暂时读不到台账。检查「rtk 路径」设置，或在会话里跑 /rtk verify。',
      gainReadOnly: '只读台账，刷新不会改动数据',
      // Flat keys only: the harness locale stores strings, so a nested object is
      // never registered and t() falls back to echoing the key.
      'field.mode.label': '运行模式',
      'field.mode.hint': '决定这个插件怎么动你的命令，默认 rewrite。',
      'field.mode.detail':
        'off 两半功能全关；rewrite 把有 rtk 等价命令的 bash/pwsh 调用换成 rtk 版本再执行；suggest 只在结果里提示等价命令、不改写。检测不到 rtk 时自动退回不改写。',
      'field.compact.label': '输出压缩',
      'field.compact.hint': '压缩工具返回的文本，默认开。',
      'field.compact.detail':
        '开：剥离 ANSI 颜色、摘要命令输出、按字符预算截断；关：只保留命令改写，工具输出原样进入上下文。',
      'field.maxChars.label': '字符预算',
      'field.maxChars.hint': '压缩后文本的字符上限，默认 12000，范围 1000–200000。',
      'field.maxChars.detail':
        '超出部分会被截断，但命令结尾的 [exit code: N] 这类尾部标记会保留。设得太小会丢掉关键错误上下文，一般 8000–20000 够用。',
      'field.readCompaction.label': 'read 压缩',
      'field.readCompaction.hint': '读文件时的压缩强度，默认 none（不压缩）。',
      'field.readCompaction.detail':
        'none 保持精确原文，编辑文件时不会因副本与文件不一致而失配；budget 只按字符预算截断；minimal 还会删掉普通注释；aggressive 只留 import 与签名。后三档都是有损的，需要精确内容时先切回 none。',
      'field.rtkExecutable.label': 'rtk 路径',
      'field.rtkExecutable.hint': 'rtk 可执行文件的名字或绝对路径；留空表示自动探测。',
      'field.rtkExecutable.detail':
        '插件启动时先按 PATH 查找（Windows 还会查 WinGet、cargo、scoop 的常见安装位置），找到就把绝对路径写回这里，找不到就留空；手填的值不会被自动覆盖。改动后探测缓存约 30 秒生效，可用 /rtk verify 立即复查。',
      'modeValues.off': 'off（两半功能全关）',
      'modeValues.rewrite': 'rewrite（改写命令后执行）',
      'modeValues.suggest': 'suggest（只提示，不改写）',
      'readCompactionValues.none': 'none（原文，不压缩）',
      'readCompactionValues.budget': 'budget（只按预算截断）',
      'readCompactionValues.minimal': 'minimal（再删注释）',
      'readCompactionValues.aggressive': 'aggressive（只留 import 与签名）',
    }

    /** English copy. */
    const en = {
      summary: 'Five settings for command rewriting and output compaction, plus savings by workspace and time.',
      title: 'dsh-rtk settings',
      description: 'Rewrite commands and compact tool output before it reaches the model.',
      overridden: 'Overridden',
      resetField: 'Reset to default',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      discard: 'Discard',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      loading: 'Reading configuration…',
      gainTitle: 'Savings',
      gainDescription: 'Tokens that rtk reclaimed for commands this plugin rewrote. Read from the plugin isolated ledger, not the terminal global one.',
      gainUnavailable: 'This deployment has no ledger channel: savings are readable only in a Web host.',
      gainWorkspace: 'Workspace',
      gainAllWorkspaces: 'All workspaces',
      gainRange: 'Time range',
      gainRangeToday: 'Today',
      gainRangeWeek: 'Last 7 days',
      gainRangeMonth: 'Last 30 days',
      gainRangeAll: 'All time',
      gainRefresh: 'Refresh',
      gainLoading: 'Reading the ledger…',
      gainRate: 'Saved',
      gainRateCaption: 'Share of the original tokens rtk kept out of context; higher is better',
      gainMeterAria: 'Savings meter',
      gainBefore: 'Original output',
      gainAfter: 'After rtk',
      gainSaved: 'Saved',
      gainCommands: 'Commands',
      gainAvgTime: 'Avg time',
      gainBreakdown: 'Breakdown',
      gainViewDaily: 'By day',
      gainViewCommand: 'By command',
      gainColDate: 'Date',
      gainColSavedDay: 'Saved',
      gainColCalls: 'Commands',
      gainColCommand: 'Command',
      gainColBefore: 'Before',
      gainColAfter: 'After',
      gainColRatio: 'Saved %',
      gainTipSavedDay: 'Tokens saved that day: original output minus what rtk let through',
      gainTipCallsDay: 'Commands rtk rewrote and ran that day',
      gainTipBefore: 'Tokens in the original command output, before rtk',
      gainTipAfter: 'Tokens that reached the context after rtk',
      gainTipSaved: 'Difference between original output and what came after rtk',
      gainTipRatio: 'Saved tokens divided by original tokens',
      gainTipCalls: 'Commands rewritten in this range',
      gainTipAvgTime: 'Average run time of one rewritten command',
      gainEmptyCommands: 'No per-command rows in this range yet.',
      gainDatabase: 'Source',
      gainTokens: 'tokens',
      gainEmpty: 'No rewrites in this range yet. Try another workspace or range, or run a few commands first.',
      gainFailed: 'Could not read the rtk ledger: ',
      gainRtkMissing: 'rtk is not available, so the ledger cannot be read. Check the rtk executable setting or run /rtk verify.',
      gainReadOnly: 'Read-only ledger; refreshing changes nothing',
      'field.mode.label': 'Mode',
      'field.mode.hint': 'How this plugin touches your commands; defaults to rewrite.',
      'field.mode.detail':
        'off disables both halves; rewrite swaps a supported bash/pwsh call for its rtk equivalent before it runs; suggest only reports the equivalent. Without rtk on the machine it falls back to not rewriting.',
      'field.compact.label': 'Output compaction',
      'field.compact.hint': 'Compact the text a tool returns; on by default.',
      'field.compact.detail':
        'On: strip ANSI colors, summarize command output and truncate to the character budget. Off: command rewriting only, tool output reaches the model verbatim.',
      'field.maxChars.label': 'Character budget',
      'field.maxChars.hint': 'Upper bound for compacted text; default 12000, range 1000–200000.',
      'field.maxChars.detail':
        'Text past the bound is truncated, but trailing markers such as [exit code: N] are preserved. Set it too low and you lose error context; 8000–20000 is usually enough.',
      'field.readCompaction.label': 'Read compaction',
      'field.readCompaction.hint': 'How hard reads are compacted; defaults to none (no compaction).',
      'field.readCompaction.detail':
        'none keeps exact source, so edits never fail because the compacted copy differs from the file; budget only truncates to the budget; minimal also drops ordinary comments; aggressive keeps imports and signatures only. The last three are lossy, so switch back to none when you need exact content.',
      'field.rtkExecutable.label': 'rtk executable',
      'field.rtkExecutable.hint': 'Name or absolute path of the rtk binary; empty means auto-detect.',
      'field.rtkExecutable.detail':
        'On load the plugin looks for rtk on PATH (on Windows it also checks the usual WinGet, cargo and scoop install directories). A found path is written back here; when nothing is found the field stays empty. A hand-typed value is never overwritten. Changes apply after the ~30s probe cache expires, or immediately with /rtk verify.',
      'modeValues.off': 'off (both halves disabled)',
      'modeValues.rewrite': 'rewrite (replace the command)',
      'modeValues.suggest': 'suggest (report only)',
      'readCompactionValues.none': 'none (exact, no compaction)',
      'readCompactionValues.budget': 'budget (truncate only)',
      'readCompactionValues.minimal': 'minimal (also drops comments)',
      'readCompactionValues.aggressive': 'aggressive (imports and signatures only)',
    }

    /** The five fields, in the order the form renders them. */
    const FIELDS = [
      { key: 'mode', kind: 'select', options: ['off', 'rewrite', 'suggest'], values: 'modeValues' },
      { key: 'compact', kind: 'boolean' },
      { key: 'maxChars', kind: 'number', min: 1000, max: 200000 },
      { key: 'readCompaction', kind: 'select', options: ['none', 'budget', 'minimal', 'aggressive'], values: 'readCompactionValues' },
      { key: 'rtkExecutable', kind: 'text' },
    ]

    /** Tabular figures keep the ledger columns from shifting as numbers change. */
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

    /** Time windows the ledger panel offers, in display order. */
    const GAIN_RANGES = [
      { key: 'today', label: 'gainRangeToday' },
      { key: 'week', label: 'gainRangeWeek' },
      { key: 'month', label: 'gainRangeMonth' },
      { key: 'all', label: 'gainRangeAll' },
    ]

    /** Inline styles over host tokens, so the form looks native in both themes. */
    const style = {
      form: { display: 'grid', gap: '14px', maxWidth: '560px' },
      heading: { margin: '0 0 2px', fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      field: { display: 'grid', gap: '4px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' },
      detail: { margin: 0, fontSize: '11.5px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', opacity: 0.9 },
      badge: { fontSize: '11px', padding: '0 5px', borderRadius: 'var(--dsw-radius-xs)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-secondary, inherit)' },
      linkButton: { background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: '11.5px', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, inherit)', textDecoration: 'underline' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: '30px',
        padding: '0 8px',
        font: 'inherit',
        fontSize: '13px',
        color: 'inherit',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      checkbox: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' },
      primary: {
        height: '30px',
        padding: '0 12px',
        font: 'inherit',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary-inverted, inherit)',
        background: 'var(--dsw-alias-state-business-primary)',
        border: '0',
        borderRadius: 'var(--dsw-radius-md)',
        cursor: 'pointer',
      },
      secondary: {
        height: '30px',
        padding: '0 12px',
        font: 'inherit',
        fontSize: '13px',
        color: 'inherit',
        background: 'transparent',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)',
        cursor: 'pointer',
      },
      status: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      gain: {
        marginTop: '4px',
        padding: '14px 16px 12px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-xl)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        display: 'grid',
        gap: '12px',
      },
      gainHead: { display: 'grid', gap: '3px' },
      gainToolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px' },
      gainField: { display: 'grid', gap: '4px', minWidth: '150px', flex: '1 1 180px' },
      gainFieldLabel: {
        fontSize: '10.5px',
        lineHeight: '14px',
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      gainSelect: {
        boxSizing: 'border-box',
        width: '100%',
        height: '30px',
        padding: '0 6px',
        font: 'inherit',
        fontSize: '12px',
        color: 'inherit',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      segmented: {
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      seg: {
        height: '26px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'transparent',
        border: '0',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
      },
      segActive: {
        height: '26px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
        boxShadow: '0 0 0 0.5px var(--dsw-alias-border-l3)',
      },
      gainRefresh: {
        height: '30px',
        padding: '0 12px',
        font: 'inherit',
        fontSize: '12px',
        color: 'inherit',
        background: 'transparent',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)',
        cursor: 'pointer',
      },
      readout: { display: 'flex', alignItems: 'flex-end', gap: '18px', flexWrap: 'wrap' },
      bigBlock: { display: 'flex', alignItems: 'baseline', gap: '2px' },
      bigNumber: {
        fontSize: '38px',
        lineHeight: '1',
        fontWeight: 600,
        fontFamily: MONO,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.02em',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      bigUnit: { fontSize: '18px', lineHeight: '1', fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)' },
      bigLabel: {
        marginLeft: '8px',
        fontSize: '10.5px',
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      meterBlock: { display: 'grid', gap: '4px', flex: '1 1 220px' },
      meter: { display: 'flex', gap: '2px', height: '14px' },
      meterOn: { flex: '1', background: 'var(--dsw-alias-state-business-primary)', borderRadius: 'var(--dsw-radius-xs)' },
      meterOff: { flex: '1', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 'var(--dsw-radius-xs)' },
      meterCaption: { margin: 0, fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)' },
      ledger: { display: 'grid', gap: '6px', paddingTop: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l3)' },
      ledgerRow: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '12.5px', lineHeight: '18px' },
      ledgerLabel: { color: 'var(--dsw-alias-label-secondary, inherit)' },
      ledgerLeader: { flex: '1', borderBottom: '1px dotted var(--dsw-alias-border-l3)', transform: 'translateY(-3px)' },
      ledgerValue: {
        fontFamily: MONO,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      daily: { display: 'grid', gap: '5px', paddingTop: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l3)' },
      dayRow: {
        display: 'grid',
        gridTemplateColumns: '44px 1fr 62px 44px',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11.5px',
        lineHeight: '16px',
      },
      dayDate: { fontFamily: MONO, color: 'var(--dsw-alias-label-tertiary)' },
      dayTrack: { height: '6px', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 'var(--dsw-radius-xs)', overflow: 'hidden' },
      dayFill: {
        display: 'block',
        height: '100%',
        background: 'var(--dsw-alias-state-business-primary)',
        opacity: 0.85,
        borderRadius: 'var(--dsw-radius-xs)',
      },
      dayValue: {
        fontFamily: MONO,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      dayCount: { fontFamily: MONO, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' },
      breakdownHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
      },
      segmentedSmall: {
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      segSmall: {
        height: '22px',
        padding: '0 8px',
        font: 'inherit',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'transparent',
        border: '0',
        borderRadius: 'var(--dsw-radius-xs)',
        cursor: 'pointer',
      },
      segSmallActive: {
        height: '22px',
        padding: '0 8px',
        font: 'inherit',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0',
        borderRadius: 'var(--dsw-radius-xs)',
        cursor: 'pointer',
        boxShadow: '0 0 0 0.5px var(--dsw-alias-border-l3)',
      },
      tableHead: {
        fontSize: '10.5px',
        lineHeight: '14px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },
      tableHeadRight: {
        fontSize: '10.5px',
        lineHeight: '14px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
        textAlign: 'right',
        whiteSpace: 'nowrap',
      },
      dailyHead: {
        display: 'grid',
        gridTemplateColumns: '44px 1fr 62px 44px',
        gap: '8px',
        paddingBottom: '2px',
      },
      commandHead: {
        display: 'grid',
        gridTemplateColumns: '1fr 52px 62px 62px 62px',
        gap: '8px',
        paddingBottom: '2px',
      },
      commandRow: {
        display: 'grid',
        gridTemplateColumns: '1fr 52px 62px 62px 62px',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11.5px',
        lineHeight: '18px',
      },
      commandName: {
        fontFamily: MONO,
        color: 'var(--dsw-alias-label-primary, inherit)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      commandValue: {
        fontFamily: MONO,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      source: {
        margin: 0,
        paddingTop: '10px',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
        fontSize: '11px',
        lineHeight: '15px',
        color: 'var(--dsw-alias-label-tertiary)',
        wordBreak: 'break-all',
      },
      sourceMono: { fontFamily: MONO },
    }

    /** Coerce one snapshot value into the editor's draft shape. */
    function draftOf(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const draft = {}
      for (const field of FIELDS) {
        const raw = source[field.key]
        draft[field.key] = field.kind === 'boolean' ? raw === true : raw === undefined ? '' : String(raw)
      }
      return draft
    }

    /** The value a field submits: parses numbers, keeps text and booleans as-is. */
    function submittedOf(field, draft) {
      if (field.kind === 'boolean') return draft[field.key] === true
      if (field.kind === 'number') {
        const parsed = Number.parseInt(String(draft[field.key]), 10)
        return Number.isFinite(parsed) ? parsed : undefined
      }
      return String(draft[field.key]).trim()
    }

    /** Whether the draft already matches the resolved value for one field. */
    function unchanged(field, draft, value) {
      const next = submittedOf(field, draft)
      if (next === undefined) return false
      const current = value[field.key]
      if (field.kind === 'number') return Number(current) === next
      return current === next
    }

    /**
     * Every invalid field, so Save can stay disabled with a reason.
     *
     * Only numbers are checked here. An empty text value is meaningful: the
     * executable field treats it as "auto-detect", and clearing a detected path
     * has to stay possible. Anything the host schema rejects comes back as a
     * write failure the form reports.
     */
    function invalidFields(draft) {
      const invalid = []
      for (const field of FIELDS) {
        if (field.kind !== 'number') continue
        const parsed = Number.parseInt(String(draft[field.key]), 10)
        if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) invalid.push(field.key)
      }
      return invalid
    }

    /** A zeroed summary, so the readout can render before the first answer. */
    const EMPTY_SUMMARY = {
      commands: 0,
      inputTokens: 0,
      outputTokens: 0,
      savedTokens: 0,
      savingsPercent: 0,
      totalTimeMs: 0,
      avgTimeMs: 0,
    }

    /** Compact token count: 1.2M, 159.0K, 940. */
    function formatCompact(value) {
      const number = Number.isFinite(value) ? Math.max(0, value) : 0
      if (number >= 1e9) return (number / 1e9).toFixed(1) + 'B'
      if (number >= 1e6) return (number / 1e6).toFixed(1) + 'M'
      if (number >= 1e3) return (number / 1e3).toFixed(1) + 'K'
      return String(Math.round(number))
    }

    /** One decimal place, so 67.9 and 100.0 line up in the ledger. */
    function formatPercent(value) {
      const number = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
      return number.toFixed(1)
    }

    /** Filled cells of the twenty-cell measure; one cell is five percent. */
    function meterCells(percent) {
      const bounded = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
      return Math.round(bounded / 5)
    }

    /** Last two path segments, enough to tell workspaces apart in a narrow select. */
    function shortPath(path) {
      const parts = String(path).split(/[\\/]+/).filter((part) => part !== '')
      if (parts.length <= 2) return String(path)
      return '…/' + parts.slice(-2).join('/')
    }

    /** One ledger line: label, dotted leader, monospaced value. */
    function LedgerRow(props) {
      return h(
        'div',
        { style: style.ledgerRow, title: props.tip },
        h('span', { style: style.ledgerLabel }, props.label),
        h('span', { style: style.ledgerLeader }),
        h('span', { style: style.ledgerValue }, props.value),
      )
    }

    /** One right-aligned header cell for the breakdown tables. */
    function HeaderCell(props) {
      return h(
        'span',
        {
          style: props.align === 'right' ? style.tableHeadRight : style.tableHead,
          ...(props.tip === undefined ? {} : { title: props.tip }),
        },
        props.label,
      )
    }

    /** The twenty-cell meter, echoing the meter rtk prints in its own CLI. */
    function GainMeter(props) {
      const filled = meterCells(props.percent)
      const cells = []
      for (let index = 0; index < 20; index += 1) {
        cells.push(h('span', { key: 'cell-' + index, style: index < filled ? style.meterOn : style.meterOff }))
      }
      const label = props.t('gainMeterAria') + ' ' + formatPercent(props.percent) + '%'
      return h('div', { style: style.meter, role: 'img', 'aria-label': label }, cells)
    }

    /** The ready state: headline rate, ledger rows, and the chosen breakdown table. */
    function GainReadout(props) {
      const { t, report, view, onView } = props
      const summary = report.summary === undefined || report.summary === null ? EMPTY_SUMMARY : report.summary
      const daily = Array.isArray(report.daily) ? report.daily : []
      const commands = Array.isArray(report.commands) ? report.commands : []
      const largest = daily.reduce((max, day) => Math.max(max, day.savedTokens), 1)
      const rows = [
        {
          key: 'before',
          label: t('gainBefore'),
          tip: t('gainTipBefore'),
          value: formatCompact(summary.inputTokens) + ' ' + t('gainTokens'),
        },
        {
          key: 'after',
          label: t('gainAfter'),
          tip: t('gainTipAfter'),
          value: formatCompact(summary.outputTokens) + ' ' + t('gainTokens'),
        },
        {
          key: 'saved',
          label: t('gainSaved'),
          tip: t('gainTipSaved'),
          value: formatCompact(summary.savedTokens) + ' ' + t('gainTokens') + '（' + formatPercent(summary.savingsPercent) + '%）',
        },
        { key: 'calls', label: t('gainCommands'), tip: t('gainTipCalls'), value: String(summary.commands) },
        { key: 'time', label: t('gainAvgTime'), tip: t('gainTipAvgTime'), value: summary.avgTimeMs + ' ms' },
      ]

      const dailyHeader = h(
        'div',
        { style: style.dailyHead },
        h(HeaderCell, { label: t('gainColDate') }),
        h('span'),
        h(HeaderCell, { label: t('gainColSavedDay'), align: 'right', tip: t('gainTipSavedDay') }),
        h(HeaderCell, { label: t('gainColCalls'), align: 'right', tip: t('gainTipCallsDay') }),
      )
      const dailyRows = daily.slice(-14).map((day) =>
        h(
          'div',
          { key: day.date, style: style.dayRow, title: day.date },
          h('span', { style: style.dayDate }, String(day.date).slice(5)),
          h(
            'span',
            { style: style.dayTrack },
            h('span', {
              style: {
                ...style.dayFill,
                width: Math.max(2, Math.round((day.savedTokens / largest) * 100)) + '%',
              },
            }),
          ),
          h('span', { style: style.dayValue, title: t('gainTipSavedDay') }, formatCompact(day.savedTokens)),
          h('span', { style: style.dayCount, title: t('gainTipCallsDay') }, String(day.commands)),
        ),
      )

      const commandHeader = h(
        'div',
        { style: style.commandHead },
        h(HeaderCell, { label: t('gainColCommand') }),
        h(HeaderCell, { label: t('gainColCalls'), align: 'right', tip: t('gainTipCalls') }),
        h(HeaderCell, { label: t('gainColBefore'), align: 'right', tip: t('gainTipBefore') }),
        h(HeaderCell, { label: t('gainColAfter'), align: 'right', tip: t('gainTipAfter') }),
        h(HeaderCell, { label: t('gainColRatio'), align: 'right', tip: t('gainTipRatio') }),
      )
      const commandRows = commands.map((entry) =>
        h(
          'div',
          { key: entry.command, style: style.commandRow, title: entry.command },
          h('span', { style: style.commandName }, String(entry.command)),
          h('span', { style: style.commandValue, title: t('gainTipCalls') }, String(entry.calls)),
          h('span', { style: style.commandValue, title: t('gainTipBefore') }, formatCompact(entry.inputTokens)),
          h('span', { style: style.commandValue, title: t('gainTipAfter') }, formatCompact(entry.outputTokens)),
          h('span', { style: style.commandValue, title: t('gainTipRatio') }, formatPercent(entry.savingsPercent) + '%'),
        ),
      )

      const breakdownBody =
        view === 'command'
          ? commands.length === 0
            ? [h('p', { style: style.hint }, t('gainEmptyCommands'))]
            : [commandHeader, ...commandRows]
          : [dailyHeader, ...dailyRows]

      const breakdown = h(
        'div',
        { key: 'breakdown', style: style.daily },
        h(
          'div',
          { style: style.breakdownHead },
          h('p', { style: style.gainFieldLabel }, t('gainBreakdown')),
          h(
            'div',
            { style: style.segmentedSmall, role: 'group', 'aria-label': t('gainBreakdown') },
            h(
              'button',
              {
                type: 'button',
                style: view === 'daily' ? style.segSmallActive : style.segSmall,
                'aria-pressed': view === 'daily',
                onClick: () => onView('daily'),
              },
              t('gainViewDaily'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: view === 'command' ? style.segSmallActive : style.segSmall,
                'aria-pressed': view === 'command',
                onClick: () => onView('command'),
              },
              t('gainViewCommand'),
            ),
          ),
        ),
        ...breakdownBody,
      )

      return [
        h(
          'div',
          { key: 'readout', style: style.readout },
          h(
            'div',
            { style: style.bigBlock },
            h('span', { style: style.bigNumber }, formatPercent(summary.savingsPercent)),
            h('span', { style: style.bigUnit }, '%'),
            h('span', { style: style.bigLabel }, t('gainRate')),
          ),
          h(
            'div',
            { style: style.meterBlock },
            h(GainMeter, { t, percent: summary.savingsPercent }),
            h('p', { style: style.meterCaption }, t('gainRateCaption')),
          ),
        ),
        h(
          'div',
          { key: 'ledger', style: style.ledger },
          rows.map((row) => h(LedgerRow, { key: row.key, label: row.label, tip: row.tip, value: row.value })),
        ),
        breakdown,
      ]
    }

    /**
     * The savings panel.
     *
     * @param props - the dictionary and the RPC reader supplied by `apply`.
     * @returns a ledger panel whose numbers come from this plugin's rtk ledger.
     */
    function GainPanel(props) {
      const { t, reader } = props
      const [state, setState] = React.useState({
        status: reader === undefined ? 'unavailable' : 'loading',
        data: null,
        error: '',
        range: 'week',
        workspace: '',
        reload: 0,
        view: 'daily',
      })
      const { status, data, error, range, workspace, reload, view } = state

      React.useEffect(() => {
        if (reader === undefined) return undefined
        let cancelled = false
        setState((current) => ({ ...current, status: 'loading', error: '' }))
        Promise.resolve(
          reader({
            range,
            ...(workspace === '' ? {} : { workspace }),
            refresh: reload > 0,
          }),
        ).then(
          (result) => {
            if (cancelled) return
            if (result === undefined || result === null || result.ok !== true) {
              const message = result !== null && result !== undefined && result.error !== undefined ? result.error.message : ''
              setState((current) => ({ ...current, status: 'error', error: message, reload: 0 }))
              return
            }
            const report = result.value
            if (report === null || report === undefined || report.available !== true) {
              const reason = report !== null && report !== undefined && report.reason !== undefined ? report.reason : ''
              setState((current) => ({ ...current, status: 'unavailable', data: report, error: reason, reload: 0 }))
              return
            }
            // Consuming the counter keeps "refresh" a single bypass: later
            // range/workspace changes go back to the host's short cache.
            setState((current) => ({ ...current, status: 'ready', data: report, error: '', reload: 0 }))
          },
          (failure) => {
            if (cancelled) return
            setState((current) => ({
              ...current,
              status: 'error',
              error: failure instanceof Error ? failure.message : String(failure),
              reload: 0,
            }))
          },
        )
        return () => {
          cancelled = true
        }
      }, [range, workspace, reload])

      const workspaces = data !== null && Array.isArray(data.workspaces) ? data.workspaces : []
      const busy = status === 'loading'
      const toolbar = [
        h(
          'label',
          { key: 'workspace', style: style.gainField },
          h('span', { style: style.gainFieldLabel }, t('gainWorkspace')),
          h(
            'select',
            {
              style: style.gainSelect,
              value: workspace,
              disabled: reader === undefined,
              onChange: (event) => setState((current) => ({ ...current, workspace: event.target.value })),
            },
            h('option', { value: '' }, t('gainAllWorkspaces')),
            workspaces.map((entry) =>
              h(
                'option',
                { key: entry.path, value: entry.path, title: entry.path },
                typeof entry.title === 'string' && entry.title !== '' ? entry.title : shortPath(entry.path),
              ),
            ),
          ),
        ),
        h(
          'div',
          { key: 'range', style: style.gainField },
          h('span', { style: style.gainFieldLabel }, t('gainRange')),
          h(
            'div',
            { style: style.segmented, role: 'group', 'aria-label': t('gainRange') },
            GAIN_RANGES.map((option) =>
              h(
                'button',
                {
                  key: option.key,
                  type: 'button',
                  style: range === option.key ? style.segActive : style.seg,
                  'aria-pressed': range === option.key,
                  disabled: reader === undefined,
                  onClick: () => setState((current) => ({ ...current, range: option.key })),
                },
                t(option.label),
              ),
            ),
          ),
        ),
        h(
          'button',
          {
            key: 'refresh',
            type: 'button',
            style: style.gainRefresh,
            disabled: reader === undefined || busy,
            onClick: () => setState((current) => ({ ...current, reload: current.reload + 1 })),
          },
          t('gainRefresh'),
        ),
      ]

      const body = []
      if (status === 'loading') body.push(h('p', { key: 'loading', style: style.hint }, t('gainLoading')))
      if (status === 'error') {
        body.push(h('p', { key: 'error', style: style.error }, t('gainFailed') + (error === '' ? '' : error)))
      }
      if (status === 'unavailable' && reader === undefined) {
        body.push(h('p', { key: 'unavailable', style: style.hint }, t('gainUnavailable')))
      }
      if (status === 'unavailable' && reader !== undefined) {
        body.push(h('p', { key: 'missing', style: style.hint }, t('gainRtkMissing')))
        if (error !== '') body.push(h('p', { key: 'reason', style: style.detail }, error))
      }
      if (status === 'ready' && data !== null) {
        const summary = data.summary === undefined || data.summary === null ? EMPTY_SUMMARY : data.summary
        if (summary.commands === 0) body.push(h('p', { key: 'empty', style: style.hint }, t('gainEmpty')))
        else
          body.push(
            ...GainReadout({
              t,
              report: data,
              view,
              onView: (next) => setState((current) => ({ ...current, view: next })),
            }),
          )
      }

      return h(
        'section',
        { 'data-rtk-gain': status, style: style.gain },
        h(
          'div',
          { style: style.gainHead },
          h('h3', { style: style.heading }, t('gainTitle')),
          h('p', { style: style.hint }, t('gainDescription')),
        ),
        h('div', { style: style.gainToolbar }, toolbar),
        ...body,
        data !== null
          ? h(
              'p',
              { style: style.source },
              t('gainDatabase') + ' ',
              h('span', { style: style.sourceMono }, String(data.database)),
              ' · ' + t('gainReadOnly'),
            )
          : null,
      )
    }

    /** One labelled control plus its hint and override affordances. */
    function Field(props) {
      const { t, field, state, disabled, draft, onDraft, onReset, showReset } = props
      const label = t('field.' + field.key + '.label')
      const hint = t('field.' + field.key + '.hint')
      const detail = t('field.' + field.key + '.detail')
      const controlStyle = { ...style.input, ...(disabled ? { opacity: 0.6 } : {}) }
      let control
      if (field.kind === 'select') {
        control = h(
          'select',
          { style: controlStyle, disabled, value: draft[field.key], onChange: (event) => onDraft(field.key, event.target.value) },
          field.options.map((option) => h('option', { key: option, value: option }, t(field.values + '.' + option))),
        )
      } else if (field.kind === 'boolean') {
        control = h('input', {
          type: 'checkbox',
          style: style.checkbox,
          disabled,
          checked: draft[field.key] === true,
          onChange: (event) => onDraft(field.key, event.target.checked),
        })
      } else if (field.kind === 'number') {
        control = h('input', {
          type: 'number',
          min: field.min,
          max: field.max,
          style: controlStyle,
          disabled,
          value: draft[field.key],
          onChange: (event) => onDraft(field.key, event.target.value),
        })
      } else {
        control = h('input', {
          type: 'text',
          style: controlStyle,
          disabled,
          value: draft[field.key],
          onChange: (event) => onDraft(field.key, event.target.value),
        })
      }
      return h(
        'div',
        { style: style.field },
        h(
          'div',
          { style: style.row },
          h('label', { style: style.label }, label),
          state?.user?.[field.key] !== undefined ? h('span', { style: style.badge }, t('overridden')) : null,
          showReset ? h('button', { type: 'button', style: style.linkButton, disabled, onClick: onReset }, t('resetField')) : null,
        ),
        control,
        hint === undefined ? null : h('p', { style: style.hint }, hint),
        detail === undefined ? null : h('p', { style: style.detail }, detail),
      )
    }

    /** The editable configuration section. */
    function ConfigForm(props) {
      const { t, form } = props
      const state = form && form.state ? form.state : {}
      const [draft, setDraft] = React.useState(() => draftOf(state.value))
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        setDraft(draftOf(state.value))
      }, [state.revision])

      const readOnly = state.writable === false
      const busy = saving || readOnly
      const invalid = invalidFields(draft)
      const changedFields = state.value === undefined ? [] : FIELDS.filter((field) => !unchanged(field, draft, state.value))

      function commit(operations) {
        if (operations.length === 0) return
        setSaving(true)
        setMessage('')
        setFailed(false)
        Promise.resolve(form.mutate(operations, state.revision)).then((accepted) => {
          setSaving(false)
          if (accepted === false) {
            setFailed(true)
            setMessage(t('saveFailed'))
            return
          }
          setMessage(t('saved'))
        }, () => {
          setSaving(false)
          setFailed(true)
          setMessage(t('saveFailed'))
        })
      }

      function save() {
        if (invalid.length > 0) return
        const operations = []
        for (const field of changedFields) operations.push({ op: 'set', path: [field.key], value: submittedOf(field, draft) })
        commit(operations)
      }

      function discard() {
        setDraft(draftOf(state.value))
        setMessage('')
        setFailed(false)
      }

      function resetField(key) {
        commit([{ op: 'unset', path: [key] }])
      }

      const fields = FIELDS.map((field) =>
        h(Field, {
          key: field.key,
          t,
          field,
          state,
          disabled: busy,
          draft,
          showReset: state.user?.[field.key] !== undefined,
          onDraft: (key, value) => setDraft((current) => ({ ...current, [key]: value })),
          onReset: () => resetField(field.key),
        }),
      )

      const status = invalid.length > 0 ? t('field.maxChars.hint') : saving ? t('saving') : message

      return h(
        'div',
        { style: style.form, 'data-rtk-config': 'form' },
        state.status === 'loading' ? h('p', { style: style.status }, t('loading')) : null,
        state.status === 'unavailable' ? h('p', { style: style.status }, t('unavailable')) : null,
        readOnly ? h('p', { style: style.status }, t('readOnly')) : null,
        ...fields,
        h(
          'div',
          { style: style.actions },
          h('button', { type: 'button', style: style.primary, disabled: busy || changedFields.length === 0 || invalid.length > 0, onClick: save }, saving ? t('saving') : t('save')),
          h('button', { type: 'button', style: style.secondary, disabled: busy || changedFields.length === 0, onClick: discard }, t('discard')),
          status ? h('p', { style: failed ? style.error : style.status }, status) : null,
        ),
        h(GainPanel, { t, reader: props.gainReader }),
      )
    }

    /** The row-config slot view: a summary line or the full page. */
    function RowConfigView(props) {
      const { t, view, form } = props
      if (view === 'summary') return t('summary')
      if (form === undefined || form === null) return h('p', { style: style.status }, t('unavailable'))
      return h(ConfigForm, { t, form, gainReader: props.gainReader })
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale']

    /**
     * Exact fetch route the host registers under the connection's authenticated
     * `/api` prefix.
     *
     * Deliberately has no leading slash: the host resolves client resources
     * relative to the served document, so a root-absolute path breaks a
     * deployment mounted under a prefix. `fetchGain` anchors it to
     * `document.baseURI` before sending.
     */
    const GAIN_PATH = 'api/dsh-rtk/gain'

    /**
     * Read the ledger through the host's exact fetch route.
     *
     * The route lives under the connection's authenticated `/api` prefix, so the
     * browser's cookie rides along automatically — the panel keeps no token. The
     * URL is resolved against the document, because the host serves the client
     * relative to it and a root-absolute path breaks under a mount prefix.
     *
     * @param payload - range, workspace, and refresh.
     * @param doFetch - transport override, used by tests.
     * @returns the host's `{ ok, value | error }` envelope.
     */
    function fetchGain(payload, doFetch) {
      const send = doFetch ?? (typeof fetch === 'function' ? fetch : undefined)
      if (send === undefined) return Promise.reject(new Error('fetch is unavailable'))
      const target =
        typeof document === 'undefined' || typeof document.baseURI !== 'string'
          ? GAIN_PATH
          : new URL(GAIN_PATH, document.baseURI).href
      return Promise.resolve(
        send(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      ).then((response) => {
        if (response.ok !== true) return Promise.reject(new Error('HTTP ' + response.status))
        return response.json()
      })
    }

    /**
     * Build the reader the Gain panel calls.
     *
     * @returns a payload-to-envelope reader.
     */
    function createReader() {
      return (payload) => fetchGain(payload)
    }

    /**
     * Mount the browser half.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const gainReader = createReader()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-rtk: dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_KEY,
                locale: NS,
                order: 10,
                // The entry-private reader travels through the registration's
                // own inject factory, which is how the slot hands a component
                // data that is not part of the shared props.
                inject: () => ({ gainReader }),
              },
              RowConfigView,
            ),
          ),
        'dsh-rtk: row config',
      )
    }

    exports.NS = NS
    exports.ROW_KEY = ROW_KEY
    // Exposed so the bundle test can pin the flat-dictionary rule: a nested
    // object here is silently dropped by the locale service and the form then
    // renders raw key names.
    exports.dictionaries = { zh, en }
    exports.apply = apply
    exports.inject = inject
    exports.RowConfigView = RowConfigView
    exports.GainPanel = GainPanel
    exports.GainReadout = GainReadout
    exports.createReader = createReader
    exports.fetchGain = fetchGain
    exports.GAIN_PATH = GAIN_PATH
    exports.GAIN_RANGES = GAIN_RANGES
    exports.formatCompact = formatCompact
    exports.formatPercent = formatPercent
    exports.meterCells = meterCells
    exports.shortPath = shortPath
    return module.exports
  },
})