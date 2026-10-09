/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** 'false' hides the registration UI (cosmetic; real control is in the Supabase dashboard). */
  readonly VITE_ENABLE_SIGNUP?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
