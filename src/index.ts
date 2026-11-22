// SPDX-License-Identifier: GPL-3.0-only
import { Injector, NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { LogService, ProfileProvider, TabRecoveryProvider } from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'
import { TomuxProfileSettingsComponent } from './components/profileSettings.component'
import { TomuxTabComponent } from './components/tomuxTab.component'
import { TomuxProfileProvider } from './profileProvider'
import { TomuxRecoveryProvider } from './recoveryProvider'
import { TomuxService } from './tomux.service'

/** Root Angular module that Tabby loads for the tomux plugin. */
@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule, TabbyTerminalModule],
    providers: [
        { provide: ProfileProvider, useExisting: TomuxProfileProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: TomuxRecoveryProvider, multi: true },
    ],
    declarations: [TomuxTabComponent, TomuxProfileSettingsComponent],
})
export default class TomuxModule {
    constructor (log: LogService, injector: Injector, tomux: TomuxService) {
        // Install the close-intent wrapper before any tab can close.
        tomux.tabComponent = TomuxTabComponent
        tomux.init()
        log.create('tomux').info('tomux plugin loaded')
        // Development hook: lets scripts attached through Chrome DevTools reach
        // Tabby's services. Only active when Tabby is started with TOMUX_DEV=1.
        if (process.env.TOMUX_DEV === '1') {
            (window as any).__tomuxDev = { injector, TomuxTabComponent, tomux }
        }
    }
}
