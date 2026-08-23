import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    web: 'src/web.ts',
    testing: 'src/testing.ts',
    react: 'src/react.ts',
    'react-dom': 'src/react-dom.ts',
    'jsx-runtime': 'src/jsx-runtime.ts',
    'jsx-dev-runtime': 'src/jsx-dev-runtime.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  splitting: false,
  // Published package: no maps. The sources are types plus thin host shims, so a
  // map buys nothing and `files` excludes them anyway.
  sourcemap: false,
  dts: true,
  clean: true,
})
