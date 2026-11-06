import { describe, expect, it } from 'vitest'
import type { BoardDataset } from '@shared/types'
import { metricCurrencySafety, safeMetricGroups, safeMetricValue, hasAmbiguousAdvertiserFilter } from './boardMetricSafety'
const dataset = (rows: BoardDataset['rows']): BoardDataset => ({id:'x',name:'TikTok 报表',createdAt:0,columns:[{name:'日期',type:'date'},{name:'广告主',type:'text'},{name:'广告主ID',type:'text'},{name:'币种',type:'text'},{name:'消耗',type:'number'},{name:'展示',type:'number'},{name:'点击',type:'number'},{name:'转化',type:'number'},{name:'点击率',type:'number'},{name:'平均点击成本',type:'number'},{name:'转化成本',type:'number'}],rows})
describe('board safety',()=>{
 it('refuses mixed and unknown money while allowing counts',()=>{const d=dataset([['2026-01-01','A','1','USD',100,100,10,1,10,10,100],['2026-01-01','B','2','EUR',100,900,0,1,0,0,100]]);expect(metricCurrencySafety(d,'消耗')).toBe('mixed');expect(metricCurrencySafety(d,'点击')).toBe('not-money');expect(metricCurrencySafety(dataset([['2026-01-01','A','1','',100,100,10,1,10,10,100]]),'消耗')).toBe('unknown')})
 it('calculates CTR/CPC/CPA from summed denominators',()=>{const d=dataset([['2026-01-01','A','1','USD',100,100,100,2,100,1,50],['2026-01-01','A','1','USD',100,900,0,3,0,0,33.3]]);expect(safeMetricValue(d,d.rows,8,'avg')).toBe(10);expect(safeMetricValue(d,d.rows,9,'avg')).toBe(2);expect(safeMetricValue(d,d.rows,10,'avg')).toBe(40);expect(safeMetricGroups(d,0,8,'avg','其他')?.points).toEqual([10])})
 it('keeps same-named campaigns separate by account and campaign IDs',()=>{const d:BoardDataset={id:'c',name:'TikTok 报表',createdAt:0,columns:[{name:'活动名称',type:'text'},{name:'广告主',type:'text'},{name:'广告主ID',type:'text'},{name:'活动ID',type:'text'},{name:'点击',type:'number'}],rows:[['Same','Account','1','11',10],['Same','Account','2','22',20]]};const groups=safeMetricGroups(d,0,4,'sum','其他');expect(groups?.points).toEqual([20,10]);expect(new Set(groups?.labels).size).toBe(2)})
 it('fails closed on missing ratio denominators and ambiguous advertiser names',()=>{const d=dataset([['2026-01-01','Same','1','USD',10,100,10,1,10,1,10],['2026-01-01','Same','2','USD',10,100,'',1,10,1,10]]);expect(safeMetricValue(d,d.rows,8,'avg')).toBeNull();expect(hasAmbiguousAdvertiserFilter(d,'广告主',['Same'])).toBe(true)})
 it('keeps all chronological dates in a monthly trend instead of peak-day sampling',()=>{
  const d:BoardDataset={id:'monthly',name:'Synthetic',createdAt:0,columns:[{name:'Date',type:'date'},{name:'Count',type:'number'}],rows:Array.from({length:30},(_,i)=>[`2026-04-${String(i+1).padStart(2,'0')}`,i+1])}
  const grouped=safeMetricGroups(d,0,1,'sum','Other')
  expect(grouped?.labels).toHaveLength(30)
  expect(grouped?.labels[0]).toBe('2026-04-01')
  expect(grouped?.labels.at(-1)).toBe('2026-04-30')
  expect(grouped?.labels).not.toContain('Other')
 })
 it('does not add daily unique users and recomputes CPI from spend and installs',()=>{
  const unique:BoardDataset={id:'unique',name:'AF-Synthetic',createdAt:0,columns:[{name:'Unique users',type:'number'}],rows:[[8],[5]]}
  expect(safeMetricValue(unique,unique.rows,0,'sum')).toBeNull()
  expect(safeMetricValue(unique,[unique.rows[0]],0,'sum')).toBe(8)
  const cpi:BoardDataset={id:'cpi',name:'Synthetic',createdAt:0,columns:[{name:'Spend',type:'number'},{name:'Installs',type:'number'},{name:'CPI',type:'number'}],rows:[[20,2,10],[80,20,4]]}
  expect(safeMetricValue(cpi,cpi.rows,2,'avg')).toBeCloseTo(100/22)
 })
})
