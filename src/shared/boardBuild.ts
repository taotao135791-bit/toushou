import type { BoardGenerationCapability, BoardGenerationOptions, BoardGenerationGranularity } from './boardGeneration'
import type { KanbanBoard } from './types'

export interface BoardBuildIntent {
  version: 1
  requestId: string
  revision: number
  mode: 'default' | 'custom' | 'presentation' | 'snapshot'
  options: BoardGenerationOptions
  range?: NonNullable<KanbanBoard['masterScope']>['range']
  fixedValues?: number[]
  measures?: Array<'spend' | 'conversion' | 'revenue'>
  removedWidgetIds?: string[]
  addedUtilityTypes?: Array<'clock' | 'note' | 'todo' | 'link'>
  utilityTypes?: Array<'clock' | 'note' | 'todo' | 'link'>
  requireLiveBindings?: true
  unresolved?: string[]
  evidence: string[]
}

/** Conservative host-side extraction of explicit supported requirements.
 * Input is exclusively the user turn captured before runtime dispatch, never
 * model tool arguments. Free visual briefs are retained by the conversation;
 * they do not impose a fixed layout or a default module list. */
export function freezeBoardBuildIntent(text: string, requestId: string, revision: number, existing?: KanbanBoard): BoardBuildIntent {
  const evidence: string[] = []
  const records = text.slice(0, 32_000)
  // Exclude a whole negated list/clause, then resume at an explicit positive
  // instruction. Looking only at the word immediately before a capability
  // misreads “不要指标卡、趋势、漏斗和分析”.
  const positive = records.replace(/(?:不要|不需要|不用)\s*默认(?:方案|模板)?[，,]?/g, '').replace(/(?:不要|无需|不需要|别加|不做|不含|不能用|不得用|without\b|\bno\b)([^。.;；\n]*)/gi, (_match, tail: string) => {
    const resume = /但|而|只(?:要|做|看)|保留|需要|添加|增加|改成|给我|\bbut\b|\bonly\b/i.exec(tail)
    return resume && resume.index > 0 ? tail.slice(resume.index) : ''
  })
  // A source object's old name is not the requested output mode. Explicit
  // conversion to live data wins over “fixed snapshot” in the same request.
  const liveRepair = /(?:接通|启用|接入|恢复)[^。;；\n]{0,16}(?:刷新|实时|取数)|(?:改成|改为|变成|换成|转换为)[^。;；\n]{0,16}(?:可刷新|实时)|实时取数|\b(?:convert|make|turn)\b[^.;\n]{0,64}\b(?:live|refreshable)\b/i.test(positive)
  const snapshot = !liveRepair && /固定(?:快照|数字|数值|参考|值)|静态(?:快照|报告|报表)|\b(?:fixed|static|manual)\s+snapshot\b|\b(?:make|create|build|save|generate|want|need|only)\b[^.;\n]{0,40}\bsnapshot\b|^\s*(?:a\s+)?snapshot\b/i.test(positive)
  const changing = records.replace(/保留[^，,。;；\n]*日期|日期(?:保持)?不变|不(?:改|调整|更改)日期|keep[^,.;\n]*date[^,.;\n]*unchanged/gi, '')
  const addition = /(?:添加|新增|加(?:个|一个|一张)?|\badd\b|\bappend\b)([^。;；\n]*)/i.exec(positive)?.[1]
  const addedUtilityTypes: NonNullable<BoardBuildIntent['addedUtilityTypes']> = []
  if (existing && addition && !/图表|趋势|漏斗|分析|指标|chart|counter|gauge|reading/i.test(addition)) {
    if (/时钟|\bclock\b/i.test(addition)) addedUtilityTypes.push('clock')
    if (/便签|\bnotes?\b/i.test(addition)) addedUtilityTypes.push('note')
    if (/待办|\btodo\b/i.test(addition)) addedUtilityTypes.push('todo')
    if (/链接|\blink\b/i.test(addition)) addedUtilityTypes.push('link')
  }
  const presentation = !liveRepair && !!existing && (addedUtilityTypes.length > 0 || /样式|布局|颜色|字体|背景|调宽|排版|标题|命名|改名|移除|删掉|删除|style|layout|rename|font|color|background|remove.*(?:widget|module)/i.test(records)) && !/重新?取数|查询|刷新|新数据|日期|昨天|今天|近\s*\d+\s*天|改.*(?:指标|事件|筛选)/i.test(changing)
  const granularities: BoardGenerationGranularity[] = []
  const grains: Array<[BoardGenerationGranularity, RegExp]> = [
    ['creative', /素材(?:级|维度|粒度|明细|日报|报表|\s*ID)|按素材|素材(?:或|\/|和)广告|creative[ -]level|creative\s*id/i],
    ['ad', /(?:广告|ad)(?:级|维度|粒度|明细|\s*ID)|按广告(?!组|系列|主)|ad[ -]level|ad\s*id/i],
    ['adgroup', /广告组(?:级|维度|粒度|明细)|按广告组|ad[ -]?(?:group|set)[ -]level/i],
    ['campaign', /(?:活动|广告系列)(?:级|维度|粒度|明细)|按(?:活动|广告系列)|campaign[ -]level/i],
    ['account', /账户(?:级|维度|粒度|明细)|按账户|account[ -]level/i]
  ]
  for (const [grain, expression] of grains) if (expression.test(positive)) { granularities.push(grain); evidence.push(`grain:${grain}`) }
  const explicit = /风格|布局|颜色|字体|排版|蓝白|深色|暗色|极简|只(?:要|做|看)|仅|自定义|custom|style|layout|dark|\bonly\b|(?:不要|无需|不需要|without|\bno\b).*(?:指标|趋势|漏斗|分析|卡片|表格|chart|funnel|analysis|table)/i.test(records) || granularities.length > 0
  const utility = !liveRepair && /时钟|待办|便签|链接|\bclock\b|\btodo\b|\bnotes?\b|\blink\b/i.test(positive) && !/投放|广告|媒体|数据|指标|业务|趋势|花费|消耗|转化|收入|appsflyer|\bAF\b|\btrend\b/i.test(positive)
  const mode = presentation ? 'presentation' : snapshot ? 'snapshot' : explicit || existing || utility ? 'custom' : 'default'
  const utilityTypes: NonNullable<BoardBuildIntent['utilityTypes']> = []
  if (utility && !existing) {
    if (/时钟|\bclock\b/i.test(positive)) utilityTypes.push('clock')
    if (/便签|\bnotes?\b/i.test(positive)) utilityTypes.push('note')
    if (/待办|\btodo\b/i.test(positive)) utilityTypes.push('todo')
    if (/链接|\blink\b/i.test(positive)) utilityTypes.push('link')
  }
  const required = new Set<BoardGenerationCapability>()
  if (!presentation && !snapshot && !utility) required.add('data')
  const caps: Array<[BoardGenerationCapability, RegExp]> = [['trend', /趋势|trend/i], ['funnel', /漏斗|funnel/i], ['analysis', /分析|highlight|analysis/i], ['third-party', /三方|第三方|appsflyer|\bAF\b/i], ['table', /表格|明细|日报|table/i]]
  if (!presentation) for (const [capability, expression] of caps) if (expression.test(positive)) required.add(capability)
  const daily = !presentation && /日报|daily report/i.test(positive)
  const options: BoardGenerationOptions = {
    mode: mode === 'default' ? 'default' : 'custom', required: [...required],
    ...(daily ? { daily: true } : {}), ...(!presentation && granularities.length ? { granularity: granularities } : {})
  }
  const fields = [...positive.matchAll(/(?:字段|列|columns?)\s*[:：]\s*([^。;；\n]+)/gi)].flatMap(match => match[1].split(/[,，、]/).map(value => value.trim().replace(/^[「“"']|[」”"']$/g, '')).filter(Boolean))
  if (fields.length && fields.length <= 12) options.dimensions = [...new Set(fields)]
  const unresolved = [...(fields.length > 12 ? ['too-many-explicit-dimensions'] : []), ...(text.length > 32_000 ? ['request-too-long'] : [])]
  let removedWidgetIds: string[] | undefined
  if (presentation && existing && /删掉|删除|移除|\bremove\b/i.test(records)) {
    const typeNames: Record<string, string[]> = { clock: ['时钟', 'clock'], note: ['便签', 'note'], todo: ['待办', 'todo'], table: ['表格', 'table'], funnel: ['漏斗', 'funnel'], analysis: ['分析', 'analysis'], counter: ['指标卡', '数字卡', 'counter'], 'chart-line': ['折线图', '趋势图'], 'chart-bar': ['柱状图'] }
    const matches = existing.widgets.filter(widget => records.includes(widget.id) || !!widget.title && records.includes(widget.title) || (typeNames[widget.type] ?? []).some(name => records.toLowerCase().includes(name)))
    if (matches.length === 1) removedWidgetIds = [matches[0].id]
    else unresolved.push('removal-target-unresolved')
  }
  const measures: NonNullable<BoardBuildIntent['measures']> = []
  if (!presentation && !snapshot) {
    if (/花费|消耗|\bspend\b/i.test(positive)) measures.push('spend')
    if (/转化|\bconversions?\b/i.test(positive)) measures.push('conversion')
    if (/收入|\brevenue\b/i.test(positive)) measures.push('revenue')
  }
  const range = utility ? existing?.masterScope?.range : /昨天|昨日|yesterday/i.test(records) ? 'yesterday' : /今天|今日|today/i.test(records) ? 'today' : /近\s*3\s*天/.test(records) ? 'last3' : /近\s*30\s*天/.test(records) ? 'last30' : /近\s*7\s*天|近七天/.test(records) ? 'last7' : existing?.masterScope?.range
  const fixed = snapshot ? /固定(?:数字|数值|参考|值)\s*(?:为|是|[:：])?\s*(\d+(?:\.\d+)?(?:\s*(?:\/|、|和|与|,|，)\s*\d+(?:\.\d+)?)*)/.exec(positive) : null
  const fixedValues = fixed ? fixed[1].match(/\d+(?:\.\d+)?/g)!.map(Number) : undefined
  return { version: 1, requestId, revision, mode, options, ...(liveRepair ? { requireLiveBindings: true } : {}), ...(range ? { range } : {}), ...(fixedValues ? { fixedValues } : {}), ...(measures.length ? { measures } : {}), ...(removedWidgetIds ? { removedWidgetIds } : {}), ...(presentation && addedUtilityTypes.length ? { addedUtilityTypes } : {}), ...(utilityTypes.length ? { utilityTypes } : {}), ...(unresolved.length ? { unresolved } : {}), evidence }
}
