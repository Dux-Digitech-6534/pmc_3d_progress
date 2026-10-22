// After `vite build --mode frappe`: the built index.html becomes the Frappe www page /pmc-3d.
import { existsSync, renameSync, rmSync } from 'node:fs';
const from = '../pmc_3d_progress/public/frontend/index.html';
const to = '../pmc_3d_progress/www/pmc-3d.html';
if (existsSync(to)) rmSync(to);
renameSync(from, to);
console.log('Frappe page: pmc_3d_progress/www/pmc-3d.html (assets in pmc_3d_progress/public/frontend)');
