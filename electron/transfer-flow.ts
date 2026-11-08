/** A paused stream retains its file handles and offset. Waiting here applies
 * ordinary stream backpressure instead of reopening or replaying file bytes. */
export class TransferGate {
  private value = false
  private readonly listeners = new Set<() => void>()
  get paused(): boolean { return this.value }
  set(paused: boolean): void {
    if (this.value === paused) return
    this.value = paused
    for (const listener of [...this.listeners]) listener()
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.value) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (signal.aborted || !this.value) {
          unsubscribe(); signal.removeEventListener('abort', finish)
          signal.aborted ? reject(signal.reason) : resolve()
        }
      }
      const unsubscribe = this.subscribe(finish)
      signal.addEventListener('abort', finish, { once: true })
      finish()
    })
  }
}

interface Request {
  maximum: number
  gate: TransferGate
  signal: AbortSignal
  resolve: (bytes: number) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

/** One FIFO token bucket per window caps aggregate throughput across sessions.
 * A 50 ms quantum bounds bursts, wakeups and cancellation latency. */
export class TransferBandwidth {
  private requests: Request[] = []
  private timer?: ReturnType<typeof setTimeout>
  private tokens = 0
  private updatedAt = performance.now()
  private value = 0
  get limit(): number { return this.value }

  set(limit: number): void {
    this.value = limit; this.tokens = 0; this.updatedAt = performance.now()
    this.pump()
  }

  acquire(maximum: number, gate: TransferGate, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    return new Promise<number>((resolve, reject) => {
      const request: Request = { maximum, gate, signal, resolve, reject, cleanup: () => {} }
      const changed = () => this.pump()
      const unsubscribe = gate.subscribe(changed)
      signal.addEventListener('abort', changed, { once: true })
      request.cleanup = () => { unsubscribe(); signal.removeEventListener('abort', changed) }
      this.requests.push(request)
      this.pump()
    })
  }

  private pump(): void {
    clearTimeout(this.timer); this.timer = undefined
    const now = performance.now()
    const quantum = this.value ? Math.min(16 * 1024, Math.max(1, Math.ceil(this.value / 20))) : 64 * 1024
    if (this.value) this.tokens = Math.min(Math.max(quantum, Math.min(64 * 1024, this.value / 10)), this.tokens + Math.max(0, now - this.updatedAt) * this.value / 1000)
    this.updatedAt = now
    for (const request of [...this.requests]) {
      if (!request.signal.aborted) continue
      this.requests.splice(this.requests.indexOf(request), 1)
      request.cleanup(); request.reject(request.signal.reason)
    }
    while (this.requests.length) {
      const index = this.requests.findIndex((request) => !request.gate.paused)
      if (index < 0) return
      const request = this.requests[index]
      const bytes = Math.min(request.maximum, quantum)
      if (this.value && this.tokens < bytes) {
        this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil((bytes - this.tokens) / this.value * 1000)))
        return
      }
      this.requests.splice(index, 1)
      if (this.value) this.tokens -= bytes
      request.cleanup(); request.resolve(bytes)
    }
  }
}
