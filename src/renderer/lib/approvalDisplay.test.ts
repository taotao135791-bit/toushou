import { describe, expect, it } from 'vitest'
import { approvalDisplaySummary } from './approvalDisplay'

describe('display-only approval summaries', () => {
  it('recognizes HTML writes with inline or next-line content and platform paths', () => {
    expect(approvalDisplaySummary('select','Allow tool: write\nPath: folder/chat-board.html\nContent: <!DOCTYPE html>',undefined,'zh')).toEqual({title:'保存 HTML 文件',targetLabel:'文件',target:'chat-board.html'})
    expect(approvalDisplaySummary('confirm','Allow tool: write\r\nPath: C:\\temp\\sample.HTML\r\nContent:\r\n<html></html>',undefined,'en')).toEqual({title:'Save HTML file',targetLabel:'File',target:'sample.HTML'})
  })
  it('recognizes known board calls in a message without exposing plumbing as the headline', () => {
    const create='Allow tool: write\nPath: xd://toushou_board_create\nContent:\n'+JSON.stringify({name:'合成看板',template:'blank'})
    expect(approvalDisplaySummary('select','Extension tool',create,'zh')).toEqual({title:'新建看板',targetLabel:'看板',target:'合成看板'})
    const add='Allow tool: write\nPath: xd://toushou_board_add_widget\nContent: '+JSON.stringify({name:'合成看板',type:'file',config:{filePath:'demo.html'}})
    expect(approvalDisplaySummary('select',add,undefined,'zh')).toEqual({title:'添加组件',targetLabel:'看板 / 组件',target:'合成看板 / 文件'})
  })
  it('does not reinterpret other methods, malformed envelopes, unknown tools or incomplete arguments', () => {
    for(const [method,title] of [
      ['input','Allow tool: write\nPath: demo.html\nContent: x'],
      ['select','Allow tool: bash\nPath: demo.html\nContent: x'],
      ['select','Allow tool: write Path: demo.html Content: x'],
      ['select','Allow tool: write\nPath: demo.txt\nContent: x'],
      ['select','Allow tool: write\nPath: xd://toushou_board_create\nContent: {bad'],
      ['select','Allow tool: write\nPath: xd://other\nContent: {}'],
      ['select','Allow tool: write\nPath: xd://toushou_board_add_widget\nContent: {"type":"file"}'],
      ['select','Allow tool: write\nPath: xd://toushou_board_add_widget\nContent: {"name":"A","type":"mystery"}']
    ]) expect(approvalDisplaySummary(method,title,undefined,'zh')).toBeNull()
  })
})
