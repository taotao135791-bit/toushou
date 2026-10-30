import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BrowserPage from '../pages/BrowserPage'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useModalBoundary } from './modalBoundary'

function Nested({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useModalBoundary(ref, true, close)
  return <div ref={ref} role="dialog" tabIndex={-1} id="nested"><button id="nested-close" onClick={close}>nested close</button></div>
}
function Fixture() {
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  return <MemoryRouter><button id="opener" onClick={() => setOpen(true)}>open</button><button id="outside">outside</button>
    <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 560 }}><BrowserPage embedded initialUrl="https://example.invalid/" /></div>
    {open && <ConfirmDialog request={{ title: 'confirm fixture', body: 'fixture', onConfirm: () => undefined }} onClose={() => setOpen(false)} />}
    {open && <button id="nested-opener" onClick={() => setNested(true)}>nested opener</button>}
    {nested && <Nested close={() => setNested(false)} />}
  </MemoryRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
