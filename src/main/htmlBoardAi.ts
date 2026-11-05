import type { ChildProcess, spawn } from 'node:child_process'
import { spawnCommand } from './command'
import { StringDecoder } from 'node:string_decoder'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import YAML from 'yaml'
import path from 'node:path'
import { HTML_BOARD_MAX_CSS, HTML_BOARD_MAX_HTML, HTML_BOARD_ALLOWED_TAGS, HTML_BOARD_ALLOWED_CSS_PROPERTIES, HTML_BOARD_ALLOWED_CSS_FUNCTIONS, parseHtmlBoardTemplate, scopedHtmlBoardCss, validateHtmlBoardDocument, type HtmlBoardDocument, type HtmlBoardTemplate } from '../shared/htmlBoard'
import type { HtmlBoardAiInput, HtmlBoardAiResult } from '../shared/htmlBoardAi'
import { readHtmlBoardDocument } from './htmlBoards'
import { detectCli } from './omp'
import { configGet, configPath, makeExecRunner } from './omp/settings/OmpConfigCli'
import { splitModelSelector } from './omp/settings/modelSelector'
import { validateReadingSnapshot } from '../shared/readingSnapshot'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const validRequest = (value: unknown): value is HtmlBoardAiInput => record(value) && Object.keys(value).every(k => ['id','expectedRevision','instruction','requestId','modelSelector'].includes(k)) && (value.modelSelector === undefined || (typeof value.modelSelector === 'string' && splitModelSelector(value.modelSelector) !== null)) && validId(value.id) && validId(value.requestId) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) > 0 && typeof value.instruction === 'string' && value.instruction.trim().length > 0 && value.instruction.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.instruction)

/** A bounded projection of the chosen saved snapshot; provider errors are excluded. */
export function fullAiSnapshot(raw: unknown) {
  const snapshot = validateReadingSnapshot(raw)
  if (!snapshot) throw new Error('invalid-snapshot')
  const accounts = snapshot.accounts.slice(0,50).map((a, index) => ({
    index:index+1, name:a.name, accountId:a.accountId, platform:a.platform, status:a.status, window:a.window, previousWindow:a.previousWindow,
    sourceAt:a.sourceAt, timezone:a.timezone, currency:a.currency, resultType:a.resultType ?? null,
    metrics: { spend:a.spend, previousSpend:a.previousSpend, impressions:a.impressions, clicks:a.clicks, conversions:a.conversions }
  }))
  return { capturedAt:snapshot.capturedAt, accounts, omittedCount:snapshot.accounts.length-accounts.length }
}

type Owner = number
interface Active { owner: Owner; child?: ChildProcess; cancelled: boolean }
const active = new Map<string, Active>()
export function cancelHtmlBoardAiEdit(requestId: unknown, owner: Owner): boolean {
  if (typeof requestId !== 'string') return false
  const entry = active.get(requestId)
  if (!entry || entry.owner !== owner) return false
  entry.cancelled = true; entry.child?.kill(); return true
}
export function cancelOwnerHtmlBoardAiEdits(owner: Owner): void { for (const [id, entry] of active) if (entry.owner === owner) cancelHtmlBoardAiEdit(id, owner) }

