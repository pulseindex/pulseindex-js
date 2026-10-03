import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // Off: a map embeds the full source. The shipped JavaScript is unminified
  // and readable on its own.
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
