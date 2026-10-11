/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** 'false' hides the registration UI (cosmetic; real control is in the Supabase dashboard). */
  readonly VITE_ENABLE_SIGNUP?: string
  /** "true" adds Supabase Realtime on top of polling (needs the tables in the realtime publication). */
  readonly VITE_ENABLE_REALTIME?: string
  /** "true" enables Confirm & Save for timetable imports. Only for an environment whose database has the provenance migration (local Docker stack). Off by default. */
  readonly VITE_ENABLE_TIMETABLE_SAVE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
