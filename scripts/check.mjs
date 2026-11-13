import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function check() {
  const read = name => readFile(path.join(root, name), 'utf8');
  const manifest = JSON.parse(await read('manifest.json'));
  const pkg = JSON.parse(await read('package.json'));
  const files = JSON.parse(await read('scripts/package-files.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version, 'package.json and manifest.json versions must match');
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert(manifest.version.split('.').every(n => Number(n) <= 65535), 'Invalid Chrome version');
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Release tag must match manifest version');
  }
  assert.equal(new Set(files).size, files.length, 'Duplicate packaged file');
  for (const file of files) {
    assert(!file.startsWith('/') && !file.includes('..') && !file.includes('\\'), `Unsafe package path: ${file}`);
    assert((await readFile(path.join(root, file))).length > 0, `Empty file: ${file}`);
  }
  const included = file => assert(files.includes(file), `Missing runtime asset in ZIP: ${file}`);
  included(manifest.background.service_worker);
  included(manifest.action.default_popup);
  Object.values(manifest.icons).forEach(included);
  Object.values(manifest.action.default_icon).forEach(included);
  manifest.content_scripts.flatMap(script => script.js).forEach(included);
  for (const file of files.filter(f => /\.(html|js)$/.test(f))) {
    const source = await read(file);
    const refs = file.endsWith('.html')
      ? [...source.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1])
      : [...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
    refs.forEach(ref => included(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref))));
  }
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(path.join(root, manifest.icons[size]));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const jsFiles = files.filter(f => f.endsWith('.js'));
  for (const dir of ['scripts', 'tests']) {
    for (const file of await readdir(path.join(root, dir))) {
      if (/\.(mjs|js)$/.test(file)) jsFiles.push(`${dir}/${file}`);
    }
  }
  for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.error || 'Syntax check failed'}`);
  }
  console.log(`Validated ClipHawk ${manifest.version}: ${files.length} package files and ${jsFiles.length} scripts.`);
  return { manifest, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await check();
