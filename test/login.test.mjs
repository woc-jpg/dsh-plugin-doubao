/**
 * Tests for the standalone sign-in CLI: the no-conversation, no-harness entry
 * point users run right after install. Spawn it as a child so --status and the
 * "already signed in" short-circuit are exercised exactly as shipped, with a
 * temporary DSH_HOME so the real credential store is never touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const loginJs = join(here, '..', 'bin', 'login.js')
const node = process.execPath

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'doubao-login-cli-'))
}

function run(args, home, timeout = 10000) {
  return spawnSync(node, [loginJs, ...args], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, DSH_HOME: home, DOUBAO_LOGIN_PORT: '0' },
  })
}

test('--status reports not signed in with a clean home', () => {
  const home = freshHome()
  try {
    const r = run(['--status'], home)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Not signed in/)
    assert.match(r.stdout, /--force|dsh-plugin-doubao/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--status prints device and a real expiry from a stored credential', () => {
  const home = freshHome()
  try {
    const dir = join(home, 'doubao-local')
    mkdirSync(dir, { recursive: true })
    // sid_guard shape: id|createdEpoch|durationSeconds|ExpiryDateGMT
    // field[1] is CREATION, field[3] is the real expiry — a regression here
    // once reported "expired" 30 days early.
    const cookies =
      'ttwid=1%7Cabc; sid_guard=deadbeef%7C1763059764%7C2592000%7CMon%2C+14-Dec-2026+09%3A29%3A24+GMT; sessionid=xyz'
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ cookies, identity: { deviceId: '1708008151711915' } }),
      'utf8',
    )
    const r = run(['--status'], home)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Signed in:/)
    assert.match(r.stdout, /Device:\s+1708008151711915/)
    assert.match(r.stdout, /Expires:\s+2026-12-14/)
    assert.doesNotMatch(r.stdout, /EXPIRED/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('running with an existing credential does not start a server', () => {
  const home = freshHome()
  try {
    const dir = join(home, 'doubao-local')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ cookies: 'sessionid=x', identity: { deviceId: 'dev-1' } }),
      'utf8',
    )
    const r = run([], home, 8000)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /--force/)
    assert.doesNotMatch(r.stdout, /Open http/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the Windows launcher is a sibling of login.js and is CRLF/GBK-clean', () => {
  const bat = join(here, '..', 'bin', 'login.bat')
  const raw = readFileSync(bat)
  assert.ok(raw.length > 0)
  assert.equal(raw.includes('\r\n'), true, 'must use CRLF line endings')
  const bareLf = raw.toString('binary').replace(/\r\n/g, '').includes('\n')
  assert.equal(bareLf, false, 'no bare LF')
  assert.equal(raw[0], 0x40, 'starts with @, no BOM')
  assert.match(raw.toString('latin1'), /login\.js/)
})
