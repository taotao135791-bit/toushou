import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import TasksPage from './TasksPage'
import { useAppStore } from '../store'
import type { ScheduledTask } from '@shared/types'

const base = { cwd: '/synthetic/project', schedule: { type: 'daily' as const, time: '09:00' }, enabled: true, createdAt: 1, notifyOnComplete: true, notifyChannel: 'feishu' as const }
const tasks: ScheduledTask[] = [
  { ...base, id: 'legacy-task', name: 'Legacy fixture', prompt: 'Legacy task' },
  { ...base, id: 'delivery-task', name: 'Delivery fixture', prompt: 'Synthetic report', feishuChatId: 'oc_named_synthetic_12345678', runs: [
    { runId: 'unknown-run', startedAt: 1000, finishedAt: 2000, outcome: 'success', delivery: { status: 'unknown', attemptedAt: 2000 } },
    { runId: 'failed-run', startedAt: 3000, finishedAt: 4000, outcome: 'success', delivery: { status: 'failed', error: 'feishu-not-connected', attemptedAt: 4000 } }
  ] }
]
const fixture = { saved: [] as ScheduledTask[], retries: [] as Array<{ taskId: string; runId: string }> }
useAppStore.setState({ language: 'en', scheduledTasks: tasks, recentWorkspaces: [{ id: 'project', displayPath: '/synthetic/project' }] })
Object.assign(window, {
  taskFixture: fixture,
  electronAPI: {
    listTaskFeishuTargets: async () => [
      { chatId: 'oc_named_synthetic_12345678', chatType: 'group', name: 'Synthetic team', updatedAt: 2 },
      { chatId: 'oc_unknown_synthetic_87654321', chatType: 'group', updatedAt: 1 }
    ],
    saveTask: async (task: ScheduledTask) => {
      fixture.saved.push(structuredClone(task))
      useAppStore.setState(state => ({ scheduledTasks: [...state.scheduledTasks.filter(item => item.id !== task.id), task] }))
      return { ok: true, task }
    },
    retryTaskDelivery: async (taskId: string, runId: string) => { fixture.retries.push({ taskId, runId }); return true }
  }
})
createRoot(document.getElementById('root')!).render(<MemoryRouter><TasksPage /></MemoryRouter>)
