import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: { alias: { '@teovo/server/testing': fileURLToPath(new URL('./packages/server/src/testing.ts', import.meta.url)), '@teovo/server/workers-ai': fileURLToPath(new URL('./packages/server/src/workers-ai.ts', import.meta.url)), '@teovo/server': src('server'), '@teovo/react': src('react'), '@teovo/db': src('db'), teovo: fileURLToPath(new URL('./packages/cli/src/cli.ts', import.meta.url)) } },
  test: { include: ['packages/*/src/**/*.test.{ts,tsx}'], fileParallelism: false },
})
