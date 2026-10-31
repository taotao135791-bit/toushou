import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BrowserPage from '../pages/BrowserPage'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useModalBoundary } from './modalBoundary'
import { WidgetBody } from '../pages/boards/WidgetBody'
import AdsCopyModelsSection from '../components/AdsCopyModelsSection'
import type { BoardDataset, BoardWidget } from '@shared/types'

function Nested({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useModalBoundary(ref, true, close)
  return <div ref={ref} role="dialog" tabIndex={-1} id="nested"><button id="nested-close" onClick={close}>nested close</button></div>
}
const columns: BoardDataset['columns'] = [
  {name:'日期',type:'date'}, {name:'币种',type:'text'}, {name:'消耗',type:'number'},
  {name:'展示',type:'number'}, {name:'点击',type:'number'}, {name:'点击率',type:'number'}
]
const mixed: BoardDataset = {id:'mixed',name:'sample',createdAt:0,columns,rows:[['2026-01-01','USD',100,100,100,100],['2026-01-01','EUR',100,900,0,0]]}
const unknown: BoardDataset = {...mixed,id:'unknown',rows:[['2026-01-01','',100,100,100,100]]}
const usd: BoardDataset = {...mixed,id:'usd',rows:[['2026-01-01','USD',100,100,100,100],['2026-01-01','USD',100,900,0,0]]}
const widget = (id:string,type:BoardWidget['type'],datasetId:string,metric:string):BoardWidget => ({id,type,title:id,layout:{x:0,y:0,w:4,h:4},config:{source:'dataset',datasetId,metric,op:'avg',...(type==='chart-line'?{dimension:'日期'}:{})}})
function Fixture() {
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  return <MemoryRouter><button id="opener" onClick={() => setOpen(true)}>open</button><button id="outside">outside</button>
    <div id="tt-mixed"><WidgetBody widget={{id:'tt-mixed',type:'tt-reading',title:'TT',layout:{x:0,y:0,w:4,h:4},config:{advertiserIds:'mixed',range:'1'}}} datasets={[]} boardId="b" onConfigChange={()=>{}} /></div>
    <div id="tt-backup"><WidgetBody widget={{id:'tt-backup',type:'tt-reading',title:'TT',layout:{x:0,y:0,w:4,h:4},config:{advertiserIds:'backup',range:'1'}}} datasets={[]} boardId="b" onConfigChange={()=>{}} /></div>
    <div id="models"><AdsCopyModelsSection /></div>
    <div id="money-unknown"><WidgetBody widget={widget('one','counter','unknown','消耗')} datasets={[unknown]} boardId="b" onConfigChange={()=>{}} /></div>
    <div id="money-chart"><WidgetBody widget={widget('two','chart-line','mixed','消耗')} datasets={[mixed]} boardId="b" onConfigChange={()=>{}} /></div>
    <div id="weighted-ctr"><WidgetBody widget={widget('three','counter','usd','点击率')} datasets={[usd]} boardId="b" onConfigChange={()=>{}} /></div>
    <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 560 }}><BrowserPage embedded initialUrl="https://example.invalid/" /></div>
    <div className="page-enter" style={{position:'absolute',left:260,top:0,width:500,height:768}}>{open && <ConfirmDialog request={{ title: 'confirm fixture', body: 'fixture', onConfirm: () => undefined }} onClose={() => setOpen(false)} />}</div>
    {open && <button id="nested-opener" onClick={() => setNested(true)}>nested opener</button>}
    {nested && <Nested close={() => setNested(false)} />}
  </MemoryRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
