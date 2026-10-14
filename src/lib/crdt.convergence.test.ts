import { describe, expect, it } from 'vitest'
import { editNote, initializeNote, mergeNotes, noteRevision, validateCrdtNote } from './crdt'
import type { CrdtNote, NotePatch } from './crdt'

// Seed only delivery schedules, not Yjs. Assertions do not depend on the random
// actor IDs or the relative order of concurrent insertions at the same position.
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

// No replica shares a mutable object with another. Every edit and every packet
// crosses the same JSON boundary as saving a note and reopening it later.
function wire(note: CrdtNote): CrdtNote {
  return JSON.parse(JSON.stringify(note)) as CrdtNote
}

function baseline(content: string, title = 'Shared notebook'): CrdtNote {
  return wire(initializeNote({
    id: 'convergence-note', title, content,
    createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
  }))
}

function edit(note: CrdtNote, patch: NotePatch, tick: number): CrdtNote {
  return wire(editNote(wire(note), {
    ...patch, updatedAt: new Date(Date.UTC(2026, 9, 14, 10, 0, tick)).toISOString(),
  }))
}

function receive(local: CrdtNote, packet: CrdtNote): CrdtNote {
  return wire(mergeNotes(wire(local), wire(packet)))
}

function drain(replicas: readonly CrdtNote[], packets: readonly CrdtNote[], seed: number): CrdtNote[] {
  const next = random(seed)
  return replicas.map(replica => {
    let current = wire(replica)
    // Different delivery order per receiver, including repeated obsolete states.
    for (const packet of shuffled([...packets, ...packets.filter((_, index) => index % 3 === 0)], next)) {
      current = receive(current, packet)
    }
    return current
  })
}

function expectConvergence(replicas: readonly CrdtNote[]): CrdtNote {
  const first = replicas[0]!
  for (const replica of replicas) {
    expect(replica).toEqual(first)
    expect(noteRevision(replica)).toBe(noteRevision(first))
    expect(validateCrdtNote(wire(replica))).toEqual(replica)
  }
  return first
}

function occurrences(value: string, token: string): number {
  return value.split(token).length - 1
}

