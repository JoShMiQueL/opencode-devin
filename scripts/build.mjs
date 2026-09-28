/**
 * Build `dist/` by swapping the whole directory, so the entrypoint is never
 * observed in a partial state.
 *
 * OpenCode watches a locally linked plugin and reloads it the moment the
 * entrypoint changes. Two failure modes come from getting this wrong, and both
 * have bitten this repository:
 *
 *   - `tsc` writes in place, truncating each file, so a reload mid-write fails.
 *   - Promoting files one rename at a time leaves `catalog.js` present while
 *     `constants.js` is still missing, so the reload fails to resolve a module.
 *
 * Compiling to a staging directory and swapping it in with two renames leaves
 * only a sub-millisecond gap, instead of one that spans the whole build.
 *
 * Stale files are not pruned: `build:clean` wipes the directory, and that is
 * what publishing uses, where a stale artefact would actually ship.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const OUT = "dist"
const STAGING = "dist.staging"
const RETIRED = "dist.retired"

const tsc = process.platform === "win32" ? "tsc.exe" : "tsc"
const build = spawnSync(join("node_modules", ".bin", tsc), ["--outDir", STAGING], { stdio: "inherit" })
if (build.status !== 0) {
  rmSync(STAGING, { recursive: true, force: true })
  process.exit(build.status ?? 1)
}

// Clear any leftovers from an interrupted previous run.
rmSync(RETIRED, { recursive: true, force: true })

if (existsSync(OUT)) renameSync(OUT, RETIRED)
renameSync(STAGING, OUT)
rmSync(RETIRED, { recursive: true, force: true })

const count = readdirSync(OUT).filter((entry) => statSync(join(OUT, entry)).isFile()).length
const nested = readdirSync(OUT).filter((entry) => statSync(join(OUT, entry)).isDirectory())
console.log(`built ${OUT}/ (${count} top-level files, ${nested.length} directories) via directory swap`)
