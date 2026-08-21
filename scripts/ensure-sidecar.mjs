/**
 * Refuse to start the app against a stale sidecar.
 *
 * `electron-vite dev` rebuilds the TypeScript and nothing else, so `npm run dev` would
 * happily launch a Go binary built days ago. That failure is silent and total: the
 * interface offers a feature the engine has never heard of, and the only symptom is
 * that nothing happens. It cost a debugging session — a fault armed, listed, and inert,
 * with every layer reporting success — and the same trap is waiting behind every future
 * change to sidecar/.
 *
 * So this runs as `predev` and rebuilds when anything the binary is made of is newer
 * than the binary. Go's build cache makes the no-op case nearly free; the alternative
 * is testing a version of the sidecar you stopped writing some edits ago.
 *
 * Node rather than bash because it is the one interpreter every dev machine running
 * `npm run dev` is guaranteed to have.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// electron-builder's naming, because that is what the binary directory uses and what
// the app looks for at runtime — see sidecarPath() in src/main/sidecar.ts.
const PLATFORM = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const EXE = 'xray-studio-sidecar' + (PLATFORM === 'win' ? '.exe' : '')
const BINARY = join(ROOT, '.build', 'bin', `${PLATFORM}-${ARCH}`, EXE)

/** Everything the binary is built from. A patch changes the linked core, so it counts. */
const SOURCES = [join(ROOT, 'sidecar'), join(ROOT, 'xray', 'PIN'), join(ROOT, 'xray', 'patches')]

function newestMtime(path) {
  let newest = 0
  const visit = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return // a path that does not exist cannot make anything stale
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) visit(join(p, entry))
      return
    }
    // Only what actually goes into the build. Without this every editor swapfile and
    // stray note under sidecar/ would trigger a rebuild.
    if (!/\.(go|mod|sum|patch)$|(^|[/\\])PIN$/.test(p)) return
    newest = Math.max(newest, st.mtimeMs)
  }
  visit(path)
  return newest
}

const binaryAt = existsSync(BINARY) ? statSync(BINARY).mtimeMs : 0
const sourceAt = Math.max(...SOURCES.map(newestMtime))

if (binaryAt >= sourceAt && binaryAt > 0) process.exit(0)

console.log(
  binaryAt === 0
    ? `• sidecar not built for ${PLATFORM}-${ARCH}, building it`
    : `• sidecar is older than sidecar/, rebuilding it`,
)

// Through the same script the release uses, so a dev build and a shipped build are
// produced by one code path and cannot disagree about flags or output location.
const built = spawnSync('bash', [join(ROOT, 'scripts', 'build-sidecar.sh'), PLATFORM, ARCH], {
  stdio: 'inherit',
  cwd: ROOT,
})

if (built.status !== 0) {
  console.error(
    '\n[31m✗[0m the sidecar did not build, so the app was not started.\n' +
      '  Starting anyway would have run the previous binary, which is how a change\n' +
      '  appears to have no effect at all.\n',
  )
  process.exit(built.status ?? 1)
}
