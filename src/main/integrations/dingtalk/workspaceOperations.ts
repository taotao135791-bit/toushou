import catalog from '../../../../resources/dingtalk-toolkit/catalog/operations.json'
import { serializeBoundedJson } from '../../../shared/boundedJson'
import { redactSecrets } from '../../lib/logger'

interface WorkspaceParameter {
  type: 'string' | 'strings' | 'integer' | 'number' | 'boolean' | 'json'
  required: boolean
  description: string
  enum?: readonly string[]
  shape?: 'object' | 'array'
}

interface WorkspaceOperation {
  id: string
  path: readonly string[]
  description: string
  effect: 'read' | 'write' | 'destructive'
  usage?: string
  confirmation: 'not_required' | 'user_required'
  params: Readonly<Record<string, WorkspaceParameter>>
  fixed?: Readonly<Record<string, string>>
  transfer?: 'file' | 'output'
  stdin?: 'content'
}

export const workspaceCatalogVersion = catalog.version
// TypeScript gives heterogeneous JSON flag maps optional undefined properties.
const operations = catalog.operations as unknown as readonly WorkspaceOperation[]
const byId = new Map(operations.map(operation => [operation.id, operation]))
const PAGE_SIZE = 25
const MAX_INPUT_BYTES = 24_000
const unsafeObjectKeys = new Set(['__proto__', 'prototype', 'constructor'])

export function getWorkspaceOperation(id: string): WorkspaceOperation | undefined {
  return byId.get(id)
}

