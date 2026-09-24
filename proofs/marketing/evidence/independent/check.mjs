import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker, directory, prefix} from '../../runtime.mjs';
const read = path => JSON.parse(readFileSync(directory + path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = read('evidence/source-manifest.json');
for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(directory + path)), expected, path);
const plugin = {};
for (const [path, expected] of Object.entries(manifest.files).filter(([p]) => p.startsWith('plugin/'))) {
  const relative = path.slice(7), remote = '/var/www/html/docroot/plugins/RemoldGuardBundle/' + relative;
  plugin[relative] = hash(docker(['exec', prefix + '-web-a', 'cat', remote]));
  assert.equal(plugin[relative], expected, 'Installed plugin: ' + relative);
  docker(['exec', prefix + '-web-a', 'php', '-l', remote]);
}
const bridgeHash = hash(docker(['exec', prefix + '-bridge', 'cat', '/bridge.mjs']));
assert.equal(bridgeHash, manifest.files['bridge.mjs']);
const provenance = read('evidence/runtime-provenance.json');
for (const [path, expected] of Object.entries(provenance.coreFileHashes)) {
  assert.equal(hash(docker(['exec', prefix + '-web-a', 'cat', '/var/www/html/docroot/' + path])), expected, 'Pinned runtime core: ' + path);
}
const config = read('private/bridge-config.json');
const installedConfig = docker(['exec', prefix + '-bridge', 'cat', '/config.json']);
assert(!installedConfig.includes(config.fixture.A.sessions.owner), 'Owner credential must not be in engine config');
assert.deepEqual(Object.keys(JSON.parse(installedConfig).fixture.A.sessions), ['child']);
assert.equal(docker(['network', 'inspect', '--format', '{{.Internal}}', prefix]).trim(), 'true');
const safety = read('evidence/safety.json');
assert.deepEqual(safety.results.map(r => [r.scenario, r.deliveries, r.operationState]), [['unapproved',0,'proposed'],['deliver',1,'confirmed'],['revoke',0,'paused'],['kill',0,'outcomeUnknown']]);
assert.equal(safety.results.find(r => r.scenario === 'kill').workerKilled, true);
const killedLog = safety.results.find(r => r.scenario === 'kill').nativeLog;
assert(Number.isSafeInteger(killedLog) && killedLog > 0);
const triggered = docker(['exec', prefix + '-db-a', 'sh', '-c', 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"', '--', 'SELECT (date_triggered IS NOT NULL) FROM campaign_lead_event_log WHERE id=' + killedLog]).trim();
assert.equal(triggered, '1', 'Native triggered accounting must not be mistaken for provider confirmation');
const branch = read('evidence/native-branch.json');
assert.equal(branch.checks.finalDeliveries, 2);
assert.equal(branch.checks.readBefore, 0);
assert.equal(branch.checks.readAfter, 1);
assert.deepEqual(branch.authorityStates, ['confirmed', 'confirmed']);
assert(read('evidence/reentry.json').checks.oneReentryReceipt);
assert.equal(read('evidence/api-boundary-green.json').unapprovedAccepted, 0);
const result = {checkedAt:new Date().toISOString(),status:'PASS bounded local replay only',source:manifest.aggregateSha256,sourceFiles:Object.keys(manifest.files).length,pluginHashes:plugin,bridgeHash,pinnedCoreFilesMatched:Object.keys(provenance.coreFileHashes).length,ownerCredentialAbsent:true,engineSessionKeys:['child'],internalNetwork:true,nativeTriggeredAfterKill:true,sevenBehaviorGroups:true,remaining:'Full P2/S4 and D0M remain open. No real mail.'};
writeFileSync(directory + 'evidence/independent/after-check.json', JSON.stringify(result,null,2)+'\n');
console.log('PASS 41 frozen files, installed plugin/bridge, PHP syntax, engine credential scope, internal network and seven behavior groups.');
