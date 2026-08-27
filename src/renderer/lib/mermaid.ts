/**
 * Mermaid rendering service: lazy-loaded, serialized, theme-aware.
 *
 * mermaid.initialize() is global config — concurrent renders with different
 * themes would bleed into each other, so every render queues on one promise
 * chain and re-initializes for its own theme right before drawing.
 */

export interface MermaidRenderError {
  code: 'parse'
  message: string
}

type MermaidApi = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<MermaidApi> | null = null

/** Load mermaid once; the dynamic import keeps it out of the initial bundle. */
export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

let renderQueue: Promise<unknown> = Promise.resolve()
let renderSeq = 0

/**
 * Render mermaid source to SVG, serialized through the shared queue. Rejects
 * with a normalized { code: 'parse', message } on failure. The render can't be
 * cancelled — callers drop stale results themselves (generation token).
 */
export function renderMermaid(source: string, theme: 'dark' | 'light'): Promise<string> {
  const run = renderQueue.then(() => doRender(source, theme))
  // A failed render must not break the chain for the next one.
  renderQueue = run.catch(() => undefined)
  return run
}

async function doRender(source: string, theme: 'dark' | 'light'): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'neutral',
    securityLevel: 'strict',
    fontFamily: 'inherit'
  })
  const id = `omp-mmd-${++renderSeq}`
  try {
    const { svg } = await mermaid.render(id, source)
    return svg
  } catch (err) {
    const failure: MermaidRenderError = {
      code: 'parse',
      message: err instanceof Error ? err.message : String(err)
    }
    throw failure
  } finally {
    // mermaid.render sandboxes into <div id="d{id}"> and leaks it on errors
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}
