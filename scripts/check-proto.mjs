#!/usr/bin/env node
/**
 * Compare the vendored `proto/engine.proto` against the engine's own copy.
 *
 * This is the only check that can detect the engine moving ahead of this SDK.
 * It needs the engine's proto, so it SKIPS (exit 0) when PULSEINDEX_PROTO is
 * not set. Structural drift within this repository is covered unconditionally
 * by `tests/ProtoSchema.test.ts`.
 *
 *   PULSEINDEX_PROTO=/path/to/engine.proto \
 *   PULSEINDEX_PROTO_OMIT=RpcA,RpcB npm run check:proto
 *
 * PULSEINDEX_PROTO_OMIT names the RPCs the published copy leaves out on
 * purpose. Any other RPC missing from it is an error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffProtoSubset, parseProtoSchema } from './protoSchema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'proto', 'engine.proto');

const source = process.env.PULSEINDEX_PROTO;
if (!source) {
  console.log('note: PULSEINDEX_PROTO is not set, skipping the engine comparison.');
  console.log('      tests/ProtoSchema.test.ts still guards the vendored schema itself.');
  process.exit(0);
}
// A configured path that does not exist is a misconfiguration, not a skip.
if (!existsSync(source)) {
  console.error(`error: PULSEINDEX_PROTO is set to a path that does not exist: ${source}`);
  process.exit(1);
}

const omitted = (process.env.PULSEINDEX_PROTO_OMIT ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const engineText = readFileSync(source, 'utf8');
const vendorText = readFileSync(VENDORED, 'utf8');

const schemaDiff = diffProtoSubset(
  parseProtoSchema(engineText),
  parseProtoSchema(vendorText),
  omitted,
);

if (schemaDiff.length > 0) {
  console.error('error: vendored proto/engine.proto is out of sync with the engine.');
  console.error('');
  console.error('       schema differences (engine -> vendored):');
  for (const line of schemaDiff) console.error(`         ${line}`);
  console.error('');
  console.error('       fix: bring the vendored declarations back in line with the engine,');
  console.error('       then update the fixture in tests/ProtoSchema.test.ts so the change is');
  console.error('       visible in review, and check whether PulseIndexClient must read any');
  console.error('       new or renamed field: it reads by name with `?? default` fallbacks,');
  console.error('       so a missed field is silent at runtime.');
  process.exit(1);
}

console.log('ok: every declaration in the vendored proto matches the engine');
