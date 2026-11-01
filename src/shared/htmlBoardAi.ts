import type { HtmlBoardTemplate } from './htmlBoard'

/** The instruction is sent to the configured model; do not include private data. */
export interface HtmlBoardAiInput { id: string; expectedRevision: number; instruction: string; requestId: string; modelSelector?: string }
export interface HtmlBoardAiProposal { html: string; css: string; theme: HtmlBoardTemplate; baseRevision: number }
export type HtmlBoardAiError = 'invalid-input' | 'not-found' | 'conflict' | 'store-unreadable' | 'unavailable' | 'invalid-output' | 'failed' | 'cancelled' | 'timeout' | 'busy' | 'sensitive-content'
export type HtmlBoardAiResult = { ok: true; proposal: HtmlBoardAiProposal } | { ok: false; error: HtmlBoardAiError }
