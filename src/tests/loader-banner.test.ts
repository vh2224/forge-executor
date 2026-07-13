import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GSD_PI_BRAND } from '../../dist/logo.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('first-run banner does not duplicate the brand name', () => {
  const source = readFileSync(join(projectRoot, 'src', 'loader.ts'), 'utf-8')

  // Extract the banner template line: `${bold}${GSD_PI_BRAND}${reset} ${dim}<literal>v${gsdVersion}...`
  const match = source.match(
    /\$\{bold\}\$\{GSD_PI_BRAND\}\$\{reset\}\s+\$\{dim\}([^$]*)v\$\{gsdVersion\}/,
  )
  assert.ok(match, 'expected to find the banner template line in src/loader.ts')

  const literalBetween = match[1]
  const rendered = `${GSD_PI_BRAND} ${literalBetween}v1.8.1`

  const occurrences = (rendered.match(/Forge/g) || []).length
  assert.equal(
    occurrences,
    1,
    `expected "Forge" to appear exactly once in the rendered banner, got: ${JSON.stringify(rendered)}`,
  )
})
