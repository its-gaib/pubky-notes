import { afterEach, expect, it, vi } from 'vitest'
import { startBackgroundRefresh } from './background-refresh'

afterEach(() => vi.useRealTimers())

it('backs off unchanged pulls, resets on changes and wakes, and pauses hidden notebooks', async () => {
  vi.useFakeTimers()
  let visible = true
  const refresh = vi.fn(async () => false)
  const polling = startBackgroundRefresh({ canRefresh: () => visible, refresh })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(refresh).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(240_000)
  expect(refresh).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(refresh).toHaveBeenCalledTimes(4)
  visible = false
  await vi.advanceTimersByTimeAsync(300_000)
  expect(refresh).toHaveBeenCalledTimes(4)
  visible = true
  polling.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(refresh).toHaveBeenCalledTimes(5)
  refresh.mockResolvedValueOnce(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(refresh).toHaveBeenCalledTimes(6)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(refresh).toHaveBeenCalledTimes(7)
  polling.stop()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(refresh).toHaveBeenCalledTimes(7)
})

it('does not overlap pulls or schedule another pull after stopping an in-flight refresh', async () => {
  vi.useFakeTimers()
  let resolve!: (changed: boolean) => void
  const refresh = vi.fn(() => new Promise<boolean>(done => { resolve = done }))
  const polling = startBackgroundRefresh({ canRefresh: () => true, refresh })
  polling.wake(); polling.wake()
  expect(refresh).toHaveBeenCalledTimes(1)
  polling.stop(); resolve(false)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('backs off failed pulls and retries immediately on a wake', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn(async (): Promise<boolean> => { throw new Error('offline') })
  const polling = startBackgroundRefresh({ canRefresh: () => true, refresh })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.advanceTimersByTimeAsync(119_999)
  expect(refresh).toHaveBeenCalledTimes(1)
  polling.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(refresh).toHaveBeenCalledTimes(2)
  polling.stop()
})
