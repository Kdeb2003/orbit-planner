import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves the production build from /orbit-planner/ (a project
// page, not a user/org page), so every asset URL and the HashRouter's
// `import.meta.env.BASE_URL` (used by src/auth/authUrls.ts for auth email
// redirects) must carry that prefix. `vite build` and `vite preview` both use
// it (`vite preview` resolves with `command: 'serve'`, same as `vite dev`, so
// `isPreview` — not `command` — is what tells them apart); `npm run dev`
// keeps the default `/` so it still serves at http://localhost:5173/.
// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/orbit-planner/' : '/',
  plugins: [react(), tailwindcss()],
}))
