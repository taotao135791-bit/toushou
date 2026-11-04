/** Renderer receives only bounded, validated PNG/ICO data, never a remote URL or markup. */
export type SiteIconResult = { ok: true; dataUrl: string } | { ok: false }
