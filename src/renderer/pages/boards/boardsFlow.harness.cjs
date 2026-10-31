const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  let phase = 'start'
  try {
    const html = path.join(dir, 'index.html')
    const gridCss = fs.readFileSync(require.resolve('react-grid-layout/css/styles.css'), 'utf8')
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${gridCss}.react-grid-item{transition:none!important}.widget-config{position:absolute;inset:0;overflow:auto;background:white}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER ' + message))
    await win.loadFile(html)
    const wait = () => new Promise(resolve => setTimeout(resolve, 300))
    await wait()
    const inspect = () => wc.executeJavaScript(`(() => ({today:!![...document.querySelectorAll('h1')].find(e=>e.textContent==="Today's readings"), activeBoard:document.querySelector('[title="Click to open · drag to reorder tabs"].shadow-card span')?.textContent ?? null, toolbar:!!document.querySelector('[title="Add widget"]'), menu:!!document.querySelector('[title="Board menu"]'), ttNotice:document.body.textContent.includes('TikTok Ads is not connected'), noReading:document.body.textContent.includes('No reading modules yet'), connect:[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Connect'), route:document.querySelector('#fixture-route').textContent, saved:window.boardFixture.saved.map(b=>({name:b.name,types:b.widgets.map(w=>w.type),masterScope:b.masterScope,verifiedCards:b.widgets.filter(w=>w.config.requireVerifiedTtScope===true).length}))}))()`)
    const initial = await inspect()
    await wc.executeJavaScript(`document.querySelector('[title="New board"]').click()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='TikTok投放全景').click()`)
    await wait()
    const created = await inspect()
    await wc.executeJavaScript(`(async () => {
      const dateAgo=(days)=>{const d=new Date();d.setDate(d.getDate()-days);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
      window.boardFixture.scenario.datasets=[{id:'tt',name:'TikTok 报表',createdAt:1,columns:[{name:'日期',type:'date'},{name:'广告主ID',type:'text'},{name:'活动ID',type:'text'},{name:'活动名称',type:'text'},{name:'消耗',type:'number'},{name:'点击',type:'number'},{name:'点击率',type:'number'},{name:'转化',type:'number'},{name:'币种',type:'text'}],rows:[[dateAgo(3),'11','101','A',5,1,10,1,'USD'],[dateAgo(30),'11','101','A',100,1,10,1,'USD'],[dateAgo(3),'22','102','B',700,1,10,1,'USD']]}];
      window.boardFixture.scenario.summary={range:'7',startDate:dateAgo(7),endDate:dateAgo(1),source:'oauth',generatedAt:1,transport:'mcp',datasetSync:{ok:true},totals:{spend:5,impressions:10,clicks:1,ctr:.1,conversions:1,costPerConversion:5},topCampaigns:[],advertisers:[{advertiserId:'11',name:'A',currency:'USD'}],failed:[],currency:'USD',mixedCurrency:false};
      const s=window.boardFixture.scenario.summary;s.datasetSync.proofs=await window.boardFixture.buildTikTokDatasetProofs(window.boardFixture.scenario.datasets[0],[{advertiserId:'11',startDate:s.startDate,endDate:s.endDate}]);
      const id=window.boardFixture.saved[0].widgets.find(w=>w.type==='tt-reading').id;window.dispatchEvent(new CustomEvent('tt-reading:board-refresh',{detail:{widgetId:id}}))
    })()`)
    await wait(); await wait()
    const verified = await wc.executeJavaScript(`(() => {const b=window.boardFixture.saved[0];return b.widgets.filter(w=>w.type==='counter').map(w=>document.querySelector('[data-board-widget-id="'+w.id+'"]')?.innerText ?? '')})()`)
    await wc.executeJavaScript(`(() => {const f=window.boardFixture;f.scenario.datasetFail=true;const id=f.saved[0].widgets.find(w=>w.type==='tt-reading').id;window.dispatchEvent(new CustomEvent('tt-reading:board-refresh',{detail:{widgetId:id}}))})()`)
    await wait(); await wait()
    const failedReload = await wc.executeJavaScript(`(() => {const w=window.boardFixture.saved[0].widgets.find(w=>w.type==='counter');return document.querySelector('[data-board-widget-id="'+w.id+'"]')?.innerText ?? ''})()`)
    await wc.executeJavaScript(`window.boardFixture.scenario.datasetFail=false`)
    await wc.executeJavaScript(`(() => {const f=window.boardFixture; f.scenario.goodSummary=f.scenario.summary; f.scenario.summary={...f.scenario.summary,advertisers:[],failed:[{advertiserId:'11',name:'A',currency:null,error:'network'},{advertiserId:'22',name:'B',currency:null,error:'network',detail:'account-batch-not-attempted'}],datasetSync:{ok:false,error:'no-successful-accounts'},totals:{spend:null,impressions:0,clicks:0,ctr:0,conversions:0,costPerConversion:null}};const id=f.saved[0].widgets.find(w=>w.type==='tt-reading').id;window.dispatchEvent(new CustomEvent('tt-reading:board-refresh',{detail:{widgetId:id}}))})()`)
    await wait()
    const noSuccessfulAccounts = await wc.executeJavaScript(`(() => {const w=window.boardFixture.saved[0].widgets.find(w=>w.type==='tt-reading');const card=document.querySelector('[data-board-widget-id="'+w.id+'"]');const metric=[...card.querySelectorAll('div')].find(e=>e.firstElementChild?.textContent==='Impr.');return {value:metric?.lastElementChild?.textContent,failed:card.innerText.includes('2 account(s) could not be read'),unattempted:card.innerText.includes('Not read because an earlier request failed')}})()`)
    await wc.executeJavaScript(`window.boardFixture.scenario.summary=window.boardFixture.scenario.goodSummary`)
    await wc.executeJavaScript(`(() => {const f=window.boardFixture;f.scenario.pending=true;const id=f.saved[0].widgets.find(w=>w.type==='tt-reading').id;window.dispatchEvent(new CustomEvent('tt-reading:board-refresh',{detail:{widgetId:id}}))})()`)
    await wait()
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;s.progress?.({requestId:s.lastRequest,completed:2,total:3,succeeded:2})})()`)
    await wait()
    const progress = await wc.executeJavaScript(`document.body.innerText.includes('Processed 2 of 3 accounts.')`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Cancel reading').click()`)
    await wait()
    const cancelled = await wc.executeJavaScript(`({notice:document.body.innerText.includes('Reading cancelled.'), count:window.boardFixture.scenario.cancelled.length})`)
    await wc.executeJavaScript(`window.boardFixture.scenario.pending=false`)
    await wc.executeJavaScript(`(() => {window.boardFixture.scenario.summary={ok:false,error:'no-credentials'};const id=window.boardFixture.saved[0].widgets.find(w=>w.type==='tt-reading').id;window.dispatchEvent(new CustomEvent('tt-reading:board-refresh',{detail:{widgetId:id}}))})()`)
    await wait()
    const unverified = await wc.executeJavaScript(`(() => {const w=window.boardFixture.saved[0].widgets.find(w=>w.type==='counter');return document.querySelector('[data-board-widget-id="'+w.id+'"]')?.innerText ?? ''})()`)
    phase = 'connect'
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Connect').click()`)
    await wait()
    phase = 'after-connect'
    const connect = await inspect()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Today').click()`)
    await wait()
    phase = 'after-today'
    const returned = await inspect()
    await wc.executeJavaScript(`(() => {window.boardFixture.scenario.todayPending=true;[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()==='Today').click()})()`)
    await wait()
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;s.progress?.({requestId:s.todayRequest,completed:1,total:4,succeeded:1})})()`)
    await wait()
    const todayProgress = await wc.executeJavaScript(`document.body.innerText.includes('Processed 1 of 4 accounts.')`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Cancel reading').click()`)
    await wait()
    const todayCancelled = await wc.executeJavaScript(`document.body.innerText.includes('Reading cancelled.')`)
    await wc.executeJavaScript(`window.boardFixture.scenario.todayPending=false`)
    await wc.executeJavaScript(`document.querySelector('[title="New board"]').click()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Blank board').click()`)
    await wc.executeJavaScript(`(() => { const e=document.querySelector('[placeholder="Board name…"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Blank fixture'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait()
    await wc.executeJavaScript(`document.querySelector('[placeholder="Board name…"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await wait()
    phase = 'after-blank'
    const blank = await inspect()
    await wc.executeJavaScript(`document.querySelector('[title="Describe a board"]').click()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Blank').click()`)
    await wait()
    phase = 'after-compose'
    const composed = await inspect()
    // Use the real grid geometry and a deliberately short scroll viewport.
    await wc.executeJavaScript(`[...document.querySelectorAll('[title="Click to open · drag to reorder tabs"]')].find(e=>e.querySelector('span')?.textContent==='Existing board').click()`)
    await wait()
    await wc.executeJavaScript(`(() => {const grid=document.querySelector('.react-grid-layout');const viewport=grid.parentElement.parentElement; viewport.style.height='230px';viewport.style.overflowY='auto';viewport.scrollTop=0})()`)
    const addWidget = async (name) => {
      await wc.executeJavaScript(`document.querySelector('[title="Add widget"]').click()`)
      await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(name)}).click()`)
      await wait()
      return wc.executeJavaScript(`(() => {const grid=document.querySelector('.react-grid-layout');const viewport=grid.parentElement.parentElement;const board=window.boardFixture.saved.at(-1);const id=board.widgets.at(-1).id;const card=[...grid.querySelectorAll('[data-board-widget-id]')].find(e=>e.dataset.boardWidgetId===id);const input=card?.querySelector('.widget-config input');const r=card?.getBoundingClientRect();const v=viewport.getBoundingClientRect();const i=input?.getBoundingClientRect();return {scrolled:viewport.scrollTop>0,cardVisible:!!r&&r.top>=v.top-1&&r.top<v.bottom,inputVisible:!!i&&i.top>=v.top&&i.top<v.bottom,focused:document.activeElement===input}})()`)
    }
    const googleVisible = await addWidget('Google reading')
    const ttVisible = await addWidget('TT reading')
    await wc.executeJavaScript(`document.querySelector('[title="Add widget"]').click()`)
    await wc.executeJavaScript(`(() => { [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Google reading').click(); [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Today').click() })()`)
    await wait()
    const switchedAway = await wc.executeJavaScript(`({today:!![...document.querySelectorAll('h1')].find(e=>e.textContent==="Today's readings"), focusedInConfig:!!document.activeElement?.closest('.widget-config')})`)
    console.log('E2E_RESULT '+JSON.stringify({initial,created,verified,failedReload,noSuccessfulAccounts,progress,cancelled,unverified,connect,returned,todayProgress,todayCancelled,blank,composed,googleVisible,ttVisible,switchedAway}))
  } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error),phase})) }
  finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(0) }
}).catch(error => { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})); app.exit(1) })
