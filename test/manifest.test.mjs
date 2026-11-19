/**
 * Guard against the one packaging mistake that fails silently and looks like a
 * broken install rather than a broken file.
 *
 * DSH's profile loader reads every bundle's `package.json` with `JSON.parse`. A
 * leading UTF-8 byte-order mark makes that throw a `SyntaxError`, the loader
 * catches the throw and skips the whole bundle, and the plugin never runs — no
 * model in the picker, no error in the UI, no line in any log. 0.2.5 shipped
 * exactly that. These tests fail loudly instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = join(root, 'package.json')

test('package.json has no byte-order mark', () => {
  const bytes = readFileSync(manifestPath)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  assert.equal(hasBom, false, 'a BOM in package.json makes DSH silently skip the bundle')
})

test('package.json parses as strict JSON straight off disk', () => {
  // Deliberately no `.replace(/^\uFEFF/, '')` — that is the workaround the
  // loader does not apply.
  const text = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(text)
  assert.equal(manifest.name, 'dsh-plugin-doubao')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
})

test('the bundle entry point and client bundle both exist', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(readFileSync(join(root, 'cordis.patch.yml'), 'utf8').includes('dsh-plugin-doubao'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(readFileSync(join(root, 'lib', 'client.js'), 'utf8').length > 0, true)
})

test('every file the README embeds is published', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = manifest.files
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const localRefs = [...readme.matchAll(/!?\[[^\]]*\]\((?!https?:|#)([^)\s]+)\)/g)]
    .map((m) => m[1])
    // A bare "..." is prose inside a blockquote, not a path; require a real
    // extension or a directory separator.
    .filter((p) => !/^\.+$/.test(p) && (p.includes('/') || /\.[a-z0-9]{1,5}$/i.test(p)))
  for (const ref of localRefs) {
    const top = ref.split('/')[0]
    assert.ok(
      files.includes(top),
      `README links ${ref} but "files" does not publish "${top}" — the link is dead on npm`,
    )
  }
})

test('no published source file carries a byte-order mark', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dirs = manifest.files.filter((f) => f === 'lib' || f === 'bin')
  const offenders = []
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir))) {
      if (!/\.(js|mjs|json|yml)$/.test(name)) continue
      const bytes = readFileSync(join(root, dir, name))
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offenders.push(`${dir}/${name}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
