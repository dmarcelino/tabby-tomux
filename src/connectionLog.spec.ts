// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { connectionLogLine, withConnectContext } from './connectionLog'

describe('connectionLogLine', () => {
    const ctx = { sessionLabel: 'SSH session #2', tabLabel: 'tab adopt @88' }

    it('names the session for the tab that opened the connection', () => {
        expect(connectionLogLine({ kind: 'opened' }, ctx)).toBe('tmux connection opened on SSH session #2 (tab adopt @88)')
    })

    it('names the connection\'s session, not the tab\'s own, for a tab that shares', () => {
        expect(connectionLogLine({ kind: 'shared', connectionSession: 'SSH session #1' }, ctx))
            .toBe('tmux connection shared, on SSH session #1 (tab adopt @88)')
        expect(connectionLogLine({ kind: 'shared' }, ctx))
            .toBe('tmux connection shared, on an unnamed SSH session (tab adopt @88)')
    })

    it('names the session for a failed opener, and only says "another tab\'s attempt" for a failed joiner', () => {
        const error = new Error('boom')
        expect(connectionLogLine({ kind: 'failed', openedHere: true, error }, ctx))
            .toBe('tmux connection failed on SSH session #2 (tab adopt @88): Error: boom')
        expect(connectionLogLine({ kind: 'failed', openedHere: false, error }, ctx))
            .toBe('tmux connection failed in another tab\'s attempt (tab adopt @88): Error: boom')
    })
})

describe('withConnectContext', () => {
    it('appends the session and tab to a warning from the connection', () => {
        expect(withConnectContext('tmux -V gave no output, trying once more (x)', { sessionLabel: 'SSH session #2', tabLabel: 'tab new' }))
            .toBe('tmux -V gave no output, trying once more (x) (SSH session #2, tab new)')
    })
})
