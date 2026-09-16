# Maintainer notes

Not shipped in the npm package, `files` in package.json excludes this directory
on purpose. Everything here describes how the SDK is built and released, which
is of no use to someone installing it and says more about the service than a
consumer needs to know.

## Proto drift

`proto/engine.proto` is a vendored copy of the engine's. Two guards keep it honest:

| command | catches | runs in CI |
| --- | --- | --- |
| `npm test` (`tests/ProtoSchema.test.ts`) | any change to the vendored schema, field added, removed, renamed, renumbered, retyped, or an RPC changed | yes |
| `npm run check:proto` | the **engine** moving ahead of this copy | no, the engine is a separate private repository |

`check:proto` finds the engine at `$PULSEINDEX_PROTO` or a sibling checkout and
skips (exit 0) when neither is present, so run it locally with the engine checked
out beside this repository before syncing the proto. It reports schema differences
semantically, and treats a comment-only difference as a warning rather than an error.

The client reads response fields by name with `?? default` fallbacks, so a field the
engine renames or removes is **silent at runtime**: the fallback simply wins. That
is why the schema fixture is asserted in full rather than spot-checked.


## Publishing

CI runs on every push and pull request to `main` against Node.js 20, 22, and 24. The published client still supports Node.js 18+; the test toolchain (Vitest / Vite 7) requires Node 20.19+.

To publish to npm, create a GitHub Release. The [publish workflow](.github/workflows/publish.yml) builds, tests, and runs `npm publish` using the `NPM_TOKEN` repository secret.

```bash
git tag v1.0.0
git push origin v1.0.0
gh release create v1.0.0 --title "v1.0.0" --generate-notes
```


## Development

```bash
npm install
npm test
npm run build
```

Unit tests cover `QueryBuilder` compilation, GeoHash precision / neighbors / bounding-box math, and `x-api-key` metadata. Integration tests spin up an in-process mocked gRPC `SearchEngineService`.