export function listWorkspaceOperations(service?: string, operation?: string, offset = 0) {
  if (operation) {
    const item = getWorkspaceOperation(operation)
    if (!item || (service && item.path[0] !== service)) return null
    return { id: item.id, service: item.path[0], description: item.description, effect: item.effect,
      confirmation: item.confirmation, params: item.params, ...(item.transfer ? { transfer: item.transfer } : {}),
      ...(item.usage ? { usage: item.usage } : {}) }
  }
  if (!service) {
    const counts = new Map<string, number>()
    for (const { path } of operations) counts.set(path[0], (counts.get(path[0]) ?? 0) + 1)
    return { version: catalog.version, services: Array.from(counts, ([service, count]) => ({ service, count })) }
  }
  const matches = operations.filter(item => item.path[0] === service)
  if (!matches.length || !Number.isSafeInteger(offset) || offset < 0) return null
  const items = matches.slice(offset, offset + PAGE_SIZE).map(({ id, description, effect, confirmation }) => ({ id, description, effect, confirmation }))
  const next = offset + items.length
  return { service, operations: items, total: matches.length, ...(next < matches.length ? { nextOffset: next } : {}) }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const chartTypes = new Set(['BAR', 'COLUMN', 'LINE', 'PIE', 'AREA', 'SCATTER', 'FUNNEL', 'RADAR', 'NUMBER'])
const aggregations = new Set(['count', 'sum', 'avg', 'max', 'min'])
const fieldId = (value: unknown): boolean => typeof value === 'string' && /^[a-z0-9_-]{1,200}$/i.test(value)

function basicChartFields(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every(field =>
    plainObject(field) && Object.keys(field).every(key => key === 'value' || key === 'externalValue') && fieldId(field.value)
    && (field.externalValue === undefined || (Array.isArray(field.externalValue) && field.externalValue.length <= 8
      && field.externalValue.every(entry => plainObject(entry) && Object.keys(entry).length === 2
        && entry.type === 'formula' && typeof entry.value === 'string' && aggregations.has(entry.value)))))
}

function basicChartParameter(key: string, value: unknown): boolean {
  if (!plainObject(value)) return false
  if (key === 'layout') return Object.entries(value).every(([key, size]) => ['x', 'y', 'w', 'h'].includes(key)
    && typeof size === 'number' && Number.isSafeInteger(size) && size >= (key === 'w' || key === 'h' ? 1 : 0))
  return typeof value.chartType === 'string' && chartTypes.has(value.chartType) && Object.entries(value).every(([key, item]) => {
    switch (key) {
      case 'chartType': return true
      case 'name': return typeof item === 'string' && item.trim().length > 0 && item.length <= 200 && safeText(item)
      case 'sheet': return fieldId(item)
      case 'measureType': return item === 'field'
      case 'measure':
      case 'dimension': return basicChartFields(item)
      default: return false
    }
  })
}

// DWS can interpret @path and '-' as input sources, even on business flags.
// Business text may contain normal slashes, mentions, punctuation and Markdown.
function safeText(value: string): boolean {
  return value.length <= MAX_INPUT_BYTES && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
}

function safeLiteral(value: string): boolean {
  return safeText(value) && !/^(?:@|-$|--|[\\/]|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|(?:file|data|javascript|vbscript):)/i.test(value.trim())
}

const officeFunctions = new Set(('SUM SUMIF SUMIFS AVERAGE AVERAGEIF AVERAGEIFS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS ' +
  'MIN MAX MEDIAN PRODUCT ROUND ROUNDUP ROUNDDOWN ABS INT MOD POWER SQRT IF IFS IFERROR AND OR NOT TRUE FALSE ' +
  'TODAY NOW DATE YEAR MONTH DAY WEEKDAY TEXT LEFT RIGHT MID LEN TRIM CONCAT CONCATENATE LOWER UPPER VALUE ' +
  'INDEX MATCH VLOOKUP HLOOKUP XLOOKUP ROW COLUMN SUBTOTAL SUMPRODUCT').split(' '))

function safeCellFormula(value: string): boolean {
  if (!/^\s*[=+-]/.test(value) || /^\s*[+-]?(?:\d+(?:\.\d+)?%?|-)\s*$/.test(value)) return true
  const expression = value.replace(/"(?:[^"]|"")*"/g, '""')
  if (/[\[\]|\\@{}]/.test(expression) || /:\/\//.test(expression)) return false
  return [...expression.matchAll(/([\w.]+)\s*\(/g)].every(match => officeFunctions.has(match[1].toUpperCase()))
}

function safeCellLink(item: Record<string, unknown>, kind: unknown): boolean {
  if (kind === 'none' || kind === 'range' || kind === 'sheet') return true
  if (!(kind === undefined || kind === 'path') || typeof item.link !== 'string') return false
  try {
    const url = new URL(item.link)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}

function rangeCell(value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (!plainObject(value) || Object.keys(value).some(key => !['type', 'text', 'texts', 'cellStyles', 'hyperlink', 'dataValidation'].includes(key))) return false
  if (value.hyperlink !== undefined && (!plainObject(value.hyperlink) || !safeCellLink(value.hyperlink, value.hyperlink.type))) return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'richText') return Array.isArray(value.texts) && value.texts.every(item => {
    if (!plainObject(item)) return false
    if (item.type === 'text') return typeof item.text === 'string'
    if (item.type === 'link') return safeCellLink(item, item.subType)
    if (item.type === 'attachment') return fieldId(item.resourceId)
    if (item.type === 'image') return fieldId(item.resourceId) && typeof item.resourceUrl === 'string' && /^\/core\/api\/resources\/img\/[\w-]+$/.test(item.resourceUrl)
    return false
  })
  return value.type === undefined && value.text === undefined && value.texts === undefined
}

function rangeValues(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.length > 0 && value.every(row => Array.isArray(row) && row.length > 0 && row.every(rangeCell))
}

type JsonUsage = 'data' | 'cells' | 'configuration'

// Cobra sees the serialized array/object as one value. String cells and custom column names
// are data, so a cell containing an @mention, HTTPS link or file name is not a CLI input source.
function safeJson(value: unknown, budget: { nodes: number }, usage: JsonUsage, depth = 0): boolean {
  if (++budget.nodes > 3_000 || depth > 10) return false
  if (typeof value === 'string') return safeText(value) && (usage !== 'cells' || safeCellFormula(value))
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(item => safeJson(item, budget, usage, depth + 1))
  if (!plainObject(value)) return false
  return Object.entries(value).every(([key, item]) => {
    const name = key.toLowerCase().replace(/[-_\s]/g, '')
    if (key.length > 160 || !safeText(key) || unsafeObjectKeys.has(key)) return false
    if (usage === 'configuration' && /^(?:command|script|javascript|shell|executable|exec|endpoint|webhook|callbackurl|mcp|toolname|filepath|localpath|stdin|accesstoken|apikey|action|actions)$/.test(name)) return false
    if (usage === 'cells' && (name === 'formula' || name === 'formulavalue') && typeof item === 'string' && !safeCellFormula('=' + item)) return false
    return safeJson(item, budget, usage, depth + 1)
  })
}

export function parseWorkspaceArgs(id: string, raw: unknown): Record<string, unknown> | null {
  const operation = getWorkspaceOperation(id)
  if (!operation || !plainObject(raw)) return null
  if (Object.keys(raw).some(key => !Object.hasOwn(operation.params, key))) return null
  const args: Record<string, unknown> = {}
  const budget = { nodes: 0 }
  for (const [name, spec] of Object.entries(operation.params)) {
    if (!Object.hasOwn(raw, name)) {
      if (spec.required) return null
      continue
    }
    const value = raw[name]
    if (operation.stdin === name) {
      if (typeof value !== 'string' || !value.trim() || value.length > 64_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) return null
      args[name] = value
      continue
    }
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') return null
        break
      case 'integer':
        if (!Number.isSafeInteger(value)) return null
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return null
        break
      case 'string':
        if (typeof value !== 'string' || !value.trim() || !safeLiteral(value) || (spec.enum && !spec.enum.includes(value))) return null
        break
      case 'strings':
        if (!Array.isArray(value) || !value.length || value.length > 200 || !value.every(item => typeof item === 'string' && !!item.trim() && safeLiteral(item))) return null
        break
      case 'json': {
        if ((id === 'aitable.chart.create' || id === 'aitable.chart.update') && (name === 'layout' || name === 'config') && !basicChartParameter(name, value)) return null
        if (id === 'sheet.range.update' && name === 'values' && !rangeValues(value)) return null
        if ((spec.shape === 'object' && !plainObject(value)) || (spec.shape === 'array' && !Array.isArray(value))) return null
        const usage = operation.path[0] === 'sheet' && name === 'values' ? 'cells'
          : /^(?:aitable\.view\.update\.|sheet\.(?:chart|cond-format|pivot-table)\.)/.test(id) ? 'configuration' : 'data'
        if ((!Array.isArray(value) && !plainObject(value)) || !safeJson(value, budget, usage)) return null
        break
      }
      default: return null
    }
    args[name] = value
  }
  const commandArgs = operation.stdin ? { ...args, [operation.stdin]: '-' } : args
  return Buffer.byteLength(JSON.stringify(commandArgs)) <= MAX_INPUT_BYTES ? args : null
}

export function workspaceArguments(operation: WorkspaceOperation, args: Record<string, unknown>): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (key === operation.stdin) {
      flags.push('--' + key + '=-')
      continue
    }
    const type = operation.params[key].type
    const encoded = operation.id === 'sheet.range.update' && key === 'values' && rangeValues(value)
      ? value.map(row => row.map(cell => plainObject(cell) ? cell : { type: 'text', text: String(cell) })) : value
    const values = type === 'strings' ? value as string[] : [type === 'json' ? JSON.stringify(encoded) : String(value)]
    for (const item of values) flags.push('--' + key + '=' + item)
  }
  for (const [key, value] of Object.entries(operation.fixed ?? {})) flags.push('--' + key + '=' + value)
  return [...operation.path, ...flags]
}

