// SPDX-License-Identifier: GPL-3.0-only
/**
 * The single place where tomux reaches into Tabby APIs that are not part of
 * a shared module or are marked @hidden. When a Tabby update breaks tomux,
 * this file is where to look first.
 *
 * Why tabby-ssh is loaded by path: Tabby shares its own instances of
 * @angular/*, rxjs, tabby-core, tabby-local, tabby-settings and
 * tabby-terminal with plugins, but not tabby-ssh. A plain require('tabby-ssh')
 * would resolve through Node's normal lookup and could find a second copy
 * (for example this repo's devDependency), whose classes are not the ones
 * Tabby's dependency injection knows. Tabby puts its built-in plugins folder
 * on Node's global module paths, so we load tabby-ssh from there by absolute
 * path; Node's module cache then returns the instance Tabby already loaded.
 */
import * as fs from 'fs'
import * as path from 'path'
import type * as TabbySsh from 'tabby-ssh'
import type { SSHTabComponent } from 'tabby-ssh/typings/components/sshTab.component'

/**
 * tabby-ssh's runtime exports. SSHTabComponent is exported at runtime since
 * Tabby 1.0.238 but missing from the newest published typings (1.0.231), so
 * its type comes from the declaration file directly.
 */
export type TabbySshModule = typeof TabbySsh & { SSHTabComponent: typeof SSHTabComponent }

// webpack replaces `require`; this is Node's real one, needed for runtime paths.
declare const __non_webpack_require__: NodeRequire

let cached: TabbySshModule | null = null

/** Returns Tabby's own, already-loaded tabby-ssh module. */
export function loadTabbySsh (): TabbySshModule {
    if (cached) {
        return cached
    }
    const Module = __non_webpack_require__('module')
    const searchPaths: string[] = Module.globalPaths ?? []
    for (const dir of searchPaths) {
        const candidate = path.join(dir, 'tabby-ssh')
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
            const mod = __non_webpack_require__(candidate) as TabbySshModule
            if (typeof mod.SSHTabComponent !== 'function' || typeof mod.SSHMultiplexerService !== 'function') {
                throw new Error('tomux: this Tabby version\'s tabby-ssh does not export SSHTabComponent and SSHMultiplexerService (needs Tabby 1.0.238 or newer)')
            }
            cached = mod
            return cached
        }
    }
    throw new Error('tomux: Tabby\'s tabby-ssh plugin was not found on the module search path')
}
