/** Same-turn sidebar metadata. No provider call, filesystem access or user approval. */
interface TopicToolApi {
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string | string[] }) => Promise<{ systemPrompt: string | string[] } | void>): void
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown; approval: 'read'; loadMode: 'essential'
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
}

export default function sessionTopic(api: TopicToolApi): void {
  const bridge = process.env.TOUSHOU_SESSION_TOPIC
  if (!bridge) return
  async function call(value: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(bridge!, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500)
      })
      if (!response.ok) return { ok: false, error: 'topic-unavailable' }
      const result = await response.json() as Record<string, unknown>
      return result
    } catch { return { ok: false, error: 'topic-unavailable' } }
  }
  api.on('before_agent_start', async (event) => {
    const context = await call({ action: 'context' })
    if (!context.ok || context.manual || !Number.isSafeInteger(context.revision)) return
    const instruction = `Sidebar metadata: during this same response, call toushou_session_topic once with revision=${context.revision} and a concise topic (Chinese 6–16 characters or English 3–8 words) summarizing the conversation's current goal, not the first prompt verbatim. Update when the goal evolves. Never include account IDs, keys, tokens, email addresses or URLs. This updates only this conversation's automatic sidebar title; do not ask approval or mention it in the answer. Do not call another model. Failure or unavailability must not interrupt the user's task.`
    return { systemPrompt: Array.isArray(event.systemPrompt) ? [...event.systemPrompt, instruction] : `${event.systemPrompt}\n\n${instruction}` }
  })
  api.registerTool({
    name: 'toushou_session_topic', label: '更新会话主题',
    description: 'Update only this conversation’s automatic sidebar topic. Use the latest revision provided by the sidebar metadata instruction. Manual names are protected. This is local UI metadata, available in readonly sessions; no account or file operation.',
    approval: 'read', loadMode: 'essential',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { title: { type: 'string', maxLength: 60, description: 'Concise current conversation topic, without credentials or identifiers' }, revision: { type: 'integer', minimum: 0 } },
      required: ['title', 'revision']
    },
    execute: async (_id, params, signal) => ({ content: [{ type: 'text', text: JSON.stringify(await call({ action: 'topic', title: params?.title, revision: params?.revision }, signal)) }] })
  })
}
