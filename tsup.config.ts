import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // Off deliberately. A source map embeds `sourcesContent`: the complete
  // TypeScript source of every file in the bundle, and the two maps were 59%
  // of the published tarball. The shipped JavaScript is unminified and readable
  // on its own, so a stack trace still lands somewhere useful; what the maps
  // added was a second, verbatim copy of the original source for anyone who ran
  // `npm pack`. Flip this on locally if you need to step through `dist/`.
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: 'node18',
  platform: 'node',
  shims: true,
  external: ['@grpc/grpc-js', '@grpc/proto-loader'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.js',
    };
  },
});
