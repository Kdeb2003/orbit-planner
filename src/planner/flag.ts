/**
 * Courses (Phase 4B.1b) are OFF unless this build/environment explicitly enables them
 * (`VITE_ENABLE_PLANNER_COURSES=true`). The courses migration is NOT applied to the hosted project, and the
 * production deploy workflow pins this flag to 'false'. With the flag off the app never builds a request to the
 * courses table and behaves exactly as before. The flag only hides functionality; Row Level Security is the real
 * access control.
 */
export const PLANNER_COURSES_ENABLED: boolean = import.meta.env.VITE_ENABLE_PLANNER_COURSES === 'true'

/**
 * Is the Courses feature on for this app instance? A provider that is handed a planner API (tests) counts as on;
 * otherwise only the build flag decides. Used by the routes, the navigation and the provider so they always agree.
 */
export const isPlannerFeatureOn = (injected: unknown): boolean => injected !== undefined || PLANNER_COURSES_ENABLED
