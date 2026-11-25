import { describe, expect, it } from 'vitest'
import { replyAttachmentPaths } from './replyAttachmentPaths'

describe('file evidence in one assistant reply', () => {
  it('resolves only named files in a stated folder, never merely implied extensions or figure ranges', async () => {
    const source = [
      'Open [the report][deliverable].',
      '',
      'Files are in [output folder](file:///tmp/Example%20Files/). Names: ' + '\x60summary.html\x60, \x60.md\x60, \x60fig1–3.png\x60.',
      '',
      '[deliverable]: ./summary.html',
      '[unused]: ./not-delivered.csv',
      '',
      '~~~sh', 'cat /tmp/never-mentioned/sample.csv', 'ls /tmp/other/', '~~~'
    ].join('\n')
    const { folders, files } = await replyAttachmentPaths(source)
    expect([...folders]).toEqual(['/tmp/Example Files'])
    expect([...files]).toEqual(['/tmp/Example Files/summary.html'])
  })

  it('preserves percent escapes, rejects traversal and retains a literal range-shaped filename when explicitly linked', async () => {
    const source = 'Directory: ' + '\x60/tmp/Pct%2520/\x60. [report](a%2520.csv), [plot](fig1-3.png), [other](../secret.csv).'
    const { folders, files } = await replyAttachmentPaths(source)
    expect([...folders]).toEqual(['/tmp/Pct%20'])
    expect([...files]).toEqual(['/tmp/Pct%20/a%20.csv', '/tmp/Pct%20/fig1-3.png'])
  })

  it('binds Windows drive paths to named files across Chinese punctuation and Markdown links', async () => {
    const source = '先看 \x60Report.html\x60。输出目录：\x60C:\\Example Files\\Reports\\\x60，表格 [查看](Summary%20Q4.xlsx)。'
    const { folders, files } = await replyAttachmentPaths(source)
    expect([...folders]).toEqual(['C:\\Example Files\\Reports'])
    expect([...files]).toEqual(['C:\\Example Files\\Reports\\Report.html', 'C:\\Example Files\\Reports\\Summary Q4.xlsx'])
  })

  it('keeps a later section separate when different destinations have been specified', async () => {
    const source = ['Directory: \x60/tmp/Example-A/\x60', '', '- \x60report.csv\x60', '', 'Directory: \x60/tmp/Example-B/\x60',
      '', '- \x60report.csv\x60', '', '## Other', '', '\x60unrelated.csv\x60'].join('\n')
    const { files } = await replyAttachmentPaths(source)
    expect([...files]).toEqual(['/tmp/Example-A/report.csv', '/tmp/Example-B/report.csv'])
  })
})
