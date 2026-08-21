import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PanelBoundary } from './components/PanelBoundary'
import { GlobalErrors } from './components/GlobalErrors'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')

createRoot(el).render(
  <StrictMode>
    {/* Outside App, so a throw in the shell itself — the rail, the topbar, the tab bar
        — is caught too rather than taking the window with it. Not retryable at this
        level: re-rendering the thing that just failed to mount is not a recovery, and
        offering it would only produce the same dialog again. */}
    <PanelBoundary what="application" retryable={false}>
      <GlobalErrors />
      <App />
    </PanelBoundary>
  </StrictMode>,
)
