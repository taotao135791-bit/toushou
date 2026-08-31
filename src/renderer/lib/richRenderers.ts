import { ComponentType } from 'react'
import MermaidBlock from '../components/MermaidBlock'
import BoardDesignBlock from '../components/BoardDesignBlock'
import { BOARD_DESIGN_FENCE } from '@shared/boardDesign'

/**
 * Fence-language → rich block renderer for Markdown code fences. Unknown
 * languages fall back to the plain CodeBlock, so adding a renderer
 * (vega, graphviz, …) is a one-line registration — Markdown.tsx untouched.
 */
export const richRenderers: Record<string, ComponentType<{ raw: string }>> = {
  mermaid: MermaidBlock,
  [BOARD_DESIGN_FENCE]: BoardDesignBlock
}