export interface HtmlBoardAiDependencies {
  owner: Owner
  read?: typeof readHtmlBoardDocument
  cli?: typeof detectCli
  spawn?: typeof spawn
  timeoutMs?: number
  defaultModel?: () => Promise<string | null>
  sourceAgent?: string
}
const argsBase = ['--mode', 'json', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--max-time=180', '--thinking=off']
const modelEnv = (home: string): NodeJS.ProcessEnv => {
  const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','LC_CTYPE','OPENAI_API_KEY','DEEPSEEK_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','OPENROUTER_API_KEY','XAI_API_KEY','MISTRAL_API_KEY','GROQ_API_KEY'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home,'appdata'), LOCALAPPDATA: path.join(home,'localappdata'), XDG_CONFIG_HOME: path.join(home,'xdg-config'), XDG_DATA_HOME: path.join(home,'xdg-data'), XDG_CACHE_HOME: path.join(home,'xdg-cache'), XDG_STATE_HOME: path.join(home,'xdg-state'), PI_CODING_AGENT_DIR: path.join(home,'.omp','agent'), TMPDIR: path.join(home,'tmp'), TEMP: path.join(home,'tmp'), TMP: path.join(home,'tmp') })
  return env
}
const safeFile = (file: string) => { try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink() && s.size <= 1_000_000 } catch { return false } }
/** Create a self-contained home, retaining only safe custom model definitions. */
export function prepareIsolatedAiHome(home: string, sourceAgent = path.join(homedir(), '.omp', 'agent'), selector = ''): NodeJS.ProcessEnv {
  const agent = path.join(home,'.omp','agent')
  mkdirSync(agent,{recursive:true,mode:0o700}); mkdirSync(path.join(home,'tmp'),{recursive:true,mode:0o700})
  const readYaml = (name: string): unknown => { const file = path.join(sourceAgent,name); if (!safeFile(file)) return null; try { return YAML.parse(readFileSync(file,'utf8'), { maxAliasCount: 0 }) } catch { return null } }
  if (typeof selector === 'string' && selector.length <= 300 && /^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(selector)) writeFileSync(path.join(agent,'config.yml'),YAML.stringify({modelRoles:{default:selector}}),{mode:0o600,flag:'wx'})
  const models = readYaml('models.yml')
  const providers: Record<string,unknown> = {}
  if (record(models) && record(models.providers)) for (const [id, value] of Object.entries(models.providers).slice(0,100)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id) || !record(value)) continue
    const result: Record<string,unknown> = {}
    if (typeof value.apiKey === 'string' && value.apiKey.length <= 4096 && /^[A-Za-z0-9_./+=-]+$/.test(value.apiKey)) result.apiKey = value.apiKey
    if (value.auth === 'none') result.auth = 'none'
    if (typeof value.baseUrl === 'string' && value.baseUrl.length <= 1000 && /^(?:https:\/\/[^\s/?#]+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)(?:[/?#][^\s]*)?$/.test(value.baseUrl)) result.baseUrl = value.baseUrl
    if (typeof value.api === 'string' && ['openai-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(value.api)) result.api = value.api
    if (Array.isArray(value.models)) result.models = value.models.slice(0,100).flatMap((model: unknown) => {
      if (!record(model) || typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,299}$/.test(model.id)) return []
      const filtered: Record<string,unknown> = {id:model.id}
      if (typeof model.name === 'string' && model.name.length <= 300 && !/[\x00-\x1f\x7f]/.test(model.name)) filtered.name = model.name
      if (typeof model.reasoning === 'boolean') filtered.reasoning = model.reasoning
      if (Array.isArray(model.input) && model.input.every((v:unknown) => v === 'text' || v === 'image')) filtered.input = model.input
      for (const key of ['contextWindow','maxTokens']) if (Number.isSafeInteger(model[key]) && (model[key] as number) > 0 && (model[key] as number) <= 10_000_000) filtered[key] = model[key]
      return [filtered]
    })
    if (Object.keys(result).length) providers[id] = result
  }
  if (Object.keys(providers).length) writeFileSync(path.join(agent,'models.yml'),YAML.stringify({providers}),{mode:0o600,flag:'wx'})
  return modelEnv(home)
}

type AiValidationCode = 'invalid-json' | 'invalid-format' | 'invalid-html' | 'html-limit' | 'unsupported-html' | 'invalid-slot' | 'invalid-chart' | 'invalid-chart-motion' | 'invalid-binding' | 'unsupported-attribute' | 'invalid-css' | 'css-limit' | 'unsupported-css' | 'unsupported-selector' | 'unsupported-css-value' | 'unsupported-css-function' | 'css-value-limit' | 'invalid-document'
const validationCodes = new Set<AiValidationCode>(['invalid-json','invalid-format','invalid-html','html-limit','unsupported-html','invalid-slot','invalid-chart','invalid-chart-motion','invalid-binding','unsupported-attribute','invalid-css','css-limit','unsupported-css','unsupported-selector','unsupported-css-value','unsupported-css-function','css-value-limit','invalid-document'])
/** Log only fixed local classifications, never provider content or source data. */
function logAiValidation(stage: 'json'|'html'|'css'|'document', code: AiValidationCode): void { console.warn('[html-board-ai]', stage, code) }
type AiStreamCode = 'frame-limit' | 'stream-limit' | 'invalid-ndjson' | 'invalid-message' | 'response-limit' | 'missing-assistant'
function logAiStream(code: AiStreamCode): void { console.warn('[html-board-ai]', 'stream', code) }
function validatorCode(error: unknown, fallback: AiValidationCode): AiValidationCode {
  const value = error instanceof Error ? error.message : ''
  return validationCodes.has(value as AiValidationCode) ? value as AiValidationCode : fallback
}
function validateAiProposal(response: string, document: HtmlBoardDocument):
  | { ok:true; html:string; css:string; theme:HtmlBoardTemplate }
  | { ok:false; stage:'json'|'html'|'css'|'document'; code:AiValidationCode } {
  const trimmed = response.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  let json: unknown
  try { json = JSON.parse(fenced ? fenced[1] : trimmed) } catch { return {ok:false,stage:'json',code:'invalid-json'} }
  if (!record(json) || typeof json.html !== 'string' || json.html.length > HTML_BOARD_MAX_HTML || typeof json.css !== 'string' || json.css.length > HTML_BOARD_MAX_CSS) return {ok:false,stage:'json',code:'invalid-format'}
  const theme: HtmlBoardTemplate = json.theme === 'editorial' || json.theme === 'operations' || json.theme === 'minimal' ? json.theme : document.theme ?? 'editorial'
  try { parseHtmlBoardTemplate(json.html, document.snapshot.accounts.length) } catch (error) { return {ok:false,stage:'html',code:validatorCode(error,'invalid-html')} }
  try { scopedHtmlBoardCss(json.css) } catch (error) { return {ok:false,stage:'css',code:validatorCode(error,'invalid-css')} }
  if (!validateHtmlBoardDocument({ ...document, html:json.html, css:json.css, theme })) return {ok:false,stage:'document',code:'invalid-document'}
  return {ok:true,html:json.html,css:json.css,theme}
}

/** Produce a review-only proposal; no save or ad access occurs here. */
export async function requestHtmlBoardAiEdit(raw: unknown, deps: HtmlBoardAiDependencies): Promise<HtmlBoardAiResult> {
  if (!validRequest(raw) || !Number.isSafeInteger(deps.owner) || deps.owner < 0) return { ok: false, error: 'invalid-input' }
  if (active.has(raw.requestId) || active.size >= 3 || [...active.values()].some(entry => entry.owner === deps.owner)) return { ok: false, error: 'busy' }
  const entry: Active = { owner: deps.owner, cancelled: false }; active.set(raw.requestId, entry)
  let directory: string | undefined
  const deadline = Date.now() + (deps.timeoutMs ?? 185_000)
  try {
    const read = deps.read ?? readHtmlBoardDocument
    const before = read(raw.id)
    if (!before.ok) return { ok: false, error: before.error === 'not-found' ? 'not-found' : before.error === 'invalid-input' ? 'invalid-input' : 'store-unreadable' }
    if (before.document.revision !== raw.expectedRevision) return { ok: false, error: 'conflict' }
    const layout = { html: before.document.html, css: before.document.css, theme: before.document.theme ?? 'editorial' }
    const summary = fullAiSnapshot(before.document.snapshot)
    const sensitive = (value: string) => /(?:\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\b(?:authorization|cookie|set-cookie|api[_-]?key)\s*[:=]\s*[^\s,;]{8,})/i.test(value)
    if (sensitive(JSON.stringify({ instruction:raw.instruction, layout, summary }))) return {ok:false,error:'sensitive-content'}
    const cli = (deps.cli ?? detectCli)()
    if (!cli.available || cli.command !== 'omp') return { ok: false, error: 'unavailable' }
    directory = mkdtempSync(path.join(tmpdir(), 'toushou-board-ai-'))
    const runner = makeExecRunner(cli.path ?? cli.command)
    const selector = raw.modelSelector ?? await (deps.defaultModel ?? (async () => { const entry = await configGet(runner, 'modelRoles'); if (!entry) return null; return record(entry.value) && typeof entry.value.default === 'string' ? entry.value.default : '' }))()
    if (entry.cancelled) return { ok:false, error:'cancelled' }
    if (selector === null) return { ok:false, error:'unavailable' }
    const sourceAgent = deps.sourceAgent ?? await configPath(runner)
    if (entry.cancelled) return { ok:false, error:'cancelled' }
    if (!sourceAgent) return { ok:false, error:'unavailable' }
    const isolatedHome = path.join(directory, 'home')
    const env = prepareIsolatedAiHome(isolatedHome, sourceAgent, selector)
    const prompt = `You edit a static HTML report for an advertising optimizer. Return ONLY JSON with exactly html, css and theme; theme must be editorial, operations or minimal. Keep the output compact: html below 4000 characters and css below 2000 characters, with no explanations or Markdown fences. Encode html and css as JSON strings, escaping newlines; do not put literal line breaks inside quoted strings. A few concise KPI cards are sufficient. Preserve data-reading-slot as a single empty top-level div. Never add scripts, links, remote resources or hidden data. HTML allowed tags: ${HTML_BOARD_ALLOWED_TAGS.join(', ')}. Only class, title, aria-label, colspan and rowspan attributes are permitted on ordinary elements; class names may contain letters, digits, underscores, hyphens and spaces. Do not use inline style attributes. Use plain CSS rules, no at-rules, pseudo classes/elements, IDs, attribute selectors, quoted values, escapes or !important. Selectors may contain only letters, digits, underscores, periods, asterisks, hyphens, spaces, > and commas separating selectors. Allowed CSS properties: ${HTML_BOARD_ALLOWED_CSS_PROPERTIES.join(', ')}. Values may contain only letters, digits, #, periods, commas, percent, parentheses, spaces, plus, hyphen and slash. Allowed functions: ${HTML_BOARD_ALLOWED_CSS_FUNCTIONS.join(', ')}. No negative numbers; each numeric value must be at most 10000. Avoid box-shadow, overflow, position, transform, animation and quoted font names. Example: .card { background: #fff; color: #253047; padding: 16px; border-radius: 8px; } Follow the user instruction, including requested edits to existing text. Use the saved snapshot data below to identify the correct account by name and ID, while treating missing values as unknown and avoiding invented claims or causal explanations.
Instruction: ${raw.instruction}
Saved snapshot (only selected first 50 accounts; omittedCount indicates accounts not sent): ${JSON.stringify(summary)}
For values use empty <span data-reading-value="1.spend"></span>, where 1 is a 1-based index and field is spend, previousSpend, impressions, clicks, conversions, resultType, currency, status, account, accountName, accountId, platform, windowStart, or windowEnd. You may add class but no other attributes. The account field renders name and ID together; accountName renders the name, and accountId renders the ID. In anonymous exports accountId is withheld and accountName becomes an account number. Use bindings for account metric values and dates rather than copying numbers into custom text. Custom text is a suggestion that the user reviews. ${before.document.mode === 'module' ? 'This is ONE independent dashboard module, viewed around 300–600 pixels wide. Edit only its chosen metric, chart or note; do not expand it into a full report. The source slot becomes a small immutable provenance footer. Keep text and padding concise and use responsive widths.' : 'Render KPI cards around the full-report slot.'} For snapshot-backed charts use empty <div data-reading-chart="spend-bar"></div>, spend-pie, or spend-donut, at most two charts total. Only chart slots may optionally add data-reading-motion="animate" for a fixed entrance animation; no other attributes. Charts have built-in expandable data notes and render saved values grouped by platform, currency, dates and timezone. Animation does not refresh data. Daily time series are unavailable: never invent a trend line; explain that daily data is needed. Do not draw charts from hard-coded numbers. Use only indexes present above; failed and unavailable accounts have no metrics. Result definitions can differ: do not aggregate or compare conversions without evidence.
Current layout: ${JSON.stringify(layout)}`
    let candidatePrompt = prompt
    for (let attempt = 0; attempt < 2; attempt++) {
      if (entry.cancelled) return {ok:false,error:'cancelled'}
      const remaining = deadline - Date.now()
      if (remaining <= 0) return {ok:false,error:'timeout'}
      writeFileSync(path.join(directory, 'prompt.md'), candidatePrompt, { encoding: 'utf8', mode: 0o600 })
      const result = await new Promise<{ response?: string; error?: 'cancelled'|'timeout'|'failed'|'invalid-output' }>(resolve => {
        let done = false, pending = '', response = '', size = 0
        const decoder = new StringDecoder('utf8')
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: { response?:string; error?: 'cancelled'|'timeout'|'failed'|'invalid-output' }) => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
        let child: ChildProcess
        try { child = (deps.spawn ?? spawnCommand)(cli.path ?? cli.command, [...argsBase, ...(raw.modelSelector ? ['--model',raw.modelSelector] : []), '@prompt.md'], { cwd: directory, env, stdio: ['ignore','pipe','pipe'], windowsHide: true }) } catch { finish({error:'failed'}); return }
        entry.child = child
        if (entry.cancelled) child.kill()
        timer = setTimeout(() => { finish({error:'timeout'}); child.kill() }, remaining)
        let streamIssue: AiStreamCode = 'invalid-ndjson'
        const failOutput = (issue: AiStreamCode) => { logAiStream(issue); finish({error:'invalid-output'}); child.kill() }
        const consume = (line: string): boolean => {
          if (!line.trim()) return true
          if (line.length > 256_000) { streamIssue = 'frame-limit'; return false }
          let event: unknown
          try { event = JSON.parse(line) } catch { streamIssue = 'invalid-ndjson'; return false }
          if (!record(event) || event.type !== 'message_end' || !record(event.message) || event.message.role !== 'assistant') return true
          if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') { finish({error:'failed'}); child.kill(); return true }
          if (!Array.isArray(event.message.content)) { streamIssue = 'invalid-message'; return false }
          response = event.message.content.filter((part: unknown) => record(part) && part.type === 'text' && typeof part.text === 'string').map((part: {text:string}) => part.text).join('')
          if (response.length > 200_000) { streamIssue = 'response-limit'; return false }
          return true
        }
        const append = (text: string): boolean => {
          pending += text
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0,newline); pending = pending.slice(newline+1)
            if (!consume(line)) return false
            if (done) return true
          }
          if (pending.length > 256_000) { streamIssue = 'frame-limit'; return false }
          return true
        }
        child.stdout?.on('data', (chunk: Buffer) => {
          if (done) return
          size += chunk.length
          // Streaming events may be numerous; bound their total without retaining them.
          if (size > 32_000_000) { failOutput('stream-limit'); return }
          if (!append(decoder.write(chunk))) failOutput(streamIssue)
        })
        child.stderr?.on('data', () => { /* never log provider or prompt contents */ })
        child.on('error', () => finish({error: entry.cancelled ? 'cancelled' : 'failed'}))
        child.on('close', code => {
          if (done) return
          if (entry.cancelled) { finish({error:'cancelled'}); return }
          if (code !== 0) { finish({error:'failed'}); return }
          if (!append(decoder.end()) || (pending && !consume(pending))) { logAiStream(streamIssue); finish({error:'invalid-output'}); return }
          if (!response) { logAiStream('missing-assistant'); finish({error:'invalid-output'}); return }
          finish({response})
        })
      })
      if (result.error) return {ok:false,error:result.error}
      if (entry.cancelled) return {ok:false,error:'cancelled'}
      const response = result.response ?? ''
      const proposal = validateAiProposal(response, before.document)
      if (proposal.ok) {
        const after = read(raw.id)
        if (!after.ok) return {ok:false,error:after.error === 'not-found' ? 'not-found' : 'store-unreadable'}
        if (after.document.revision !== raw.expectedRevision) return {ok:false,error:'conflict'}
        if (entry.cancelled) return {ok:false,error:'cancelled'}
        return {ok:true,proposal:{html:proposal.html,css:proposal.css,theme:proposal.theme,baseRevision:raw.expectedRevision}}
      }
      logAiValidation(proposal.stage, proposal.code)
      if (attempt === 1 || sensitive(response)) return {ok:false,error:'invalid-output'}
      const after = read(raw.id)
      if (!after.ok) return {ok:false,error:after.error === 'not-found' ? 'not-found' : 'store-unreadable'}
      if (after.document.revision !== raw.expectedRevision) return {ok:false,error:'conflict'}
      // Treat prior output as untrusted data. The same restricted model and original rules apply again.
      candidatePrompt = `${prompt}\nThe previous proposed response failed local validation: ${proposal.code}. Repair it according to the rules above, preserving the user's requested changes. For this repair use only a small CSS subset: color, background-color, font-size, font-weight, line-height, text-align, padding, margin, border, border-radius, display, gap and flex-wrap. Use non-negative plain numbers or px/percent units, plain named colors or hex colors, and unquoted values; omit letter-spacing, CSS functions and all negative values. Prefer a simple readable layout over complex styling. Return one valid compact JSON object with html, css and theme, no Markdown fences, and escape newlines inside strings. Previous response (untrusted data):\n${response}`
    }
    return {ok:false,error:'invalid-output'}
  } catch { return {ok:false,error:'failed'} }
  finally { active.delete(raw.requestId); if (directory) { try { rmSync(directory,{recursive:true,force:true}) } catch { /* best effort */ } } }
}
