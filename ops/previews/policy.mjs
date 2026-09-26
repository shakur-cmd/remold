import assert from 'node:assert/strict';

export const scope = Object.freeze({
  sha: '3db0e6ccdaab19bc7c996d759b1a06167a571503',
  accountId: '949fc86de7efe057aac100389701d2b4',
  worker: 'remold-i2-preview',
  subdomain: 'shakur-949.workers.dev',
  team: 'shakur-46299', project: 'remold', projectId: 3049070,
  clientId: 'client_01M3AAH302D3TVVDJN9SBNYARF',
});

export function assertPreviewConfig(config) {
  assert.equal(config.name, scope.worker, 'Dedicated preview Worker required');
  assert.equal(config.account_id, scope.accountId, 'Wrong Cloudflare account');
  assert.deepEqual(config.routes, [], 'Production routes forbidden');
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.previews, {}, 'No shared service bindings or base variables');
  assert.deepEqual(Object.keys(config).sort(), ['account_id', 'assets', 'compatibility_date', 'name', 'previews', 'routes', 'workers_dev'].sort(), 'Unexpected Worker configuration');
  assert.deepEqual(Object.keys(config.assets).sort(), ['directory', 'not_found_handling']);
  assert(typeof config.assets.directory === 'string' && config.assets.directory.startsWith('/'), 'Absolute artifact directory required');
  assert.equal(config.assets.not_found_handling, 'single-page-application');
}

export const candidateHeads = Object.freeze({3: '954bdfb792fcfcd8c857482cc174828f616d03eb', 4: '31c8434d140d4e241ea03b305c39a1a29d85fb9e'});

export function previewPlan(pr, sha = scope.sha) {
  assert(Number.isSafeInteger(pr) && pr > 0, 'Real positive PR number required');
  assert(sha === scope.sha || sha === candidateHeads[pr], 'Source commit is outside the exact rehearsal allowlist');
  const name = `pr-${pr}`;
  const origin = `https://${name}-${scope.worker}.${scope.subdomain}`;
  return { ...scope, format: 1, pr, sha, baseSha: scope.sha, name, origin, callback: `${origin}/callback` };
}

export function previewConfig(artifactDirectory) {
  assert(typeof artifactDirectory === 'string' && artifactDirectory.startsWith('/'), 'Absolute sealed artifact path required');
  const config = {
    name: scope.worker, account_id: scope.accountId,
    compatibility_date: '2026-09-21', workers_dev: true, routes: [],
    assets: { directory: artifactDirectory, not_found_handling: 'single-page-application' },
    previews: {},
  };
  assertPreviewConfig(config);
  return config;
}

export function childEnvironment(host, additions = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME']) {
    if (host[name] !== undefined) env[name] = host[name];
  }
  for (const name of Object.keys(additions)) {
    assert(['CONVEX_DEPLOY_KEY', 'WORKOS_CLIENT_ID', 'VITE_CONVEX_URL', 'VITE_WORKOS_CLIENT_ID', 'VITE_WORKOS_REDIRECT_URI', 'VITE_AUTH_SESSION_MODE'].includes(name), 'Unapproved child variable');
  }
  return { ...env, ...additions, WRANGLER_SEND_METRICS: 'false', CI: '1' };
}

export function workosChange(plan, current, action, owned = {}) {
  assert(['add', 'remove'].includes(action));
  assert.equal(current.clientId, scope.clientId, 'Wrong WorkOS environment');
  assert(Array.isArray(current.redirectUris) && Array.isArray(current.corsOrigins));
  const update = (values, value, kind) => action === 'add'
    ? [...new Set([...values, value])]
    : values.filter(entry => !(owned[kind] === true && entry === value));
  return {
    ...current,
    redirectUris: update(current.redirectUris, plan.callback, 'callback'),
    corsOrigins: update(current.corsOrigins, plan.origin, 'cors'),
    owned: action === 'add' ? {
      callback: owned.callback ?? !current.redirectUris.includes(plan.callback),
      cors: owned.cors ?? !current.corsOrigins.includes(plan.origin),
    } : owned,
  };
}

export function assertBackend(plan, backend) {
  assert.equal(backend.projectId, scope.projectId, 'Wrong Convex project');
  assert.equal(backend.deploymentType, 'preview', 'Only preview deployments are allowed');
  assert.equal(backend.kind, 'cloud');
  assert.equal(backend.isDefault, false, 'Default deployments are forbidden');
  assert.equal(backend.previewIdentifier, plan.name, 'Backend identifier differs from owned PR');
  assert(/^[a-z][a-z0-9-]+$/.test(backend.name), 'Invalid deployment name');
  assert.equal(backend.deploymentUrl, `https://${backend.name}.convex.cloud`);
  assert(Number.isSafeInteger(backend.id) && backend.id > 0);
}

