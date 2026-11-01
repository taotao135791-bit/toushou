import { ComponentType } from 'react'
import MermaidBlock from '../components/MermaidBlock'
import BoardDesignBlock from '../components/BoardDesignBlock'
import BoardCardsProposalBlock from '../components/BoardCardsProposalBlock'
import OfficeEditProposalBlock from '../components/OfficeEditProposalBlock'
import BoardHighlightsProposalBlock from '../components/BoardHighlightsProposalBlock'
import { BOARD_CARDS_FENCE } from '@shared/boardCards'
import { BOARD_DESIGN_FENCE } from '@shared/boardDesign'
import { OFFICE_EDIT_FENCE } from '@shared/officeEdit'
import { BOARD_HIGHLIGHTS_FENCE } from '@shared/boardHighlights'

/**
 * Fence-language → rich block renderer for Markdown code fences. Unknown
 * languages fall back to the plain CodeBlock, so adding a renderer
 * (vega, graphviz, …) is a one-line registration — Markdown.tsx untouched.
 */
export const richRenderers: Record<string, ComponentType<{ raw: string }>> = {
  mermaid: MermaidBlock,
  [BOARD_DESIGN_FENCE]: BoardDesignBlock,
  [BOARD_CARDS_FENCE]: BoardCardsProposalBlock,
  [BOARD_HIGHLIGHTS_FENCE]: BoardHighlightsProposalBlock,
  [OFFICE_EDIT_FENCE]: OfficeEditProposalBlock
}
