// Generated from knightseye-net/tools/release-tooling; edit the canonical template and sync.
import { assertReleaseTooling } from './check-release-tooling.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function npmFailure(result) {
  let error;
  for (const output of [result.stdout, result.stderr]) {
    try { const parsed = JSON.parse(output || '{}'); error ||= parsed.error; } catch {}
  }
  const allowed = new Set(['EOTP', 'E401', 'E403', 'E404', 'E409', 'E422', 'E429', 'E500', 'E502', 'E503', 'E504', 'EPROVENANCE', 'EUSAGE', 'ENEEDAUTH', 'ENOTP', 'EPRIVATE', 'EPUBLISHCONFLICT', 'EUNSCOPED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
  const candidate = typeof error?.code === 'string' ? error.code : (result.stderr || '').match(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9]+)\s*$/m)?.[1];
  const code = allowed.has(candidate) ? candidate : 'UNKNOWN';
  const rawStatus = error?.statusCode ?? error?.status ?? (/^E[45]\d\d$/.test(code) ? Number(code.slice(1)) : undefined);
  const httpStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 'unknown';
  const exitStatus = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : 'unknown';
  return {code, httpStatus, exitStatus};
}
export function publishReviewed({root, version, sha256, env = process.env, run = spawnSync, wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/dev') throw Error('Publishing requires manual GitHub Actions dispatch on dev');
  if (env.GITHUB_REPOSITORY_VISIBILITY !== 'public') throw Error('Provenance publishing requires a public GitHub repository');
  if (!env.NODE_AUTH_TOKEN?.trim()) throw Error('Missing NODE_AUTH_TOKEN; publication has no authentication fallback');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version || '') || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw Error('Expected reviewed exact version and SHA-256');
  const source = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (source.version !== version) throw Error('Reviewed version does not match source version');
  const archive = path.join(root, 'artifacts', `${source.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  const bytes = readFileSync(archive);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('Reviewed archive SHA-256 mismatch');
  const options = { cwd: root, encoding: 'utf8', env };
  const metadataResult = run('tar', ['-xOf', archive, 'package/package.json'], options);
  if (metadataResult.status !== 0) throw Error(metadataResult.stderr || 'Archive inspection failed');
  const pkg = JSON.parse(metadataResult.stdout);
  if (pkg.name !== source.name || pkg.version !== version || pkg.private || pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' || pkg.publishConfig?.tag !== 'next') throw Error('Expected reviewed staged registry candidate');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const lookupArgs = ['view', `${pkg.name}@${version}`, '--json', '--registry', 'https://registry.npmjs.org/'];
  const lookupOptions = { ...options, timeout: 15000 };
  const lookup = run('npm', lookupArgs, lookupOptions);
  if (lookup.status === 0) {
    const existing = JSON.parse(lookup.stdout);
    if (existing.name !== pkg.name || existing.version !== version || existing.dist?.integrity !== integrity) throw Error('Published version exists with different identity or integrity');
    return { name: pkg.name, version, sha256, integrity, published: false, alreadyPublished: true, registryConfirmed: true };
  }
  let error;
  try { error = JSON.parse(lookup.stdout || '{}').error; } catch {}
  if (error?.code !== 'E404') throw Error('Registry lookup failed; refusing publication');
  const result = run('npm', ['publish', archive, '--ignore-scripts', '--access', 'public', '--tag', 'next', '--registry', 'https://registry.npmjs.org/', '--provenance', '--json'], options);
  if (result.status !== 0) {
    const {code, httpStatus, exitStatus} = npmFailure(result);
    throw Error(`npm publish failed for ${pkg.name}@${version}: code=${code}, httpStatus=${httpStatus}, exitStatus=${exitStatus}`);
  }
  let visible = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) wait();
    const confirmation = run('npm', lookupArgs, lookupOptions);
    if (confirmation.status === 0) {
      let existing;
      try { existing = JSON.parse(confirmation.stdout); } catch {}
      if (existing?.name !== pkg.name || existing?.version !== version || existing?.dist?.integrity !== integrity) throw Error('Postpublication registry identity or integrity mismatch');
      visible = true;
      break;
    }
  }
  if (!visible) throw Error(`npm publication returned success but registry confirmation failed for ${pkg.name}@${version}; publication was not retried`);
  return { name: pkg.name, version, sha256, integrity, published: true, alreadyPublished: false, registryConfirmed: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertReleaseTooling();
  console.log(JSON.stringify(publishReviewed({root: fileURLToPath(new URL('../', import.meta.url)), version: process.argv[2], sha256: process.argv[3]})));
}
