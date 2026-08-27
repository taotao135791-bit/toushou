import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { useAppStore } from './store'
import './index.css'

// E2E/debug handle for CDP driving. Development and explicitly-flagged E2E
// builds only — the store carries mutation actions, so production does not
// expose it. Enable in a packaged build by launching with OMP_GUI_E2E=1.
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  ;(window as unknown as { __store: typeof useAppStore }).__store = useAppStore
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