export function reconcileBackend(plan, detail, deployments) {
  const matches = deployments.filter(row => row.id === detail.id);
  assert.equal(matches.length, 1, 'Exactly one project-list identity required');
  const listed = matches[0];
  assertBackend(plan, listed);
  assert.equal(listed.reference, `preview/${plan.name}`);
  for (const field of ['id', 'name', 'createTime', 'projectId', 'deploymentType', 'kind', 'isDefault', 'reference', 'deploymentUrl']) {
    assert.equal(detail[field], listed[field], `Deployment endpoints disagree on ${field}`);
  }
  // The deployment endpoint currently omits this value; the project list supplies it.
  assert(detail.previewIdentifier === null || detail.previewIdentifier === listed.previewIdentifier, 'Deployment identifiers disagree');
  return {...detail, previewIdentifier: listed.previewIdentifier};
}

export function frontendReceipt(plan, stdout, current) {
  // Wrangler 4.138 emits asset progress before its final JSON object.
  const start = stdout.search(/^\s*\{/m);
  assert(start >= 0, 'Wrangler JSON response missing');
  const returned = JSON.parse(stdout.slice(start));
  assert.equal(returned.preview.id, current.id, 'Frontend provider identity differs');
  assert.equal(returned.preview.name, plan.name);
  assert.equal(current.name, plan.name);
  assert.equal(current.worker, scope.worker);
  assert.equal(current.accountId, scope.accountId);
  assert.deepEqual(returned.preview.urls, [plan.origin]);
  assert.equal(returned.deployment.annotations['workers/message'], `I2 PR${plan.pr} ${plan.sha}`);
  return {...current, absentBefore: true};
}

export function assertFrontendReplacement(plan, receipt, current, id) {
  assert.equal(receipt.cloudflare?.absentBefore, true);
  assert.equal(receipt.cloudflare.id, id);
  assert.deepEqual(current, {id, name: plan.name, worker: scope.worker, accountId: scope.accountId}, 'Only the exact owned preview may be replaced');
}

export function assertBackendRecovery(plan, receipt, backend, name, id) {
  assert.equal(receipt.phase, 'backend-attempted');
  assert.equal(receipt.backendAbsentBefore, true);
  assert.equal(receipt.backend, null);
  assert(!receipt.clientIdVerified);
  assertBackend(plan, backend);
  assert.equal(backend.name, name);assert.equal(backend.id, id);
  const elapsed = backend.createTime - Date.parse(receipt.attemptedAt);
  assert(elapsed >= -5000 && elapsed <= 600000, 'Allocation is outside the original attempt');
}

export function cleanupPlan(plan, receipt, currentBackend, currentWorkos, currentCloudflare) {
  assert.deepEqual(receipt.plan, plan, 'Receipt must match the reviewed plan');
  assert.equal(receipt.backendAbsentBefore, true, 'Pre-existing backend is not owned');
  assertBackend(plan, receipt.backend);
  if (currentBackend !== null) {
    assertBackend(plan, currentBackend);
    for (const field of ['id', 'name', 'createTime', 'deploymentUrl']) {
      assert.equal(currentBackend[field], receipt.backend[field], 'Backend identity changed; manual reconciliation required');
    }
  }
  const owned = receipt.cloudflare;
  assert.equal(owned?.absentBefore, true, 'Pre-existing Cloudflare preview is not owned');
  assert.equal(owned.accountId, scope.accountId);
  assert.equal(owned.worker, scope.worker);
  assert.equal(owned.name, plan.name);
  assert(typeof owned.id === 'string' && owned.id.length > 0, 'Provider preview identity required');
  if (currentCloudflare !== null) {
    for (const field of ['id', 'accountId', 'worker', 'name']) {
      assert.equal(currentCloudflare?.[field], owned[field], 'Cloudflare preview identity changed');
    }
  }
  const workos = workosChange(plan, currentWorkos, 'remove', receipt.workosOwned);
  return {
    cloudflare: currentCloudflare === null ? null : { worker: scope.worker, preview: plan.name, id: owned.id },
    convex: currentBackend === null ? null : { method: 'POST', path: `/deployments/${currentBackend.name}/delete` },
    workos,
  };
}

export function convexEnvironment(host,key) {
  assert(typeof key === 'string' && key.startsWith(`preview:${scope.team}:${scope.project}|`) && key.split('|').length === 2 && key.split('|')[1].length > 0 && !/\s/.test(key), 'Expected project preview-only credential');
  // Convex 1.46 otherwise prefers the saved personal login over a preview key.
  return {...childEnvironment(host,{CONVEX_DEPLOY_KEY:key}),CONVEX_OVERRIDE_ACCESS_TOKEN:key};
}
