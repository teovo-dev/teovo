// Runs before `npm pack` / `npm publish` in each package: puts the repository's LICENSE in the package (npm only
// ships files inside the package folder). The copies are git-ignored.
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

copyFileSync(fileURLToPath(new URL('../LICENSE', import.meta.url)), 'LICENSE')
