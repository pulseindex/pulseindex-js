// Phase 6 acceptance probe, run against PRODUCTION with a real customer key.
//
//   PI_KEY='pix_...' node scripts/phase6-probe.mjs
//
// The key is read from the environment and never written to disk or printed.
// Prefix the command with a space to keep it out of shell history.
//
// What each check proves, and why reading the code was not enough:
//
//   index/search/delete  the scope selected in the dashboard actually reaches
//                        the engine and is honoured per RPC
//   getRecoveryState     `admin` is refused for every tenant-bound key, by
//                        design, no customer key can ever call it
//   health()             consequence of the above: the SDK's health check is
//                        built on an RPC customers are not allowed to make

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PulseIndexClient } = require('../dist/index.js');

const key = process.env.PI_KEY;
if (!key) {
  console.error('Set PI_KEY to the plaintext API key shown once at creation.');
  process.exit(1);
}

const ENTITY = 999000001;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => console.log(`  FAIL  ${m}`);

const client = new PulseIndexClient({
  endpoint: 'api.usepulseindex.com:50051',
  ssl: true,
  apiKey: key,
  timeoutMs: 15000,
});

const err = (e) => `${e.constructor.name}: ${String(e.message).slice(0, 90)}`;

console.log('\nPhase 6, production acceptance\n');

// 1. index
try {
  await client.index(ENTITY, { categories: ['probe'], price: 1 });
  pass('index, entity written');
} catch (e) {
  fail(`index, ${err(e)}`);
}

// 2. search
try {
  const r = await client.search({ must: 'probe', limit: 5 });
  r.totalMatches > 0
    ? pass(`search, ${r.totalMatches} match(es), ${r.executionTimeUs}us`)
: fail('search, returned 0 matches for an entity just written');
} catch (e) {
  fail(`search, ${err(e)}`);
}

// 3. delete
try {
  await client.delete(ENTITY);
  pass('delete, entity removed');
} catch (e) {
  fail(`delete, ${err(e)}`);
}

// 4. admin is refused for tenant-bound keys, a rejection here is CORRECT
try {
  await client.getRecoveryState();
  fail('getRecoveryState. SUCCEEDED, but admin must be refused for a customer key');
} catch (e) {
  /PermissionDenied|permission|scope|denied/i.test(e.message)
    ? pass(`getRecoveryState, correctly refused (${err(e)})`)
: fail(`getRecoveryState, refused for the wrong reason: ${err(e)}`);
}

// 5. the consequence
const healthy = await client.health();
healthy
  ? fail('health(), returned true, which contradicts check 4')
: console.log(`  KNOWN health(), returned false. Not a broken deployment: it is
        built on getRecoveryState, which check 4 shows no customer
        key may call. The SDK needs a health check that does not
        require admin.`);

console.log('');
process.exit(0);
