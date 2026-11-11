import { spawnSync } from 'node:child_process';
import { check, root } from './check.mjs';

await check();
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/package.ps1'], {
  cwd: root, stdio: 'inherit'
});
if (result.error) throw new Error(`Packaging requires PowerShell (built into Windows; PowerShell 7 on Linux/macOS): ${result.error.message}`);
if (result.status !== 0) process.exit(result.status || 1);
