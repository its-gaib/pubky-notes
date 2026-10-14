export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
export const FRAME_BYTES = 16 * 1024
const HEADER_BYTES = 12
const MAGIC = 0x504e4331

/** Ordered reliable channels let us reassemble one bounded message at a time. */
export function* frameMessage(message: Uint8Array): Generator<ArrayBuffer> {
  if (message.byteLength < 1 || message.byteLength > MAX_MESSAGE_BYTES) throw new Error('Collaboration update exceeds the message limit')
  for (let offset = 0; offset < message.length; offset += FRAME_BYTES - HEADER_BYTES) {
    const length = Math.min(FRAME_BYTES - HEADER_BYTES, message.length - offset)
    const frame = new ArrayBuffer(HEADER_BYTES + length)
    const view = new DataView(frame)
    view.setUint32(0, MAGIC)
    view.setUint32(4, message.length)
    view.setUint32(8, offset)
    new Uint8Array(frame, HEADER_BYTES).set(message.subarray(offset, offset + length))
    yield frame
  }
}

export class MessageAssembler {
  private message?: Uint8Array
  private offset = 0
  private startedAt = 0

  push(frame: unknown, now = Date.now()): Uint8Array | undefined {
    if (!(frame instanceof ArrayBuffer) || frame.byteLength <= HEADER_BYTES || frame.byteLength > FRAME_BYTES) throw new Error('Invalid collaboration frame')
    const view = new DataView(frame)
    const total = view.getUint32(4), offset = view.getUint32(8), payload = new Uint8Array(frame, HEADER_BYTES)
    if (view.getUint32(0) !== MAGIC || total < 1 || total > MAX_MESSAGE_BYTES || offset !== this.offset || offset + payload.length > total
      || (this.message && (total !== this.message.length || now - this.startedAt > 30_000))) throw new Error('Invalid collaboration frame sequence')
    if (!this.message) {
      this.message = new Uint8Array(total)
      this.startedAt = now
    }
    this.message.set(payload, offset)
    this.offset += payload.length
    if (this.offset === total) {
      const complete = this.message
      this.message = undefined
      this.offset = 0
      return complete
    }
    return undefined
  }
}
