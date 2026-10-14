import type { Session } from '@synonymdev/pubky'

type Lock = { path: string; sessionId: number; token: symbol; free(): void }
type Write = { path: string; text: string; sessionId: number }

function storageError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { data: { statusCode } })
}

/** A one-shot deterministic scheduling barrier; no timers or polling are involved. */
export function barrier() {
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { reached, release, wait: async () => { entered(); await released } }
}

/**
 * Only the Pubky transport boundary is simulated. All application modules and
 * SDK address parsing remain real. Storage keeps serialized bytes, and sessions
 * cannot write, renew, or release another session's exclusive lock.
 */
export class IntegrationHomeserver {
  readonly owner = 'y'.repeat(52)
  private readonly files = new Map<string, string>()
  private readonly locks = new Map<string, Lock>()
  private nextSession = 0
  afterWrite?: (write: Write) => Promise<void>

  get activeLocks(): number { return this.locks.size }
  get paths(): string[] { return [...this.files.keys()].sort() }

  /** Explicit fixture setup represents an unrelated/legacy client replacing a file. */
  seed(path: string, value: unknown): void { this.files.set(path, JSON.stringify(value)) }
  read<T>(path: string): T | undefined {
    const text = this.files.get(path)
    return text === undefined ? undefined : JSON.parse(text) as T
  }

  session(): Session {
    const sessionId = ++this.nextSession
    const requireLock = (lock: Lock) => {
      if (lock.sessionId !== sessionId || this.locks.get(lock.path)?.token !== lock.token) {
        throw storageError(412, 'Missing, expired, or foreign lock')
      }
    }
    return {
      info: { publicKey: { z32: () => this.owner } },
      storage: {
        get: async (path: string) => {
          const text = this.files.get(path)
          if (text === undefined) throw storageError(404, 'File not found')
          return new Response(text, { headers: { 'content-type': 'application/json' } })
        },
        list: async (folder: string, cursor: string | null, reverse: boolean, limit: number) => {
          const paths = this.paths.filter(path => path.startsWith(folder)).map(path => `pubky${this.owner}${path}`)
          if (reverse) paths.reverse()
          const start = cursor === null ? 0 : paths.indexOf(cursor) + 1
          return paths.slice(start, start + limit)
        },
        putJson: async (path: string, value: unknown) => {
          if (this.locks.has(path)) throw storageError(423, 'File is locked')
          const text = JSON.stringify(value)
          this.files.set(path, text)
          await this.afterWrite?.({ path, text, sessionId })
        },
        lock: async (path: string) => {
          if (this.locks.has(path)) throw storageError(423, 'File is locked')
          const lock: Lock = { path, sessionId, token: Symbol(path), free: () => undefined }
          this.locks.set(path, lock)
          return lock
        },
        refreshLock: async (lock: Lock) => { requireLock(lock) },
        unlock: async (lock: Lock) => { requireLock(lock); this.locks.delete(lock.path) },
        putTextLocked: async (lock: Lock, text: string) => {
          requireLock(lock)
          // Validate JSON at the boundary, but retain bytes rather than object references.
          JSON.parse(text)
          this.files.set(lock.path, text)
          await this.afterWrite?.({ path: lock.path, text, sessionId })
        },
        deleteLocked: async (lock: Lock) => {
          requireLock(lock)
          if (!this.files.delete(lock.path)) throw storageError(404, 'File not found')
        },
      },
    } as unknown as Session
  }
}
