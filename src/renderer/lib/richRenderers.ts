import { ComponentType } from 'react'
import MermaidBlock from '../components/MermaidBlock'

/**
 * Fence-language → rich block renderer for Markdown code fences. Unknown
 * languages fall back to the plain CodeBlock, so adding a renderer
 * (vega, graphviz, …) is a one-line registration — Markdown.tsx untouched.
 */
export const richRenderers: Record<string, ComponentType<{ raw: string }>> = {
  mermaid: MermaidBlock
}
