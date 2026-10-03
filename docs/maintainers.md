# Maintainer notes

Not shipped in the npm package: `files` in package.json leaves this directory out.

## Proto

`proto/engine.proto` is the service contract. Two checks keep it honest:

| command | catches |
| --- | --- |
| `npm test` (`tests/ProtoSchema.test.ts`) | any change to the schema: a field added, removed, renamed, renumbered or retyped, or an RPC changed |
| `npm run check:proto` | the service's contract moving ahead of this copy. Needs `PULSEINDEX_PROTO`, and skips without it |

The client reads response fields by name with `?? default` fallbacks, so a renamed
or removed field is silent at runtime. That is why the schema fixture is asserted
in full.

## Publishing

CI runs on every push and pull request to `main` against Node.js 20, 22 and 24.
The published client supports Node.js 18 and later; the test toolchain needs 20.19.

Bump `version` in package.json, then push a matching tag. The
[publish workflow](../.github/workflows/publish.yml) builds, tests and publishes
with provenance through npm Trusted Publishing.

```bash
git tag v8.0.0
git push origin v8.0.0
```

## Development

```bash
npm install
npm test
npm run build
```
