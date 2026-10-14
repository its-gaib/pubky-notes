import type { Session } from '@synonymdev/pubky'
import { IS_TESTNET } from '../config'
import { ensureCrdt, LineageConflictError } from './crdt'
import { deleteNote, listNotes, saveNote } from './notes'
import type { NoteRecord } from './notes'
import { loadFolders, normalizeFolderPaths, saveFolders } from './folder-store'
import {
  acknowledgeLocalFolders, acknowledgeLocalNote, acceptRemoteFolders, readLocalNotebook,
} from './local-notebook'
import type { LocalNotebook } from './local-notebook'

const NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'
export const GUEST_SCOPE = `${NETWORK}:guest`
export function scopeForSession(session: Session): string { return `${NETWORK}:${session.info.publicKey.z32()}` }

function requireScope(session: Session, scope: string): void {
  if (scopeForSession(session) !== scope) throw new Error('This notebook belongs to a different Pubky account.')
}

/** Remote state is merged into durable local state, never substituted for it. */
export async function mergeRemoteNotebook(scope: string, records: NoteRecord[], folders: string[]): Promise<LocalNotebook> {
  for (const row of records) await acknowledgeLocalNote(scope, { ...row, note: await ensureCrdt(row.note) })
  await acceptRemoteFolders(scope, folders)
  return readLocalNotebook(scope)
}

export async function pullNotebook(session: Session, scope: string): Promise<LocalNotebook> {
  requireScope(session, scope)
  const [records, folders] = await Promise.all([listNotes(session), loadFolders(session)])
  return mergeRemoteNotebook(scope, records, folders)
}

/** Every job is permanently bound to its supplied session and account bucket. */
export async function uploadNotebook(session: Session, scope: string): Promise<LocalNotebook> {
  requireScope(session, scope)
  let notebook = await readLocalNotebook(scope)
  if (notebook.foldersPending) {
    const sent = await saveFolders(session, notebook.folders)
    const stored = await loadFolders(session)
    if (JSON.stringify(normalizeFolderPaths(stored)) !== JSON.stringify(normalizeFolderPaths(sent))) {
      throw new Error('The homeserver did not retain the folder update. The changes are still saved on this device.')
    }
    await acknowledgeLocalFolders(scope, sent)
  }
  // A legacy conflict can produce a recovered note during pull; the second pass
  // uploads that copy while retaining both histories. Other failures stay queued.
  for (let pass = 0; pass < 2; pass++) {
    notebook = await readLocalNotebook(scope)
    let recovered = false
    for (const row of notebook.records) {
      if (!notebook.pending.includes(row.note.id)) continue
      try {
        let saved = row.note.deleted ? await deleteNote(session, row.note) : await saveNote(session, row.note)
        // A remote deletion wins over ordinary text edits; retain the merged text
        // in Trash and finish removing any previously published snapshot.
        if (saved.deleted && !row.note.deleted) saved = await deleteNote(session, saved)
        await acknowledgeLocalNote(scope, { note: saved, published: saved.deleted ? null : row.published })
      } catch (error) {
        if (!(error instanceof LineageConflictError)) throw error
        await pullNotebook(session, scope)
        recovered = true
      }
    }
    if (!recovered) break
  }
  return readLocalNotebook(scope)
}

export async function synchronizeNotebook(session: Session, scope: string): Promise<LocalNotebook> {
  await pullNotebook(session, scope)
  return uploadNotebook(session, scope)
}
