/**
 * Where data lives.
 *  - 'local'  (npm run dev / build:standalone): everything in this browser, demo role switch.
 *  - 'frappe' (npm run build:frappe): served by the pmc_3d_progress Frappe app at /pmc-3d; data,
 *    files, roles and AI reading on the Frappe server.
 */
export const BACKEND: 'local' | 'frappe' = import.meta.env.VITE_BACKEND === 'frappe' ? 'frappe' : 'local';
export const IS_FRAPPE = BACKEND === 'frappe';
