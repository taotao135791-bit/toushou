const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const yaml = require('yaml')
const path = require('node:path')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))

app.whenReady().then(async () => {
  let win
  try {
    const backend = require(path.join(dir, 'backend.cjs'))
    const makeModel = (id, provider = 'vendor') => ({
      id, selector: provider + '/' + id, provider, name: id, input: ['text', 'image'], api: 'openai-completions',
      baseUrl: 'https://' + provider + '.example.test/v1', contextWindow: 262144, maxTokens: 8192, reasoning: false, thinking: []
    })
    const catalog = [
      makeModel('team/photo'), makeModel('old'), makeModel('override'), makeModel('team/photo', 'other'),
      { ...makeModel('gemini-example', 'google'), api: 'google-generative-ai' },
      { ...makeModel('org/model', 'openrouter'), api: 'openrouter' }
    ]
    const deps = { modelsFile: path.join(dir, 'models.yml'), modelCatalog: catalog, runner: null }
    for (const [provider, models] of [
      ['vendor', [{ id: 'old', name: 'Old', input: ['text'], contextWindow: 4096 }]],
      ['relay', [{ id: 'team/photo', name: 'Relay model', input: ['text'], contextWindow: 131072, maxTokens: 512 }, { id: 'blank', name: 'Legacy blank' }]]
    ]) {
      const spec = { id: provider, models, api: 'openai-completions', baseUrl: 'https://' + provider + '.example.test/v1',
        apiKey: 'synthetic-test-value', authNone: false, discovery: false }
      assert((await backend.saveCustomProvider(spec, { ...deps, modelCatalog: [] })).ok)
    }
    const initial = yaml.parse(fs.readFileSync(deps.modelsFile, 'utf8'))
    initial.providers.vendor.models.push({ id: 'override', name: 'Alternate endpoint', api: 'openai-completions',
      baseUrl: 'https://another.example.test/v1', input: ['text'], contextWindow: 17001 })
    fs.writeFileSync(deps.modelsFile, yaml.stringify(initial))
    ipcMain.handle('list', () => backend.listCustomProviders(deps))
    ipcMain.handle('save', (_, spec) => backend.saveCustomProvider(backend.sanitizeCustomProviderSpec(spec), deps))
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `
      const {contextBridge, ipcRenderer} = require('electron');
      contextBridge.exposeInMainWorld('modelSettingsCatalog', ${JSON.stringify(catalog)});
      contextBridge.exposeInMainWorld('electronAPI', {
        listMachineSkills: async () => [],
        customProvidersList: () => ipcRenderer.invoke('list'),
        customProvidersSave: spec => ipcRenderer.invoke('save', spec)
      });
    `)
    fs.writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(dir, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false
    } })
    await win.loadFile(path.join(dir, 'index.html'))
    const js = s => win.webContents.executeJavaScript(s)
    const wait = async s => {
      const deadline = Date.now() + 5000
      while (!await js('Boolean(' + s + ')')) {
        if (Date.now() >= deadline) throw Error('No match for ' + s + '\n' + await js('document.body.innerText'))
        await new Promise(r => setTimeout(r, 25))
      }
    }
    const query = css => 'document.querySelector(' + JSON.stringify(css) + ')'
    const select = label => query('select[aria-label="' + label + '"]')
    const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`
    const choose = (select, value) => js(`(() => {const el=${select}; el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const edit = (element, value) => js(`(() => {
      const el = ${element};
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', {bubbles:true}))
    })()`)
    const values = element => js(`[...${element}.options].map(o => o.value)`)
    const formId = query('input[list="custom-provider-ids"]')
    const defaultModel = select('Default model')
    const preset = select('Add a catalog model')
    const save = button('Save provider')
    const chooseCustom = async provider => {
      await choose(defaultModel, '__custom__')
      await wait(formId + '?.value===' + JSON.stringify(provider))
    }
    const saveAndClose = async () => {
      assert.equal(await js(save + '.disabled'), false)
      await js(save + '.click()')
      await wait('!' + formId)
    }
    await wait(defaultModel + '?.value==="vendor/team/photo"')
    await wait(query('button[title=Edit]'))
    assert.deepEqual(await values(defaultModel), ['', 'vendor/team/photo', 'vendor/old', 'vendor/override', '__custom__'])
    await chooseCustom('vendor')
    await choose(preset, 'team/photo')
    await wait(query('button[aria-label="Remove team/photo"]'))
    assert.equal(await js('Boolean(' + select('Context window for team/photo') + ')'), false)
    assert.equal(await js('Boolean(' + select('Input types for team/photo') + ')'), false)
    assert.equal(await js(select('Input types for override') + '.value'), 'text')
    assert.equal(await js(select('Context window for override') + '.value'), '17001')
    await saveAndClose()
    const stored = id => backend.listCustomProviders(deps).providers.find(p => p.id === id)
    assert.equal(stored('vendor').models.find(m => m.id === 'override').hasCustomTransport, true)
    for (const model of stored('vendor').models.filter(m => m.id !== 'override')) {
      assert.deepEqual(model.input, ['text', 'image'])
      assert.equal(model.contextWindow, 262144)
      assert.equal(model.maxTokens, 8192)
    }
    assert.equal(stored('vendor').hasKey, true)
    const provider = 'document.querySelector("input[aria-label=Provider]").closest("div.flex.items-center").querySelector("select")'
    await choose(provider, 'relay')
    await wait(defaultModel + '.options.length===4')
    assert.deepEqual(await values(defaultModel), ['', 'relay/team/photo', 'relay/blank', '__custom__'])
    await chooseCustom('relay')
    const legacy = select('Context window for team/photo')
    const oldBlank = select('Context window for blank')
    assert.equal(await js(legacy + '.value'), '131072')
    assert.equal(await js(oldBlank + '.value'), '')
    assert.equal(await js(save + '.disabled'), false)
    assert.equal(await js('Boolean(' + preset + ')'), false)
    assert.equal(await js(select('Input types for team/photo') + '.value'), 'text')
    const text = query('textarea')
    await js(`(() => {const el=${text};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,el.value+'\\ncustom/new');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const newContext = select('Context window for custom/new')
    await wait(newContext)
    assert.equal(await js(save + '.disabled'), true)
    assert.deepEqual(await values(newContext), ['', '200000', '256000', '300000', '500000', '1000000'])
    for (const value of ['200000', '256000', '300000', '500000', '1000000']) {
      await choose(newContext, value)
      await wait(newContext + '.value===' + JSON.stringify(value))
      assert.equal(await js(save + '.disabled'), false)
    }
    await choose(select('Input types for custom/new'), 'image')
    await saveAndClose()
    await chooseCustom('relay')
    assert.equal(await js(newContext + '.value'), '1000000')
    assert.equal(await js(legacy + '.value'), '131072')
    assert.equal(await js(oldBlank + '.value'), '')
    assert.equal(await js(select('Input types for custom/new') + '.value'), 'image')
    await choose(legacy, '')
    await saveAndClose()
    const row = stored('relay').models.find(m => m.id === 'team/photo')
    assert.equal(row.contextWindow, undefined)
    assert.equal(row.maxTokens, 512)
    await choose(provider, 'google')
    await wait(defaultModel + '.options[1]?.value==="google/gemini-example"')
    await chooseCustom('google')
    const api = query('select[title="API dialect"]')
    const address = query('input[placeholder="https://api.example.com/v1"]')
    assert.equal(await js(api + '.value'), 'google-generative-ai')
    assert.equal(await js(address + '.value'), 'https://google.example.test/v1')
    assert.equal(await js(`[...document.querySelectorAll('label input[type=checkbox]')].every(el => el.disabled)`), true)
    await edit(text, 'future-gemini')
    await wait(select('Context window for future-gemini'))
    await choose(select('Context window for future-gemini'), '500000')
    await edit(address + '.parentElement.querySelector("input[type=password]")', 'synthetic-gemini-key')
    await edit(address, 'https://google-relay.example.test/v1')
    await wait(save + '.disabled')
    await edit(address, 'https://google.example.test/v1')
    await wait('!' + save + '.disabled')
    await saveAndClose()
    assert.equal(stored('google').api, 'google-generative-ai')
    assert.equal(stored('google').models[0].contextWindow, 500000)

    await choose(provider, 'openrouter')
    await wait(defaultModel + '.options[1]?.value==="openrouter/org/model"')
    await choose(defaultModel, 'openrouter/org/model')
    await chooseCustom('')
    assert.equal(await js(provider + '.value'), 'openrouter')
    assert.equal(await js(defaultModel + '.value'), 'openrouter/org/model')
    assert.equal(await js(address + '.value'), '')
    await edit(formId, 'openrouter ')
    await wait(save + '.disabled')
    assert.equal(stored('openrouter'), undefined)
    await edit(formId, 'my-compatible-endpoint')
    assert.deepEqual(await values(api), ['openai-completions', 'openai-responses', 'anthropic-messages'])
    assert.equal(await js(api + '.value'), 'openai-completions')
    fs.writeFileSync(path.join(dir, 'result.txt'), 'MODEL_SETTINGS_OK')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
