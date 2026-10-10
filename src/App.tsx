import { HashRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AuthRoute, RequireAuth } from './auth/guards'
import { CalendarProvider } from './calendar/CalendarProvider'
import type { CloudApi } from './cloud/cloudApi'
import { AppLayout } from './layouts/AppLayout'
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage'
import { LoginPage } from './pages/auth/LoginPage'
import { RegisterPage } from './pages/auth/RegisterPage'
import { CalendarPage } from './pages/CalendarPage'
import { InsightsPage } from './pages/InsightsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StudyPlannerPage } from './pages/StudyPlannerPage'
import { TodayPage } from './pages/TodayPage'

export function AppRoutes({ createApi }: { createApi?: (userId: string) => CloudApi | null } = {}) {
  return (
    <CalendarProvider createApi={createApi}>
      <Routes>
        <Route path="login" element={<AuthRoute><LoginPage /></AuthRoute>} />
        <Route path="register" element={<AuthRoute><RegisterPage /></AuthRoute>} />
        <Route path="forgot-password" element={<AuthRoute><ForgotPasswordPage /></AuthRoute>} />
        <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<TodayPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="study" element={<StudyPlannerPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<TodayPage />} />
        </Route>
      </Routes>
    </CalendarProvider>
  )
}

// HashRouter keeps routing working on GitHub Pages without server rewrites.
// Auth email links return to the site root with `?code=…` (query string, PKCE),
// so they never collide with the hash routes.
export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </HashRouter>
  )
}
