// SPDX-License-Identifier: GPL-3.0-only
import { Component, OnInit } from '@angular/core'
import { PartialProfile, Profile, ProfileSettingsComponent, ProfilesService } from 'tabby-core'
import type { TomuxProfile } from '../profile'
import { sessionNameError } from '../sessionName'

/** Profile editor for tomux profiles: pick an SSH profile and a tmux session name. */
@Component({
    template: `
<div class="mb-3">
  <label>SSH connection</label>
  <select class="form-control" [(ngModel)]="profile.options.sshProfileId">
    <option value="" disabled>Choose an SSH profile…</option>
    <option *ngFor="let p of sshProfiles" [value]="p.id">{{ p.name }}</option>
  </select>
  <small class="text-muted" *ngIf="!sshProfiles.length">
    Create an SSH profile for the host first; tomux uses its login settings.
  </small>
  <small class="text-danger" *ngIf="sshProfiles.length && profile.options.sshProfileId && !selectedSshProfile">
    The SSH profile this tomux profile used no longer exists. Choose another one.
  </small>
</div>
<div class="mb-3">
  <label>tmux session name</label>
  <input class="form-control" type="text" [(ngModel)]="profile.options.sessionName" placeholder="main">
  <small class="text-danger" *ngIf="nameError">{{ nameError }}</small>
  <small class="text-muted" *ngIf="!nameError">
    tomux attaches to this session on the host, or creates it if it does not exist.
  </small>
</div>`,
})
export class TomuxProfileSettingsComponent implements ProfileSettingsComponent<TomuxProfile>, OnInit {
    profile!: TomuxProfile
    sshProfiles: PartialProfile<Profile>[] = []

    constructor (private profiles: ProfilesService) { }

    async ngOnInit (): Promise<void> {
        this.sshProfiles = (await this.profiles.getProfiles())
            .filter(p => p.type === 'ssh' && !p.isTemplate)
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    get selectedSshProfile (): PartialProfile<Profile> | undefined {
        return this.sshProfiles.find(p => p.id === this.profile.options.sshProfileId)
    }

    get nameError (): string | null {
        return sessionNameError(this.profile.options.sessionName ?? '')
    }

    save (): void {
        // Tabby's profile editor closes after save() returns; throwing keeps it open.
        const error = this.nameError
        if (error) {
            throw new Error(error)
        }
    }
}
