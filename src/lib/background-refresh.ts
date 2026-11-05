const MIN_DELAY = 60_000
const MAX_DELAY = 300_000

/** Poll only after the previous refresh settles. Wake events reset the backoff. */
export function startBackgroundRefresh(options: { canRefresh(): boolean; refresh(): Promise<boolean> }) {
  let stopped = false, running = false, delay = MIN_DELAY, awakened = false
  let timer: ReturnType<typeof setTimeout>
  function schedule() {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(() => void update(), delay)
  }
  async function update() {
    if (stopped || running) return
    if (!options.canRefresh()) { schedule(); return }
    running = true
    try {
      const changed = await options.refresh()
      delay = awakened || changed ? MIN_DELAY : Math.min(MAX_DELAY, delay * 2)
    } catch { delay = awakened ? MIN_DELAY : Math.min(MAX_DELAY, delay * 2) }
    finally { running = false; awakened = false; schedule() }
  }
  schedule()
  return {
    wake() { awakened = true; delay = MIN_DELAY; clearTimeout(timer); void update() },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
