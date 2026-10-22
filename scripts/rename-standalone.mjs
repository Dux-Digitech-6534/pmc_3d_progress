// Renames the single-file build output to a clear name.
import { renameSync, existsSync, rmSync } from 'node:fs';
const out = 'standalone/PMC-3D-Progress.html';
if (existsSync(out)) rmSync(out);
renameSync('standalone/index.html', out);
console.log('Standalone app: ' + out);
