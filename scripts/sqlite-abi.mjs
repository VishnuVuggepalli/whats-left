#!/usr/bin/env node
/**
 * better-sqlite3 ships ONE compiled binary, but Node (vitest) and Electron
 * (the app) have different ABIs. Flip the installed binary between them:
 *
 *   npm run sqlite:node      → run tests (vitest)
 *   npm run sqlite:electron  → run the desktop app (npm run dev / electron .)
 *
 * Uses prebuild-install (bundled with better-sqlite3), downloads only —
 * never compiles. Pin electron to a major with published prebuilds
 * (https://github.com/WiseLibs/better-sqlite3/releases).
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const target = process.argv[2]
if (target !== 'node' && target !== 'electron') {
  console.error('usage: node scripts/sqlite-abi.mjs <node|electron>')
  process.exit(1)
}

const args = []
if (target === 'electron') {
  const electronVersion = require('electron/package.json').version
  args.push('--runtime', 'electron', '--target', electronVersion)
}

// better-sqlite3's "exports" map hides package.json from resolve — go by path.
// fileURLToPath (not .pathname) so Windows drive letters survive.
const { fileURLToPath } = await import('node:url')
const cwd = fileURLToPath(new URL('../node_modules/better-sqlite3/', import.meta.url))

// Run prebuild-install's JS entry with the current node binary directly:
// spawning npx.cmd breaks on Windows since Node's CVE-2024-27980 hardening
// (spawnSync .cmd without shell → EINVAL).
const bin = require.resolve('prebuild-install/bin.js', { paths: [cwd] })
execFileSync(process.execPath, [bin, ...args], { cwd, stdio: 'inherit' })
console.log(`better-sqlite3 binary now targets: ${target}`)
