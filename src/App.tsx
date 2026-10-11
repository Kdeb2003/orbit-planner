import { Suspense, lazy } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AuthRoute, RequireAuth } from './auth/guards'
import { CalendarProvider } from './calendar/CalendarProvider'
import type { CloudApi } from './cloud/cloudApi'
import type { ImportApi } from './cloud/importApi'
import type { PlannerApi } from './cloud/plannerApi'
import { AppLayout } from './layouts/AppLayout'
import { isPlannerFeatureOn } from './planner/flag'
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage'
import { LoginPage } from './pages/auth/LoginPage'
import { RegisterPage } from './pages/auth/RegisterPage'
import { CalendarPage } from './pages/CalendarPage'
import { InsightsPage } from './pages/InsightsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StudyPlannerPage } from './pages/StudyPlannerPage'
import { TodayPage } from './pages/TodayPage'

// Loaded on demand (with PDF.js) so the calendar's main bundle does not grow for a page most visits never open.
const ImportTimetablePage = lazy(() => import('./pages/ImportTimetablePage').then((m) => ({ default: m.ImportTimetablePage })))

// Courses (Phase 4B): a separate chunk that exists only for builds with the feature on; its route is not even registered otherwise.
const CoursesPage = lazy(() => import('./pages/CoursesPage').then((m) => ({ default: m.CoursesPage })))

interface AppRoutesProps {
  createApi?: (userId: string) => CloudApi | null
  createImportApi?: () => ImportApi | null
  /** Tests inject an in-memory courses API, which also switches the feature on. */
  createPlannerApi?: (userId: string) => PlannerApi | null | Promise<PlannerApi | null>
}

export function AppRoutes({ createApi, createImportApi, createPlannerApi }: AppRoutesProps = {}) {
  const plannerOn = isPlannerFeatureOn(createPlannerApi)
  return (
    <CalendarProvider createApi={createApi} createImportApi={createImportApi} createPlannerApi={createPlannerApi}>
      <Routes>
        <Route path="login" element={<AuthRoute><LoginPage /></AuthRoute>} />
        <Route path="register" element={<AuthRoute><RegisterPage /></AuthRoute>} />
        <Route path="forgot-password" element={<AuthRoute><ForgotPasswordPage /></AuthRoute>} />
        <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<TodayPage />} />
          <Route path="calendar" element={<CalendarPage />} />

          <Route
            path="import-timetable"
            element={
              <Suspense fallback={<p role="status" className="py-6 text-sm text-muted">Loading…</p>}>
                <ImportTimetablePage />
              </Suspense>
            }
          />
          {plannerOn && <Route path="plan" element={<Navigate to="courses" replace />} />}
          {plannerOn && (
            <Route
              path="plan/courses"
              element={
                <Suspense fallback={<p role="status" className="py-6 text-sm text-muted">Loading…</p>}>
                  <CoursesPage />
                </Suspense>
              }
            />
          )}
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
