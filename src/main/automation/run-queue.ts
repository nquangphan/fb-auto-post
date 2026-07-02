/**
 * Global serial executor (Red Team C2). ALL Playwright work — login,
 * health-check, manual batch, scheduled batch, retry — must funnel through here
 * so two code paths never launch a persistent context on the same profile dir
 * concurrently (Chromium SingletonLock → crash / corrupted cookie store).
 *
 * Work is serialized per key (the account id). Different accounts may run in
 * parallel; the same account never overlaps itself. Re-entrant enqueues (a task
 * scheduling more work on its own key) stay serialized too.
 */
export class RunQueue {
  private chains = new Map<string, Promise<unknown>>()
  private pending = new Map<string, number>()

  /** Enqueue `task` on `key`'s chain; resolves with the task's result. */
  run<T>(key: string | number, task: () => Promise<T>): Promise<T> {
    const k = String(key)
    this.pending.set(k, (this.pending.get(k) ?? 0) + 1)

    const prev = this.chains.get(k) ?? Promise.resolve()
    const next = prev.then(task, task)

    // Keep the chain alive (swallow rejection on the stored handle) so one failed
    // task doesn't poison the key's chain; callers still see their own error.
    const guarded: Promise<unknown> = next.then(
      () => this.settle(k, guarded),
      () => this.settle(k, guarded)
    )
    this.chains.set(k, guarded)
    return next
  }

  private settle(k: string, guarded: Promise<unknown>): void {
    const remaining = (this.pending.get(k) ?? 1) - 1
    if (remaining <= 0) {
      this.pending.delete(k)
      // Only drop the chain if it is still the one we just settled — never delete
      // a newer generation a later enqueue installed.
      if (this.chains.get(k) === guarded) this.chains.delete(k)
    } else {
      this.pending.set(k, remaining)
    }
  }

  /** True if any task is currently queued/running for the key. */
  isBusy(key: string | number): boolean {
    return (this.pending.get(String(key)) ?? 0) > 0
  }
}
