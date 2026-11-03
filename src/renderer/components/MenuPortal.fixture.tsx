import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MenuPortal from './MenuPortal'

interface MenuFixtureApi {
  rerender: () => void
  rows: (count: number) => void
  move: (left: number, top: number) => void
  snapshot: () => { open: boolean; stream: number; clicks: number; closedWith: number; draft: string; refreshes: number }
}
declare global { interface Window { menuFixture: MenuFixtureApi } }

function Fixture() {
  const [open, setOpen] = useState(false)
  const [stream, setStream] = useState(0)
  const [clicks, setClicks] = useState(0)
  const [closedWith, setClosedWith] = useState(-1)
  const [draft, setDraft] = useState('未发送的优化草稿')
  const [rows, setRows] = useState(3)
  const [target, setTarget] = useState({ left: 930, top: 640 })
  const [refreshes, resize] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const listener = () => resize(value => value + 1)
    window.addEventListener('resize', listener)
    window.addEventListener('focus', listener)
    return () => { window.removeEventListener('resize', listener); window.removeEventListener('focus', listener) }
  }, [])
  useLayoutEffect(() => { if (open) inputRef.current?.focus() }, [open])
  window.menuFixture = {
    rerender: () => setStream(value => value + 1), rows: setRows, move: (left, top) => setTarget({ left, top }),
    snapshot: () => ({ open, stream, clicks, closedWith, draft, refreshes })
  }
  return <>
    <p id="stream">Synthetic streamed response {stream}</p>
    <button id="outside" style={{ position: 'fixed', left: 30, top: 40 }}>Outside target</button>
    <button id="menu-trigger" ref={triggerRef} style={{ position: 'fixed', left: target.left, top: target.top, width: 86, height: 32 }} onClick={() => setOpen(value => !value)}>Project menu</button>
    <MenuPortal open={open} triggerRef={triggerRef} onClose={() => { setClosedWith(stream); setOpen(false) }} width={260} maxHeight={Math.min(560, window.innerHeight - 16)} placement="bottom">
      <div id="synthetic-menu" role="menu">
        <input id="menu-draft" ref={inputRef} aria-label="Synthetic draft" value={draft} onChange={event => setDraft(event.target.value)} style={{ display: 'block', width: '100%', height: 34 }} />
        <button id="menu-action" role="menuitem" onClick={() => { setClicks(value => value + 1); setOpen(false) }} style={{ display: 'block', width: '100%', height: 32 }}>Save synthetic choice</button>
        {Array.from({ length: rows }, (_, i) => <div key={i} style={{ height: 30 }}>Synthetic project {i + 1}</div>)}
      </div>
    </MenuPortal>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
