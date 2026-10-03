/**
 * Structural reader for `proto/engine.proto`.
 *
 * Deliberately dependency-free and small enough to review: `protobufjs` is only
 * a transitive dependency of `@grpc/proto-loader`, and depending on it directly
 * would break the moment that hoisting changes.
 *
 * Shared by `scripts/check-proto.mjs` (engine comparison) and
 * `tests/ProtoSchema.test.ts` (schema fixture), so the two can never disagree
 * about what the proto says.
 */

/**
 * @typedef {{ rpcs: string[], messages: Record<string, string[]>, enums: Record<string, string[]> }} ProtoSchema
 */

/**
 * @param {string} text
 * @returns {ProtoSchema}
 */
export function parseProtoSchema(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  /** @type {Record<string, string[]>} */ const messages = {};
  /** @type {Record<string, string[]>} */ const enums = {};
  /** @type {string[]} */ const rpcs = [];

  const rpcRe = /rpc\s+(\w+)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\(\s*([\w.]+)\s*\)/g;
  let m;
  while ((m = rpcRe.exec(src)) !== null) rpcs.push(`${m[1]}(${m[2]}) -> ${m[3]}`);

  /** @param {number} openBrace @returns {[number, number]} */
  const blockAt = (openBrace) => {
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return [openBrace + 1, i];
      }
    }
    throw new Error('unbalanced braces in engine.proto');
  };

  const msgRe = /\bmessage\s+(\w+)\s*\{/g;
  while ((m = msgRe.exec(src)) !== null) {
    const [start, end] = blockAt(m.index + m[0].length - 1);
    let body = src.slice(start, end);

    const enumRe = /\benum\s+(\w+)\s*\{([^}]*)\}/g;
    let em;
    while ((em = enumRe.exec(body)) !== null) {
      enums[`${m[1]}.${em[1]}`] = [...em[2].matchAll(/(\w+)\s*=\s*(\d+)\s*;/g)].map(
        (v) => `${v[1]}=${v[2]}`,
      );
    }
    body = body.replace(/\benum\s+\w+\s*\{[^}]*\}/g, '');

    // `map<k, v>` is matched explicitly. It used to fall outside `[\w.]+`, so a
    // map field was invisible to this guard, the same blind spot that once let
    // a customer RPC go missing from a vendored copy without failing anything.
    messages[m[1]] = [
      ...body.matchAll(
        /(repeated\s+)?(map\s*<\s*[\w.]+\s*,\s*[\w.]+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;/g,
      ),
    ].map(
      (f) =>
        `${f[4]}:${f[1] ? 'repeated ' : ''}${f[2].replace(/\s+/g, '').replace(',', ', ')} ${f[3]}`,
    );
  }

  return { rpcs, messages, enums };
}

/**
 * Human-readable semantic differences between two schemas. Immune to line
 * shifts, comment edits and reordering, it reports what actually changed.
 *
 * @param {ProtoSchema} expected @param {ProtoSchema} actual
 * @returns {string[]}
 */
export function diffProtoSchemas(expected, actual) {
  /** @type {string[]} */ const out = [];

  for (const rpc of expected.rpcs) if (!actual.rpcs.includes(rpc)) out.push(`- rpc removed: ${rpc}`);
  for (const rpc of actual.rpcs) if (!expected.rpcs.includes(rpc)) out.push(`+ rpc added:   ${rpc}`);

  const names = new Set([...Object.keys(expected.messages), ...Object.keys(actual.messages)]);
  for (const name of [...names].sort()) {
    const a = expected.messages[name];
    const b = actual.messages[name];
    if (!a) { out.push(`+ message added:   ${name}`); continue; }
    if (!b) { out.push(`- message removed: ${name}`); continue; }
    for (const f of a) if (!b.includes(f)) out.push(`- ${name}: lost  ${f}`);
    for (const f of b) if (!a.includes(f)) out.push(`+ ${name}: gained ${f}`);
  }

  const enumNames = new Set([...Object.keys(expected.enums), ...Object.keys(actual.enums)]);
  for (const name of [...enumNames].sort()) {
    const a = (expected.enums[name] ?? []).join(',');
    const b = (actual.enums[name] ?? []).join(',');
    if (a !== b) out.push(`~ enum ${name}: [${a}] -> [${b}]`);
  }

  return out;
}

/**
 * Check that `vendored` matches `engine`, apart from the RPCs named in
 * `omitted`.
 *
 * Present in the vendored copy only -> error; the client would call something
 *                                      the service does not implement.
 * Present in the engine only        -> error unless it is named in `omitted`,
 *                                      with its Request and Response messages.
 * Present in both but different     -> error, in either direction.
 *
 * An omission has to be named. Accepting any omission could not tell a
 * deliberate one from an RPC nobody remembered to vendor.
 *
 * @param {ProtoSchema} engine @param {ProtoSchema} vendored
 * @param {string[]} [omitted] RPC names the published copy leaves out
 * @returns {string[]}
 */
const rpcName = (rpc) => String(rpc).split('(')[0].trim();

export function diffProtoSubset(engine, vendored, omitted = []) {
  /** @type {string[]} */ const out = [];
  const omittedMessages = omitted.flatMap((r) => [`${r}Request`, `${r}Response`]);

  for (const rpc of vendored.rpcs) {
    if (!engine.rpcs.includes(rpc)) out.push(`+ rpc not in the engine: ${rpc}`);
  }

  for (const rpc of engine.rpcs) {
    if (vendored.rpcs.includes(rpc)) continue;
    if (omitted.includes(rpcName(rpc))) continue;
    out.push(`- rpc missing from the vendored copy: ${rpc}`);
  }

  for (const name of Object.keys(engine.messages).sort()) {
    if (vendored.messages[name]) continue;
    if (omittedMessages.includes(name)) continue;
    out.push(`- message missing from the vendored copy: ${name}`);
  }

  for (const name of Object.keys(vendored.messages).sort()) {
    const mine = vendored.messages[name];
    const theirs = engine.messages[name];
    if (!theirs) { out.push(`+ message not in the engine: ${name}`); continue; }
    for (const f of mine) if (!theirs.includes(f)) out.push(`+ ${name}: ${f} is not in the engine`);
    for (const f of theirs) if (!mine.includes(f)) out.push(`- ${name}: lost ${f}`);
  }

  for (const name of Object.keys(vendored.enums).sort()) {
    const mine = (vendored.enums[name] ?? []).join(',');
    const theirs = (engine.enums[name] ?? []).join(',');
    if (mine !== theirs) out.push(`~ enum ${name}: engine [${theirs}] vs vendored [${mine}]`);
  }

  return out;
}