describe('independent CRDT replicas across unreliable delivery', () => {
  it.each([0x13579bdf, 0x2468ace, 0x5eed1234, 0x7fffffff])(
    'preserves an independent document oracle after multi-round edits, deletes, and stale packets (seed %i)',
    seed => {
      const actors = ['amber', 'birch', 'cedar', 'denim']
      const rounds = 5
      const section = (actor: string, body: string) => `## ${actor}\n${body}[end:${actor}]\n\n`
      const deleted = (actor: string) => `[remove-original:${actor}]\n`
      const kept = (actor: string, round: number) => `[keep:${actor}:${round}]\n`
      const temporary = (actor: string, round: number) => `[temporary:${actor}:${round}]\n`
      const initial = baseline(actors.map(actor => section(actor, deleted(actor))).join(''))
      // This oracle ledger tracks user actions separately from CRDT state. It
      // catches even a temporary loss/resurrection at an intermediate delivery.
      type Envelope = { note: CrdtNote; present: string[]; removed: string[] }
      const replicas: Envelope[] = actors.map(() => ({ note: wire(initial), present: [], removed: [] }))
      const packets: Envelope[] = [{ note: wire(initial), present: [], removed: [] }]
      const next = random(seed)
      const deliver = (local: Envelope, packet: Envelope): Envelope => {
        const note = receive(local.note, packet.note)
        const present = [...new Set([...local.present, ...packet.present])]
        const removed = [...new Set([...local.removed, ...packet.removed])]
        for (const marker of present) expect(occurrences(note.content, marker)).toBe(1)
        for (const marker of removed) expect(note.content).not.toContain(marker)
        return { note, present, removed }
      }
      const deliverAll = (states: readonly Envelope[], deliverySeed: number): Envelope[] => {
        const deliveryRandom = random(deliverySeed)
        return states.map(state => {
          let current = state
          for (const packet of shuffled([...packets, ...packets.filter((_, index) => index % 3 === 0)], deliveryRandom)) {
            current = deliver(current, packet)
          }
          return current
        })
      }

      for (let round = 0; round < rounds; round++) {
        for (const index of shuffled([0, 1, 2, 3], next)) {
          const actor = actors[index]!
          const current = replicas[index]!
          let content = current.note.content.replace(deleted(actor), '')
          if (round > 0) content = content.replace(temporary(actor, round - 1), '')
          content = content.replace(`[end:${actor}]`, `${kept(actor, round)}${temporary(actor, round)}[end:${actor}]`)
          replicas[index] = {
            note: edit(current.note, { content }, 1 + round * actors.length + index),
            present: [...current.present, kept(actor, round)],
            removed: [...current.removed, deleted(actor), ...(round > 0 ? [temporary(actor, round - 1)] : [])],
          }
          packets.push({ ...replicas[index]!, note: wire(replicas[index]!.note) })
        }

        // Some packets arrive before the next edit; others remain delayed for
        // several rounds. The sender's later changes cannot mutate old packets.
        for (let delivery = 0; delivery < 9; delivery++) {
          const receiver = Math.floor(next() * replicas.length)
          const packet = packets[Math.floor(next() * packets.length)]!
          replicas[receiver] = deliver(replicas[receiver]!, packet)
        }
      }

      const settled = deliverAll(replicas, seed ^ 0xabcdef)
      const converged = expectConvergence(settled.map(replica => replica.note))
      // This expected document comes only from the requested edits, not from
      // merging any replica or using the implementation as its own oracle.
      const expected = actors.map(actor => section(actor,
        Array.from({ length: rounds }, (_, round) => kept(actor, round)).join('') + temporary(actor, rounds - 1),
      )).join('')
      expect(converged.content).toBe(expected)
      for (const actor of actors) {
        expect(converged.content).not.toContain(deleted(actor))
        for (let round = 0; round < rounds; round++) {
          expect(occurrences(converged.content, kept(actor, round))).toBe(1)
          expect(occurrences(converged.content, temporary(actor, round))).toBe(round === rounds - 1 ? 1 : 0)
        }
      }
      // A second reconnect containing nothing but old states cannot resurrect
      // deleted text, duplicate inserts, or change even the encoded history.
      expect(expectConvergence(deliverAll(settled, seed).map(replica => replica.note))).toEqual(converged)
    },
  )

  it('converges overlapping replacements and deletion without losing concurrent inserted text', () => {
    const initial = baseline('# Shared\n\nBefore [obsolete] after.\n\nFooter\n')
    const replicas = [
      edit(initial, { content: initial.content.replace('obsolete', 'ALPHA') }, 1),
      edit(initial, { content: initial.content.replace('obsolete', 'BETA') }, 2),
      edit(initial, { content: initial.content.replace('obsolete', '') }, 3),
    ]
    const packets = [initial, ...replicas]
    const first = expectConvergence(drain(replicas, packets, 0xc0111de))
    // Both replacements insert new text concurrently with the deletion. The
    // shared deleted characters stay deleted; actor ordering is not prescribed.
    expect(first.content).toMatch(/^# Shared\n\nBefore \[(?:ALPHABETA|BETAALPHA)\] after\.\n\nFooter\n$/)
    expect(occurrences(first.content, 'ALPHA')).toBe(1)
    expect(occurrences(first.content, 'BETA')).toBe(1)
    expect(first.content).not.toContain('obsolete')

    const editedAgain = edit(first, { content: first.content.replace('Footer', 'Final footer') }, 4)
    const final = expectConvergence(drain([editedAgain, first, replicas[2]!], [...packets, editedAgain], 0xc0111df))
    expect(final.content).toBe(first.content.replace('Footer', 'Final footer'))
  })

  it('preserves Markdown, combining characters, emoji sequences, and surrogate pairs across independent edits', () => {
    const original = '# 📝 Café\n\n- [ ] task 😄\n- 日本語：旧\n\n```md\n**keep** 👨‍👩‍👧‍👦\n```\n\n_End_ 🇨🇭\n'
    const initial = baseline(original)
    const replicas = [
      edit(initial, { content: original.replace('[ ] task 😄', '[x] task 😇') }, 1),
      edit(initial, { content: original.replace('日本語：旧', '日本語：新しい e\u0301') }, 2),
      edit(initial, { content: original.replace('👨‍👩‍👧‍👦', '👩‍👩‍👧‍👦') }, 3),
      edit(initial, { content: original.replace('Café', 'Cafe\u0301').replace('🇨🇭', '🇯🇵') }, 4),
    ]
    const merged = expectConvergence(drain(replicas, [initial, ...replicas], 0x10ffff))
    const expected = '# 📝 Cafe\u0301\n\n- [x] task 😇\n- 日本語：新しい e\u0301\n\n```md\n**keep** 👩‍👩‍👧‍👦\n```\n\n_End_ 🇯🇵\n'
    expect(merged.content).toBe(expected)
    // UTF-8 conversion replaces lone UTF-16 surrogates, so this also detects a
    // diff accidentally splitting an emoji while its readable text looks close.
    expect(new TextDecoder().decode(new TextEncoder().encode(merged.content))).toBe(merged.content)
    expect(merged.content).not.toContain('\ufffd')
    expect(occurrences(merged.content, '```')).toBe(2)
  })

  it('merges title, body, and folder changes independently, then preserves a causally later folder move', () => {
    const initial = baseline('Body\n', 'Title')
    const replicas = [
      edit(initial, { title: 'Prefix Title' }, 1),
      edit(initial, { title: 'Title Suffix' }, 2),
      edit(initial, { folder: ' Work / Ideas ' }, 3),
      edit(initial, { content: 'Body\nFirst addition\n' }, 4),
    ]
    const first = expectConvergence(drain(replicas, [initial, ...replicas], 0xf01de2))
    expect(first).toMatchObject({ title: 'Prefix Title Suffix', content: 'Body\nFirst addition\n', folder: 'Work/Ideas' })

    const secondRound = [
      edit(first, { title: 'New Prefix Title Suffix' }, 5),
      edit(first, { content: 'Body\nFirst addition\nSecond addition\n' }, 6),
      edit(first, { folder: 'Archive/One' }, 7),
      edit(first, { folder: 'Archive/Two' }, 8),
    ]
    const packets = [initial, ...replicas, first, ...secondRound]
    const second = expectConvergence(drain(secondRound, packets, 0xf01de3))
    expect(second.title).toBe('New Prefix Title Suffix')
    expect(second.content).toBe('Body\nFirst addition\nSecond addition\n')
    // A concurrent map conflict chooses one complete path, never combines paths.
    expect(['Archive/One', 'Archive/Two']).toContain(second.folder)

    const moved = edit(second, { folder: 'Final/Reviewed' }, 9)
    const final = expectConvergence(drain([moved, second, first, initial], [...packets, moved], 0xf01de4))
    expect(final).toEqual(moved)
    expect(final.folder).toBe('Final/Reviewed')
  })

  it('keeps offline edits under a tombstone and does not re-delete an explicit restore when old deletions arrive', () => {
    const initial = baseline('First\nMiddle\nObsolete\nLast\n')
    const replicas = [
      edit(initial, { deleted: true }, 1),
      edit(initial, { content: 'First [laptop]\nMiddle\nObsolete\nLast\n' }, 2),
      edit(initial, { content: 'First\nMiddle [phone]\nObsolete\nLast\n' }, 3),
      edit(initial, { content: 'First\nMiddle\nLast\n' }, 4),
    ]
    const packets = [initial, ...replicas]
    const deleted = expectConvergence(drain(replicas, packets, 0xde1e7e))
    expect(deleted.deleted).toBe(true)
    expect(deleted.content).toBe('First [laptop]\nMiddle [phone]\nLast\n')

    // This device has seen deletion but has not seen the later restore. Editing
    // its text must not implicitly create a second delete operation.
    const offlineEdit = edit(deleted, { content: `${deleted.content}Offline after deletion\n`, title: 'Recovered work' }, 5)
    expect(offlineEdit.deleted).toBe(true)
    const restored = edit(deleted, { deleted: false }, 6)
    const afterRestore = expectConvergence(drain(
      [restored, offlineEdit, deleted, replicas[0]!],
      [...packets, deleted, offlineEdit, restored, replicas[0]!, deleted],
      0xde1e7f,
    ))
    expect(afterRestore.deleted).toBeUndefined()
    expect(afterRestore.title).toBe('Recovered work')
    expect(afterRestore.content).toBe('First [laptop]\nMiddle [phone]\nLast\nOffline after deletion\n')

    // A genuinely later user delete still works; its subsequent explicit restore
    // also dominates duplicate delivery of that newer deletion.
    const deletedAgain = edit(afterRestore, { deleted: true }, 7)
    const restoredAgain = edit(deletedAgain, { deleted: false }, 8)
    const final = expectConvergence(drain(
      [deletedAgain, restoredAgain, afterRestore],
      [...packets, deleted, offlineEdit, restored, deletedAgain, restoredAgain, deletedAgain],
      0xde1e80,
    ))
    expect(final).toEqual(restoredAgain)
    expect(final.deleted).toBeUndefined()
    expect(final.content).toBe(afterRestore.content)
  })
})
