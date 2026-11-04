import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranscriptScroll } from './useTranscriptScroll'

type Session = 'synthetic-a' | 'synthetic-b' | 'synthetic-long'
function Fixture() {
  const [session, setSession] = useState<Session>('synthetic-a')
  const [growth, setGrowth] = useState<Record<Session, number>>({ 'synthetic-a': 0, 'synthetic-b': 0, 'synthetic-long': 0 })
  const [longLoaded, setLongLoaded] = useState(false)
  const { viewportRef, contentRef, onScroll, showJump, jumpToBottom } = useTranscriptScroll(session)
  const api = {
    switchTo: (next: Session) => setSession(next),
    grow: (target: Session) => setGrowth(current => ({ ...current, [target]: current[target] + 140 })),
    hydrateLong: () => setLongLoaded(true)
  }
  ;(window as unknown as { scrollFixture: typeof api }).scrollFixture = api
  return <>
    <div id="viewport" data-session={session} ref={viewportRef} onScroll={onScroll} style={{ width: 420, height: 240, overflowY: 'auto', overflowAnchor: 'none', border: '1px solid #777' }}>
      <div ref={contentRef} style={{ minHeight: '100%' }}>
        <div data-async-preview style={{ height: growth[session] }} />
        {Array.from({ length: session === 'synthetic-long' ? (longLoaded ? 72 : 0) : 18 }, (_, i) => <div key={`${session}-${i}`} data-chat-turn={`${session}-turn-${i}`}>
          <div className={session === 'synthetic-long' ? 'msg-row' : undefined} data-message-id={`${session}-message-${i}`} style={{ height: session === 'synthetic-long' ? 48 + (i % 7) * 36 : 80 }}>{'Synthetic message '.repeat(1 + (i % 5))}{i}</div>
        </div>)}
      </div>
    </div>
    {showJump && <button id="jump" onClick={jumpToBottom}>Jump to latest</button>}
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