function scrubText(value: string): string {
  return redactSecrets(value)
    .replace(/(https?:\/\/)[^\s\/@]+@/gi, '$1***@')
    .replace(/([?&](?:[^&=\s]*(?:token|secret|signature|credential)|password|apikey|api_key|signature|sig)=)[^&#\s]*/gi, '$1***')
    .replace(/\b((?:Bearer|Basic)\s+)[^\s,;"']+/gi, '$1***')
}

function project(value: unknown, depth: number, privatePath?: string): unknown {
  if (depth > 20) return '[depth limit]'
  if (typeof value === 'string') {
    // Some generated API commands return MCP text containing a second JSON payload.
    if (/^\s*[{[]/.test(value)) {
      try { return JSON.stringify(project(JSON.parse(value), depth + 1, privatePath)) } catch { /* ordinary document text */ }
    }
    const text = privatePath ? value.replaceAll(privatePath, '[local file]').replaceAll(encodeURI(privatePath), '[local file]') : value
    return scrubText(text)
  }
  if (Array.isArray(value)) return value.map(item => project(item, depth + 1, privatePath))
  if (!plainObject(value)) return value
  const fields = Object.entries(value).filter(([key]) => {
    const name = key.toLowerCase().replace(/[-_\s]/g, '')
    if (name === 'nexttoken' || name === 'pagetoken' || name === 'nextpagetoken') return true
    return !unsafeObjectKeys.has(key) && !/(?:token|secret|password|credential|authorization|cookie|apikey|privatekey|signature)/.test(name)
      && !['headers', 'requestheaders', 'responseheaders', 'rawresponse', 'rawrequest', 'debug', 'nextcommand', 'commandline', 'environment', 'savedpath', 'outputpath', 'localpath',
        'uploadurl', 'signedurl', 'presignedurl', 'downloadurl'].includes(name)
  })
  return Object.fromEntries(fields.map(([key, item]) => [key, project(item, depth + 1, privatePath)]))
}

export function projectWorkspaceResult(value: unknown, privatePath?: string): unknown {
  return JSON.parse(serializeBoundedJson(project(value, 0, privatePath), 24_000))
}
