// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest'
import { sessionNameError } from './sessionName'

describe('sessionNameError', () => {
    it('accepts ordinary names', () => {
        for (const n of ['main', 'work-2', 'my_session', 'Projekt Ä']) {
            expect(sessionNameError(n)).toBeNull()
        }
    })

    it('rejects "." and ":" and says which', () => {
        expect(sessionNameError('my.session')).toContain('"."')
        expect(sessionNameError('a:b')).toContain('":"')
        expect(sessionNameError('a.b:c')).toContain('"." or ":"')
    })

    it('rejects empty, padded and control-character names', () => {
        expect(sessionNameError('')).not.toBeNull()
        expect(sessionNameError('   ')).not.toBeNull()
        expect(sessionNameError(' main')).not.toBeNull()
        expect(sessionNameError('a\tb')).not.toBeNull()
    })
})
