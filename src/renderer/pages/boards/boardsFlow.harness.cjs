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
    // Exercise visible-window rendering: hidden Windows windows may not
    // produce compositor frames even with background throttling disabled.
    win = new BrowserWindow({ show: true, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER ' + message))
    await win.loadFile(html)
    const wait = () => new Promise(resolve => setTimeout(resolve, 300))
    await wait()
    const inspect = () => wc.executeJavaScript(`(() => ({today:!![...document.querySelectorAll('h1')].find(e=>e.textContent==="Today's readings"), activeBoard:document.querySelector('[title="Click to open · drag to reorder tabs"].shadow-card span')?.textContent ?? null, toolbar:!!document.querySelector('[title="Add widget"]'), menu:!!document.querySelector('[title="Board menu"]'), ttNotice:document.body.textContent.includes('TikTok Ads is not connected'), noReading:document.body.textContent.includes('No reading modules yet'), connect:[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Connect'), route:document.querySelector('#fixture-route').textContent, saved:window.boardFixture.saved.map(b=>({name:b.name,types:b.widgets.map(w=>w.type),masterScope:b.masterScope,verifiedCards:b.widgets.filter(w=>w.config.requireVerifiedTtScope===true).length}))}))()`)
    const initial = await inspect()
    const initialTodayReads = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.length`)
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
    const returnedTodayReads = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.length`)
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;s.singleResult={ok:false,error:'network'};const e=document.querySelector('[placeholder="Search by name or enter advertiser ID"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'0000000000000002');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    const searchById = await wc.executeJavaScript(`[...document.querySelectorAll('button[role="option"]')].map(e=>e.innerText)`)
    await wc.executeJavaScript(`(() => {const e=document.querySelector('[placeholder="Search by name or enter advertiser ID"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Fixture Shared');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    const searchByName = await wc.executeJavaScript(`[...document.querySelectorAll('button[role="option"]')].map(e=>e.innerText)`)
    await wc.executeJavaScript(`(() => {const e=document.querySelector('[placeholder="Search by name or enter advertiser ID"]');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`)
    await wait()
    const keyboardActive = await wc.executeJavaScript(`(() => {const e=document.querySelector('[placeholder="Search by name or enter advertiser ID"]');const id=e.getAttribute('aria-activedescendant');return !!id && document.getElementById(id)?.innerText.includes('7300000000000000001')})()`)
    await wc.executeJavaScript(`(() => {const e=document.querySelector('[placeholder="Search by name or enter advertiser ID"]');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
    await wait()
    const chosenAccountId = await wc.executeJavaScript(`document.querySelector('[placeholder="Search by name or enter advertiser ID"]').value`)
    const readsBeforeSubmit = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.length`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Read this account').click()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Retry').click()`)
    await wait()
    const singleScopeRetries = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.slice(-2)`)
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()==='Today').click()`)
    await wait()
    const singleDateSwitch = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.at(-1)`)
    await wc.executeJavaScript(`(() => {window.boardFixture.scenario.todayPending=true;[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Inspect all selected accounts').click()})()`)
    await wait()
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const d=n=>{const x=new Date();x.setDate(x.getDate()-n);return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-')};const scopeWindow={start:d(0),end:d(0)},previousWindow={start:d(1),end:d(1)},generatedAt=Date.now();const account={advertiserId:'7300000000000000001',name:'STREAM_A',currency:'USD',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,window:scopeWindow,previousWindow,spend:12,previousSpend:10,impressions:100,clicks:5,conversions:1,campaigns:[]};const partial={account,range:'today',window:scopeWindow,previousWindow,source:'oauth',generatedAt};s.partialCancelResult={range:'today',window:scopeWindow,previousWindow,source:'oauth',generatedAt,truncated:false,accounts:[account,{advertiserId:'7300000000000000002',name:null,currency:null,error:'api',detail:'account-batch-not-attempted'}],cancelled:true,datasetSync:{ok:false,error:'reading-cancelled'}};s.progress?.({requestId:s.todayRequest,completed:1,total:2,succeeded:1,today:partial})})()`)
    await wait()
    const todayProgress = await wc.executeJavaScript(`document.body.innerText.includes('Processed 1 of 2 accounts.')`)
    const todayPartial = await wc.executeJavaScript(`(() => {const card=[...document.querySelectorAll('article')].find(e=>e.textContent.includes('STREAM_A'));return {visible:!!card,spend:card?.innerText.includes('12.00')??false,expired:card?.innerText.includes('no longer match')??false}})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Cancel reading').click()`)
    await wait()
    const todayCancelled = await wc.executeJavaScript(`(() => {const text=document.body.innerText;return {notice:text.includes('Cancelled. Completed accounts are retained'),completed:text.includes('STREAM_A')&&text.includes('12.00'),unread:text.includes('Not read because an earlier request failed')}})()`)
    await wc.executeJavaScript(`window.boardFixture.scenario.todayPending=false;window.boardFixture.scenario.partialCancelResult=null`)
    await wc.executeJavaScript(`(() => {
      const d=(days)=>{const x=new Date();x.setDate(x.getDate()-days);return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-')};
      const accountWindow={start:d(7),end:d(1)}, previousWindow={start:d(14),end:d(8)};
      const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
      const a={advertiserId:'7300000000000000001',name:'PRIVATE_ACCOUNT_A',currency:'USD',timezone,window:accountWindow,previousWindow,spend:5,previousSpend:3,impressions:100,clicks:10,conversions:2,campaigns:[{name:'PRIVATE_CAMPAIGN https://example.test/secret',spend:5,previousSpend:3,delta:2}]};
      const b={advertiserId:'7300000000000000002',name:'PRIVATE_ACCOUNT_B',currency:'EUR',timezone,window:accountWindow,previousWindow,spend:77,previousSpend:70,impressions:200,clicks:20,conversions:3,campaigns:[]};
      const base={range:'last7',window:accountWindow,previousWindow,source:'oauth',generatedAt:Date.now(),truncated:false,datasetSync:{ok:true}};
      const s=window.boardFixture.scenario;s.todayResult={...base,accounts:[a,b]};s.singleResult={...base,accounts:[{...a,spend:15,window:accountWindow,previousWindow}]};
      [...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()==='Last 7 days').click()
    })()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Refresh this account').click()`)
    await wait()
    const singleRefresh = await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const rows=[...document.querySelectorAll('article')];return {input:s.todayInputs.at(-1),a:rows.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_A'))?.innerText,b:rows.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_B'))?.innerText ?? null}})()`)
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;s.goodSingle=s.singleResult;s.singleResult={ok:false,error:'network'}})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Refresh this account').click()`)
    await wait()
    const failedSingle = await wc.executeJavaScript(`(() => {const card=[...document.querySelectorAll('article')].find(e=>e.textContent.includes('PRIVATE_ACCOUNT_A'));return {text:card.innerText,disabled:[...card.querySelectorAll('button')].find(e=>e.textContent.trim()==='Analyze this account')?.disabled}})()`)
    await wc.executeJavaScript(`window.boardFixture.scenario.singleResult=window.boardFixture.scenario.goodSingle`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Refresh this account').click()`)
    await wait()
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.store.getState();s.setComposerPrefill('existing unsent draft');s.setComposerAutosend(true)})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Preview anonymized analysis').click()`)
    await wait()
    const overallDraft = await wc.executeJavaScript(`(() => {const s=window.boardFixture.store.getState();const dialog=document.querySelector('[role=dialog]');return {text:dialog?.querySelector('textarea')?.value,autosend:s.composerAutosend,existingDraft:s.composerPrefill}})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Close').click()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Analyze this account').click()`)
    await wait()
    const singleDraft = await wc.executeJavaScript(`(() => {const s=window.boardFixture.store.getState();const dialog=document.querySelector('[role=dialog]');return {text:dialog?.querySelector('textarea')?.value,autosend:s.composerAutosend,existingDraft:s.composerPrefill}})()`)
    await wc.executeJavaScript(`(() => {const e=document.querySelector('[role=dialog] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,e.value+'\\nuser edit');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Copy draft').click()`)
    await wait()
    const copiedDraft = await wc.executeJavaScript(`window.boardFixture.scenario.clipboard`)
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Close').click()`)
    await wc.executeJavaScript(`(() => {const f=window.boardFixture;const s=f.scenario;s.singlePending=true;s.denySingleCancel=true;const b=s.todayResult;const now=new Date();const day=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');const y=new Date(now);y.setDate(y.getDate()-1);const yesterday=[y.getFullYear(),String(y.getMonth()+1).padStart(2,'0'),String(y.getDate()).padStart(2,'0')].join('-');s.todayAlternateResult={...b,range:'today',window:{start:day,end:day},previousWindow:{start:yesterday,end:yesterday},accounts:b.accounts.map((a,i)=>({...a,spend:i?88:44,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,window:{start:day,end:day},previousWindow:{start:yesterday,end:yesterday}}))};s.singleTodayResult={...s.todayAlternateResult,accounts:[s.todayAlternateResult.accounts[0]]};[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Refresh this account').click()})()`)
    await wait()
    const staleRequest = await wc.executeJavaScript(`window.boardFixture.scenario.todayRequest`)
    await wc.executeJavaScript(`window.boardFixture.scenario.singlePending=false`)
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()==='Today').click()`)
    await wait()
    await wc.executeJavaScript(`window.boardFixture.resolvePending(${JSON.stringify(staleRequest)},window.boardFixture.scenario.goodSingle)`)
    await wait()
    const switchedSingle = await wc.executeJavaScript(`(() => {const rows=[...document.querySelectorAll('article')];return {a:rows.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_A'))?.innerText,b:rows.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_B'))?.innerText ?? null,last:window.boardFixture.scenario.todayInputs.at(-1)}})()`)
    phase = 'custom-date-race'
    // Two successive calendar selections: delay the older request, complete
    // the newer one first, then deliver the stale response out of order.
    await wc.executeJavaScript(`(() => {const d=n=>{const x=new Date();x.setDate(x.getDate()-n);return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-')}; const s=window.boardFixture.scenario; s.firstDates={start:d(10),end:d(8)};s.nextDates={start:d(7),end:d(5)}; s.todayPending=true;s.denySingleCancel=true;const set=(label,v)=>{const e=document.querySelector('input[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}))};set('Start date',s.firstDates.start);set('End date',s.firstDates.end)})()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Apply dates').click()`)
    await wait()
    const firstCustom = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.at(-1)`)
    await wc.executeJavaScript(`(() => {const d=n=>{const x=new Date();x.setDate(x.getDate()-n);return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-')};const s=window.boardFixture.scenario;const base=s.todayResult;const w=s.nextDates;const p={start:d(10),end:d(8)};s.customResult={...base,range:'custom',window:w,previousWindow:p,accounts:base.accounts.map((a,i)=>({...a,window:w,previousWindow:p,spend:i?88:44}))};s.todayPending=false;const set=(label,v)=>{const e=document.querySelector('input[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}))};set('Start date',w.start);set('End date',w.end)})()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Apply dates').click()`)
    await wait()
    const latestCustom = await wc.executeJavaScript(`window.boardFixture.scenario.todayInputs.at(-1)`)
    await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const old={...s.customResult,window:s.firstDates,accounts:s.customResult.accounts.map(a=>({...a,window:s.firstDates,spend:999}))};window.boardFixture.resolvePending(${JSON.stringify(firstCustom.requestId)},old)})()`)
    await wait()
    const customResult = await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const cards=[...document.querySelectorAll('article')];return {first:s.firstDates,next:s.nextDates,a:cards.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_A'))?.innerText,b:cards.find(e=>e.textContent.includes('PRIVATE_ACCOUNT_B'))?.innerText}})()`)

    phase = 'result-filter'
    await wc.executeJavaScript(`(() => {const e=document.querySelector('input[aria-label="Filter inspection results"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'PRIVATE_ACCOUNT_A');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    const resultFilter = await wc.executeJavaScript(`({a:document.body.textContent.includes('PRIVATE_ACCOUNT_A'),b:document.body.textContent.includes('PRIVATE_ACCOUNT_B'),scopeNotice:document.body.textContent.includes('filtering does not change the saved scope')})`)
    await wc.executeJavaScript(`(() => {const e=document.querySelector('input[aria-label="Filter inspection results"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait()
    phase = 'snapshot-save'
    // Snapshot save failure keeps both readings and the open dialog; retry
    // creates and immediately opens one immutable board with an optional chart.
    await wc.executeJavaScript(`window.boardFixture.scenario.snapshotSaveFail=true`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Save as new board').click()`)
    await wait()
    const chartInitially = await wc.executeJavaScript(`document.querySelector('[role=dialog] input[type=checkbox]').checked`)
    await wc.executeJavaScript(`(() => {const dialog=document.querySelector('[role=dialog]');const name=dialog.querySelector('#reading-board-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(name,'Snapshot fixture');name.dispatchEvent(new Event('input',{bubbles:true}));dialog.querySelector('input[type=checkbox]').click()})()`)
    await wait()
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Save and open board').click()`)
    await wait()
    const failedSnapshot = await wc.executeJavaScript(`({error:!!document.querySelector('[role=dialog] [role=alert]'),dialog:!!document.querySelector('[role=dialog]'),a:document.body.textContent.includes('PRIVATE_ACCOUNT_A'),b:document.body.textContent.includes('PRIVATE_ACCOUNT_B'),chart:window.boardFixture.scenario.snapshotInput?.includeChart})`)
    await wc.executeJavaScript(`window.boardFixture.scenario.snapshotSaveFail=false`)
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Save and open board').click()`)
    await wait()
    const savedSnapshot = await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const card=document.querySelector('.reading-snapshot');return {activeBoard:document.querySelector('[title="Click to open · drag to reorder tabs"].shadow-card span')?.textContent ?? null,chart:s.snapshotInput?.includeChart,accountCount:s.snapshotInput?.snapshot.accounts.length,table:!!card?.querySelector('table'),svg:!!card?.querySelector('svg'),groupHeadings:[...(card?.querySelectorAll('h4')??[])].map(e=>e.textContent)}})()`)
    phase = 'snapshot-export'
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Export HTML').click()`)
    await wait()
    const exportedSnapshot = await wc.executeJavaScript(`(() => {const s=window.boardFixture.scenario;const doc=new DOMParser().parseFromString(s.exportedHtml,'text/html');return {anonymized:s.exportInput?.anonymize,table:!!doc.querySelector('table'),svg:!!doc.querySelector('svg'),script:!!doc.querySelector('script'),groups:[...doc.querySelectorAll('.group')].map(e=>({heading:e.querySelector('h3')?.textContent,accounts:[...e.querySelectorAll('li>span:first-child')].map(x=>x.textContent)})),containsPrivate:/PRIVATE_ACCOUNT|730000000000000000/.test(s.exportedHtml)}})()`)
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
      const existingIds = await wc.executeJavaScript(`[...document.querySelectorAll('.react-grid-layout [data-board-widget-id]')].map(e=>e.dataset.boardWidgetId)`)
      await wc.executeJavaScript(`document.querySelector('[title="Add widget"]').click()`)
      await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(name)}).click()`)
      const deadline = Date.now() + 6000
      let state
      do {
        state = await wc.executeJavaScript(`(() => {const grid=document.querySelector('.react-grid-layout');const viewport=grid?.parentElement?.parentElement;const card=[...(grid?.querySelectorAll('[data-board-widget-id]')??[])].find(e=>!${JSON.stringify(existingIds)}.includes(e.dataset.boardWidgetId));const input=card?.querySelector('.widget-config input');const r=card?.getBoundingClientRect();const v=viewport?.getBoundingClientRect();const i=input?.getBoundingClientRect();return {scrolled:!!viewport&&viewport.scrollTop>0,cardVisible:!!r&&!!v&&r.top>=v.top-1&&r.top<v.bottom,inputVisible:!!i&&!!v&&i.top>=v.top&&i.top<v.bottom,focused:!!input&&document.activeElement===input,diagnostics:{cardFound:!!card,inputFound:!!input,cardTop:r?.top,viewportTop:v?.top,viewportBottom:v?.bottom,inputTop:i?.top,scrollTop:viewport?.scrollTop,scrollHeight:viewport?.scrollHeight,clientHeight:viewport?.clientHeight,visibility:document.visibilityState}}})()`)
        if (state.scrolled && state.cardVisible && state.inputVisible && state.focused) break
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      const { diagnostics, ...visible } = state
      return { visible, diagnostics }
    }
    const googleCheck = await addWidget('Google reading')
    const ttCheck = await addWidget('TT reading')
    await wc.executeJavaScript(`document.querySelector('[title="Add widget"]').click()`)
    await wc.executeJavaScript(`(() => { [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Google reading').click(); [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Today').click() })()`)
    await wait()
    const switchedAway = await wc.executeJavaScript(`({today:!![...document.querySelectorAll('h1')].find(e=>e.textContent==="Today's readings"), focusedInConfig:!!document.activeElement?.closest('.widget-config')})`)
    console.log('E2E_RESULT '+JSON.stringify({initial,initialTodayReads,created,verified,failedReload,noSuccessfulAccounts,progress,cancelled,unverified,connect,returned,returnedTodayReads,searchById,searchByName,keyboardActive,chosenAccountId,readsBeforeSubmit,singleScopeRetries,singleDateSwitch,todayProgress,todayPartial,todayCancelled,singleRefresh,failedSingle,overallDraft,singleDraft,copiedDraft,switchedSingle,firstCustom,latestCustom,customResult,resultFilter,chartInitially,failedSnapshot,savedSnapshot,exportedSnapshot,blank,composed,googleVisible:googleCheck.visible,googleDiagnostics:googleCheck.diagnostics,ttVisible:ttCheck.visible,ttDiagnostics:ttCheck.diagnostics,switchedAway}))
  } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error),phase})) }
  finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(0) }
}).catch(error => { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})); app.exit(1) })
