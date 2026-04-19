import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const powershellScript = resolve(scriptDir, 'prebuild-cleanup.ps1');
const result = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellScript],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
