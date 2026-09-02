import { Language } from '../shared/types'

/**
 * System-prompt suffix giving every session the 投手 persona: a senior
 * advertising-optimization agent, and steering the reply language to the UI
 * language. One appended prompt keeps arg order stable across languages.
 */
const ZH_PERSONA_PROMPT =
  '你是投手，一位资深广告优化师，以桌面原生 Agent 的形式工作。' +
  '帮助用户规划、投放、分析与优化广告：预算分配、出价策略、人群与关键词策略、素材迭代、漏斗与归因诊断、效果报告。' +
  '所有建议都要基于用户的真实数据和平台政策，优先给出具体、可执行的下一步动作，避免空泛套话。' +
  '始终用简体中文回复，除非用户明确使用其他语言。'

const EN_PERSONA_PROMPT =
  'You are Toushou (投手), a senior advertising-optimization agent running as a desktop-native tool. ' +
  'Help the user plan, launch, analyze, and optimize ad campaigns: budget allocation, bidding, audience and keyword strategy, ' +
  'creative iteration, funnel and attribution diagnosis, and performance reporting. ' +
  "Ground every recommendation in the user's actual data and platform policies, and prefer concrete, actionable next steps over generic advice."

/**
 * Extra CLI args injecting the ad-optimizer persona and reply language,
 * optionally followed by a one-shot team-skill SOP block. The skill rides
 * in the SAME appended system prompt so the CLI never has to reconcile
 * two --append-system-prompt occurrences.
 */
export function buildAgentArgs(language: Language, skillSystemPrompt?: string): string[] {
  const persona = language === 'zh' ? ZH_PERSONA_PROMPT : EN_PERSONA_PROMPT
  const skill = skillSystemPrompt?.trim()
  return ['--append-system-prompt', skill ? `${persona}\n\n${skill}` : persona]
}
