/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set at build time to expose the E2E store handle in packaged builds. */
  readonly VITE_E2E?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
