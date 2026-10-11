/**
 * "Confirm & Save to Calendar" is OFF unless this build/environment explicitly enables it
 * (`VITE_ENABLE_TIMETABLE_SAVE=true`). The provenance SQL is applied to the hosted project (the production deploy
 * workflow enables the flag), but a default build must never offer a Save button that writes through a backend
 * that may lack it (local dev, forks, other deployments). Even when enabled, the page
 * probes the server first and stays read-only when the import feature is not installed.
 */
export const TIMETABLE_SAVE_ENABLED: boolean = import.meta.env.VITE_ENABLE_TIMETABLE_SAVE === 'true'
