import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ExtensionUiDialog from './ExtensionUiDialog'
import { useAppStore } from '../store'
import type { UiRequest } from '../store'

const request = (title:string, message?:string): UiRequest => ({ type:'ui_request',sessionId:'synthetic',id:'test',method:'select',title,message,options:['Allow once','Reject'] })
describe('extension approval display', () => {
  it('puts a human summary first and keeps the received request in collapsed text, not rendered HTML', () => {
    useAppStore.setState({language:'en'})
    const raw='Allow tool: write\nPath: /workspace/chat-board.html\nContent: <script>synthetic</script>'
    const html=renderToStaticMarkup(<ExtensionUiDialog sessionId="synthetic" request={request(raw,'Extra context')} />)
    expect(html).toContain('Save HTML file');expect(html).toContain('chat-board.html')
    expect(html).toContain('Technical details (received request)');expect(html).toContain('<details')
    expect(html).toContain('Allow tool: write');expect(html).toContain('Extra context')
    expect(html).toContain('&lt;script&gt;synthetic&lt;/script&gt;');expect(html).not.toContain('<script>')
    expect(html).toContain('Allow once');expect(html).toContain('Reject')
  })
  it('marks a request at the existing runtime limit as potentially truncated', () => {
    useAppStore.setState({language:'en'})
    const prefix='Allow tool: write\nPath: chat-board.html\nContent: '
    const html=renderToStaticMarkup(<ExtensionUiDialog sessionId="synthetic" request={request(prefix+'x'.repeat(2000-prefix.length))} />)
    expect(html).toContain('Save HTML file');expect(html).toContain('The received request may have been truncated.')
  })
  it('keeps unknown request details visible and bounds long headings', () => {
    useAppStore.setState({language:'en'})
    const title='Unknown operation '+ 'z'.repeat(200)
    const html=renderToStaticMarkup(<ExtensionUiDialog sessionId="synthetic" request={request(title)} />)
    expect(html).toContain(title);expect(html).toContain('max-h-16');expect(html).toContain('max-h-32')
    expect(html).not.toContain('Technical details (received request)')
  })
})

describe('board target chooser', () => {
  it('opens with no selections, disables locked boards and prompts for an explicit choice', () => {
    const html = renderToStaticMarkup(<ExtensionUiDialog sessionId="synthetic" request={{
      type: 'ui_request', sessionId: 'synthetic', id: 'board-targets', method: 'board_targets', title: 'ignored',
      boards: [
        { id: 'daily', name: '北美投放日报', description: 'Meta 获客与消耗', suggested: true },
        { id: 'creative', name: '北美素材复盘', suggested: true },
        { id: 'archive', name: '历史归档', locked: true }
      ]
    }} />)
    expect(html).toContain('Choose boards to update')
    expect(html).toContain('Select one or more boards')
    expect(html).toContain('aria-label="Likely matches"')
    expect(html).toContain('aria-label="Other boards"')
    expect(html).toContain('Meta 获客与消耗')
    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
    expect(html).not.toContain('checked=""')
    expect(html).toMatch(/type="checkbox" disabled=""[^>]*>/)
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Continue update<\/button>/)
  })
})
