/**
 * "Confirm & Save to Calendar" is OFF unless this build/environment explicitly enables it
 * (`VITE_ENABLE_TIMETABLE_SAVE=true`). The provenance SQL is not deployed to the hosted project, so a default
 * build must never offer a Save button that writes through an unavailable backend. Even when enabled, the page
 * probes the server first and stays read-only when the import feature is not installed.
 */
export const TIMETABLE_SAVE_ENABLED: boolean = import.meta.env.VITE_ENABLE_TIMETABLE_SAVE === 'true'
