import { describe, it, expect } from '@jest/globals'
import { canCancelCommand, commandKindLabel, commandStatus } from './queue'
import type { CommandStatus } from './desk'

describe('commandKindLabel', () => {
  it('reads the wire’s own kind, underscores opened out', () => {
    expect(commandKindLabel('file_edition')).toBe('file edition')
    expect(commandKindLabel('research')).toBe('research')
    expect(commandKindLabel('custom')).toBe('custom')
  })

  it('opens out a kind this app has never heard of rather than hiding it', () => {
    expect(commandKindLabel('deep_dive_on_capex')).toBe('deep dive on capex')
  })

  it('names an empty kind rather than rendering a blank row', () => {
    expect(commandKindLabel('')).toBe('command')
    expect(commandKindLabel('   ')).toBe('command')
  })
})

describe('commandStatus', () => {
  it('gives every status of the wire a glyph and a word', () => {
    const statuses: CommandStatus[] = [
      'pending',
      'claimed',
      'done',
      'failed',
      'expired',
      'cancelled',
      'unknown',
    ]
    for (const s of statuses) {
      const row = commandStatus(s)
      expect(row.word.length).toBeGreaterThan(0)
      expect(row.glyph.length).toBeGreaterThan(0)
    }
  })

  it('never spells the failed glyph the way the cancel control is spelled', () => {
    // The row carries a ✕ button beside the glyph; a failure mark that looked like it would
    // read as "this one was cancelled" — two different facts one character apart.
    for (const s of ['pending', 'claimed', 'done', 'failed', 'expired', 'cancelled', 'unknown'] as CommandStatus[]) {
      expect(commandStatus(s).glyph).not.toBe('✕')
    }
  })

  it('is red only for failed, and green for NOTHING — on this app green means direction, never "it worked"', () => {
    expect(commandStatus('failed').tone).toBe('down')
    expect(commandStatus('done').tone).toBe('neutral')
    expect(commandStatus('pending').tone).toBe('neutral')
    expect(commandStatus('claimed').tone).toBe('neutral')
    for (const s of ['pending', 'claimed', 'done', 'failed', 'expired', 'cancelled'] as CommandStatus[]) {
      expect(commandStatus(s).tone).not.toBe('up')
    }
  })

  it('greys out the three that are over without having been done', () => {
    expect(commandStatus('expired').tone).toBe('dim')
    expect(commandStatus('cancelled').tone).toBe('dim')
    expect(commandStatus('unknown').tone).toBe('dim')
  })
})

describe('canCancelCommand', () => {
  // store.py's cancel_command(): the UPDATE names status = 'pending'. A claimed command is the
  // worker's to finish — marking it cancelled here would not stop the worker, it would only lose
  // track of it.
  it('is true for pending and false for everything else', () => {
    expect(canCancelCommand('pending')).toBe(true)
    for (const s of ['claimed', 'done', 'failed', 'expired', 'cancelled', 'unknown'] as CommandStatus[]) {
      expect(canCancelCommand(s)).toBe(false)
    }
  })
})
