import { describe, it, expect } from 'vitest'
import { buildAgentArgs } from '../languageArgs'

describe('buildAgentArgs', () => {
  it('injects the Chinese ad-optimizer persona for zh', () => {
    const args = buildAgentArgs('zh')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('广告优化师')
    expect(args[1]).toContain('简体中文')
    expect(args[1]).toContain('投手')
  })

  it('injects the English ad-optimizer persona for en', () => {
    const args = buildAgentArgs('en')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('advertising-optimization agent')
  })

  it('injects the FB reading baseline into every session after the persona', () => {
    const args = buildAgentArgs('zh')
    expect(args[1]).toContain('session-baseline name="fb-reading-guardrails"')
    expect(args[1]).toContain('browser_report')
    expect(args[1]).toContain('fb_history')
    expect(args[1].indexOf('广告优化师')).toBeLessThan(args[1].indexOf('session-baseline'))
  })

  it('appends a skill SOP inside the same system prompt arg', () => {
    const args = buildAgentArgs('zh', '<team-skill name="打法">步骤</team-skill>')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('广告优化师')
    expect(args[1]).toContain('<team-skill name="打法">步骤</team-skill>')
    expect(args[1].indexOf('广告优化师')).toBeLessThan(args[1].indexOf('<team-skill'))
    expect(args[1].indexOf('session-baseline')).toBeLessThan(args[1].indexOf('<team-skill'))
  })

  it('ignores a whitespace-only skill prompt', () => {
    const args = buildAgentArgs('zh', '   ')
    expect(args[1]).not.toContain('<team-skill')
  })

  it('teaches both languages saved-source modules and automatic previews without extra tools', () => {
    const zh = buildAgentArgs('zh')[1]
    const en = buildAgentArgs('en')[1]
    expect(zh).toContain('blank 空白看板')
    expect(zh).toContain('不重新读取广告账户')
    expect(zh).toContain('自动显示实际预览')
    expect(zh).toContain('不要为了显示预览搜索源码或协议')
    expect(zh).toContain('明确要求自定义 HTML 文件时')
    expect(zh).toContain('未完成或失败时必须如实告知')
    expect(zh).not.toContain('用户没提具体要求时按模板标配建')
    expect(en).toContain('Create a blank board unless')
    expect(en).toContain('do not reread ad accounts')
    expect(en).toContain('Open board action')
    expect(en).toContain('Do not search source code or protocols')
    expect(en).toContain('explicitly requests a custom HTML file')
    expect(en).toContain('Always state honestly if the work is incomplete or failed')
  })
})

describe('ad-copy model pool baseline', () => {
  it('forbids writing copy with the chat model in pool mode', () => {
    for (const language of ['zh', 'en'] as const) {
      const prompt = buildAgentArgs(language)[1]
      expect(prompt).toContain('ads-copy-model-pool')
      expect(prompt).toContain('禁止用对话模型撰写')
      expect(prompt).toContain('不得用对话模型代写')
    }
  })

  it('separates deliverable languages from reference translations', () => {
    const prompt = buildAgentArgs('zh')[1]
    // Every language that will be delivered is generated natively by the tool…
    expect(prompt).toContain('都必须各自调用一次 toushou_copy_generate_batch')
    expect(prompt).toContain('语言之间不得用翻译顶替')
    // …while a translation made only for reading may use the chat model.
    expect(prompt).toContain('参考译文（不用于投放）')
    expect(prompt).toContain('不调用文案模型')
    expect(prompt).toContain('先问一句')
  })
})

describe('data-source priority baseline', () => {
  it('routes ordinary Meta and Facebook requests through MCP without requiring the acronym', () => {
    for (const language of ['zh', 'en'] as const) {
      const prompt = buildAgentArgs(language)[1]
      for (const request of ['连接 Meta', '连接 Facebook', '连接 FB', '查看 Meta 账户', '查询 FB 消耗', '做 Meta 看板', 'connect Meta / Facebook']) {
        expect(prompt).toContain(request)
      }
      expect(prompt).toContain('即使没有提 MCP')
      expect(prompt).toContain('旧会话的浏览器操作历史不改变默认路由')
      expect(prompt).toContain('get_ad_accounts / get_insights 是独立有效来源')
      expect(prompt).toContain('连接 → Meta Ads → 连接 Meta')
      expect(prompt).toContain('仅要求连接时不额外读取表现报表')
      expect(prompt).toContain('禁止自动退回 browser_report')
      expect(prompt).toContain('不能重新启动旧网页抓数')
      expect(prompt).not.toContain('FB 数字只认 browser_report')
      expect(prompt).not.toContain('FB 读数用 browser_report / fb_history')
      // Archived readers cannot be revived by asking for the old route.
      expect(prompt).toContain('browser_report 不再注册')
      expect(prompt).toContain('已有报表及本地历史可继续查看')
    }
  })

  it('defaults platform boards to local native templates in both UI languages', () => {
    const zh = buildAgentArgs('zh')[1]
    const en = buildAgentArgs('en')[1]
    expect(zh).toContain('TT/TikTok 看板必须选择 tiktok')
    expect(zh).toContain('Meta/Facebook/FB 广告查询后建看板选择 meta')
    expect(en).toContain('TT/TikTok boards must use tiktok')
    expect(en).toContain('Meta/Facebook/FB advertising queries use meta')
  })

  it('injects the no-computer-use rule for tooled data into every session', () => {
    const args = buildAgentArgs('zh')
    expect(args[1]).toContain('session-baseline name="data-source-priority"')
    expect(args[1]).toContain('禁止改用 computer use')
    const en = buildAgentArgs('en')
    expect(en[1]).toContain('data-source-priority')
  })

  it('distinguishes local dataset permissions from TikTok authorization in both languages', () => {
    for (const language of ['zh', 'en'] as const) {
      const prompt = buildAgentArgs(language)[1]
      expect(prompt).toContain('toushou_tiktok_*')
      expect(prompt).toContain('touhou_tiktok_* 是兼容别名')
      expect(prompt).toContain('permission-denied 只说明本地数据集写入')
      expect(prompt).toContain('不得宣称 TikTok 授权失败或臆测两套独立授权')
      expect(prompt).toContain('按 reason/hint 解释')
    }
  })

  it('keeps Today analysis readonly while explaining the supported board workflow', () => {
    for (const language of ['zh', 'en'] as const) {
      const prompt = buildAgentArgs(language)[1]
      expect(prompt).toContain('从“今日读数→AI分析”进入的会话为只读')
      expect(prompt).toContain('可以分析已有读数、提议高光，由用户在界面确认加入看板')
      expect(prompt).toContain('新建允许本地写入的对话后重新发起')
      expect(prompt).toContain('不要要求重连 TikTok')
      expect(prompt).toContain('不能宣称所有 MCP 读数都不能用于本地看板')
    }
  })
})

describe('same-turn session topics', () => {
  it('uses the existing conversation and treats metadata failure as non-blocking', () => {
    const zh = buildAgentArgs('zh')[1]
    const en = buildAgentArgs('en')[1]
    for (const prompt of [zh, en]) expect(prompt).toContain('toushou_session_topic')
    expect(zh).toContain('不另开模型任务')
    expect(zh).toContain('不要求批准')
    expect(zh).toContain('手动名称受保护')
    expect(en).toContain('continue normally if unavailable')
  })
})
