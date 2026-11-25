import { describe, expect, it } from 'vitest'
import catalog from '../../../resources/dingtalk-toolkit/catalog/operations.json'
import coverage from '../../../resources/dingtalk-toolkit/catalog/coverage.json'

interface Operation {
  id: string
  path: string[]
  description: string
  effect: string
  confirmation: string
  params: Record<string, { type: string; required: boolean; description: string; enum?: string[] }>
  usage?: string
  stdin?: string
  fixed?: Record<string, string>
  transfer?: 'file' | 'output'
}

const operations = catalog.operations as Operation[]
const byId = new Map(operations.map(op => [op.id, op]))
const get = (id: string) => {
  const op = byId.get(id)
  if (!op) throw new Error('Missing reviewed command ' + id)
  return op
}

describe('reviewed DingTalk business catalog', () => {
  it('accounts for each distinct leaf in the pinned official schema', () => {
    expect(catalog.version).toBe('1.0.69')
    expect(coverage.version).toBe(catalog.version)
    expect(coverage.schemaCatalogHash).toMatch(/^sha256:[a-f\d]{64}$/)
    expect(coverage.total).toBe(1613)
    expect(coverage.enabled).toBe(operations.length)
    expect(byId.size).toBe(operations.length)
    let total = 0
    for (const [service, review] of Object.entries(coverage.products)) {
      const paths = operations.filter(op => op.path[0] === service).map(op => op.path.slice(1).join(' '))
      expect(paths.length).toBe(review.enabled)
      const accounted = [...paths, ...Object.values(review.excluded).flat()]
      expect(accounted.length).toBe(review.total)
      expect(new Set(accounted).size).toBe(review.total)
      total += review.total
    }
    expect(total).toBe(coverage.total)
  })

  it('uses fixed business paths and reviewed flag names with no user override of native inputs', () => {
    const blockedServices = new Set(['api', 'mcp', 'auth', 'pat', 'dev', 'devapp', 'event', 'outbound-call', 'voip'])
    const blockedParams = new Set(['file', 'output', 'force', 'yes', 'profile', 'client-secret', 'headers', 'client-id',
      'request', 'operations', 'command', 'url-only', 'records-file', 'content-file', 'notify', 'reply-notice', 'send-card',
      'send-chat', 'send-ding', 'send-work-notice', 'cc-list', 'share-uid-list', 'ai-config', 'dsl', 'local-folder'])
    for (const op of operations) {
      expect(op.description).toBeTruthy()
      expect(op.id).toBe(op.path.map(token => token.replace(/^\+/, '')).join('.'))
      expect(op.path.every(token => /^\+?[a-z][a-z0-9-]*$/.test(token))).toBe(true)
      expect(blockedServices.has(op.path[0])).toBe(false)
      expect(['read', 'write', 'destructive']).toContain(op.effect)
      for (const [flag, spec] of Object.entries(op.params)) {
        expect(flag).toMatch(/^[a-zA-Z][a-zA-Z0-9-]*$/)
        expect(blockedParams.has(flag)).toBe(false)
        expect(Object.hasOwn(op.fixed ?? {}, flag)).toBe(false)
        expect(['string', 'strings', 'json', 'integer', 'number', 'boolean']).toContain(spec.type)
        expect(typeof spec.required).toBe('boolean')
      }
      if (op.effect === 'destructive' || op.fixed?.yes === 'true') expect(op.confirmation).toBe('user_required')
    }
  })

  it('keeps table and AI table CRUD on native single-purpose commands', () => {
    for (const id of ['sheet.create', 'sheet.range.read', 'sheet.range.update', 'sheet.delete-sheet', 'aitable.table.create',
      'aitable.table.get', 'aitable.table.update', 'aitable.table.delete', 'aitable.record.create', 'aitable.record.get',
      'aitable.record.update', 'aitable.record.delete']) expect(get(id).id).toBe(id)
    expect(get('sheet.range.update').params.values).toMatchObject({ type: 'json', required: true })
    expect(get('aitable.record.create').params.records).toMatchObject({ type: 'json', required: true })
    const types = get('aitable.field.create').params.type.enum
    expect(types).toContain('text')
    for (const type of ['formula', 'object', 'button']) expect(types).not.toContain(type)
    expect(get('aitable.field.create').params).not.toHaveProperty('fields')
    expect(get('sheet.range.set-style').params['bg-color'].type).toBe('string')
    expect(get('sheet.range.set-style').params['font-size'].type).toBe('integer')
    expect(get('doc.block.insert').params.index.type).toBe('integer')
    expect(get('doc.block.list').params['block-id'].type).toBe('string')
    expect(get('drive.list').params.quiet.type).toBe('boolean')
    expect(get('drive.search').params['creator-uids'].type).toBe('strings')
    expect(get('mind.node.create').params.topic.type).toBe('json')
  })

  it('retains collaborator and approval workflows while fixing notification switches', () => {
    for (const id of ['wiki.member.add', 'wiki.member.update', 'doc.permission.add', 'drive.permission.update']) {
      expect(get(id)).toMatchObject({ confirmation: 'user_required', fixed: { notify: 'false' } })
    }
    for (const id of ['wiki.member.remove', 'wiki.permission.set-share-scope', 'oa.approval.create-instance',
      'oa.approval.approve', 'contact.user.update', 'chat.group.set-admin']) expect(get(id).confirmation).toBe('user_required')
    expect(get('aitable.form.share.update').fixed?.['reply-notice']).toBe('false')
    expect(get('oa.approval.create-instance').params['form-values'].type).toBe('json')
    expect(get('oa.approval.create-instance').params).not.toHaveProperty('request')
  })

  it('pins document overwrite, board creation and business settings to reviewed modes', () => {
    const edit = get('doc.update')
    expect(edit).toMatchObject({ path: ['doc', '+update'], fixed: { command: 'overwrite', yes: 'true' },
      stdin: 'content', effect: 'destructive', confirmation: 'user_required' })
    expect(Object.keys(edit.params).sort()).toEqual(['content', 'node'])
    for (const id of ['mind.create', 'whiteboard.create-with-content']) {
      expect(get(id).params.source).toMatchObject({ type: 'json', shape: 'object', required: true })
    }
    for (const id of ['attendance.selfsetting.save', 'attendance.globalsetting.save']) {
      expect(get(id).fixed?.['setting-scene']).toBe('fastCheck')
      expect(Object.keys(get(id).params).some(key => /remind|send|notify|push/i.test(key))).toBe(false)
    }
    for (const id of ['aitable.chart.create', 'aitable.chart.update']) {
      expect(get(id).params.config).toMatchObject({ type: 'json', shape: 'object' })
      expect(get(id).params.layout).toMatchObject({ type: 'json', shape: 'object' })
    }
    for (const id of ['chat.message.recall', 'chat.thread.recall-message', 'ding.recall-personal']) {
      expect(get(id).confirmation).toBe('user_required')
    }
  })

  it('describes complex parameters in the corresponding individual operation', () => {
    expect(get('sheet.range.update').usage).toContain('{} 保留')
    expect(get('sheet.append').usage).toContain('二维数组')
    expect(get('aitable.record.update').usage).toContain('recordId')
    expect(get('aitable.record.query').usage).toContain('"operator"')
    expect(get('oa.approval.create-instance').usage).toContain('form-values')
    expect(get('doc.update').usage).toContain('完整 Markdown')
    for (const op of operations.filter(op => op.usage)) expect(op.usage).not.toMatch(/dws |@file|--content-file|--file /)
  })

  it('excludes primary, alias and indirect message or arbitrary execution paths', () => {
    for (const id of ['chat.message.send', 'chat.message.reply', 'chat.message.forward', 'chat.message.send-by-bot',
      'chat.message.send-by-webhook', 'chat.message.send-card', 'chat.group.notice.create', 'chat.thread.send',
      'chat.dm', 'ding.message.send', 'mail.draft.send', 'mail.message.reply', 'mail.message.share-to-chat',
      'report.entry.submit', 'oa.approval.oa-cc-noticer', 'sport.competition.announce', 'aitable.form.share.notify',
      'aitable.workflow.create', 'aitable.workflow.run', 'aitable.field.run-ai', 'sheet.batch-update',
      'aitable.supabase.api-key.list', 'aitable.psql', 'doc.script', 'doc.grant-and-share', 'drive.sync']) {
      expect(byId.has(id), id).toBe(false)
    }
    expect(get('mail.draft.create').params).not.toHaveProperty('to')
    const calendar = get('calendar.event.create')
    for (const key of ['attendees', 'open-dingtalk-ids', 'remind-minutes']) expect(calendar.params).not.toHaveProperty(key)
    for (const id of ['calendar.attendee.add', 'dingtalk-tag.run.trace', 'dingtalk-tag.manage.login', 'aicard.preview', 'audit.tail']) expect(byId.has(id)).toBe(false)
    for (const id of ['dingtalk-tag.manage.list', 'contact.label.create', 'devdoc.article.search', 'aicard.chart.list', 'html.fetch', 'markdown.overwrite']) expect(get(id).id).toBe(id)
  })

  it('routes approved file transfers only through the native picker and isolates email filenames', () => {
    for (const [id, kind] of Object.entries({ 'doc.upload': 'file', 'doc.download': 'output', 'drive.download': 'output',
      'sheet.import.create': 'file', 'sheet.export': 'output', 'oa.approval.attachment.upload': 'file',
      'mail.attachment.download': 'output' })) expect(get(id).transfer).toBe(kind)
    for (const op of operations.filter(op => op.transfer)) {
      expect(op.confirmation).toBe('user_required')
      expect(op.effect).toBe('write')
      expect(op.params).not.toHaveProperty(op.transfer!)
    }
    const mail = get('mail.attachment.download')
    expect(mail.fixed?.name).toBe('attachment.bin')
    expect(mail.params).not.toHaveProperty('name')
    expect(get('sheet.export-csv').params).not.toHaveProperty('allow-truncated')
    for (const id of ['aitable.attachment.upload', 'drive.upload-info', 'whiteboard.export', 'mail.message.export']) expect(byId.has(id)).toBe(false)
  })
})
