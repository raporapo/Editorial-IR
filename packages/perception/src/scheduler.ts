/**
 * Keeps one large model in memory at a time.
 *
 * A 16 GB card is the declared target, and speech recognition, a vision
 * embedder and a vision-language model will not co-exist in it. The pipeline is
 * already staged — transcribe everything, then embed everything, then describe
 * the events that need it — so the fix is not smaller models but never asking
 * for two at once.
 *
 * The scheduler makes that a rule instead of a convention: work that needs
 * accelerator memory takes a lease, and a lease for a different model waits for
 * the previous one to be released. Work in the same slot runs back to back
 * without reloading, which is where nearly all of the time goes.
 */
export interface ModelLease {
  /** Slot name, typically the capability: `speech`, `visual`, `context`. */
  readonly slot: string;
  release(): void;
}

export interface ModelSchedulerOptions {
  /** How many slots may be resident at once. One is the safe default for 16 GB. */
  concurrency?: number;
  /** Called when a slot is evicted, so a backend can unload. */
  onEvict?: (slot: string) => void | Promise<void>;
}

export class ModelScheduler {
  private readonly concurrency: number;
  private readonly onEvict: ((slot: string) => void | Promise<void>) | undefined;
  private resident: string[] = [];
  private activeLeases = 0;
  private readonly queue: { slot: string; grant: () => void }[] = [];

  constructor(options: ModelSchedulerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.onEvict = options.onEvict;
  }

  /** Slots currently considered loaded, most recently used last. */
  get residentSlots(): readonly string[] {
    return this.resident;
  }

  /**
   * Runs `work` while holding a lease on `slot`.
   *
   * Consecutive calls for the same slot never evict anything, which is what
   * makes "transcribe all thirty files" cost one model load instead of thirty.
   */
  async withModel<T>(slot: string, work: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(slot);
    try {
      return await work();
    } finally {
      lease.release();
    }
  }

  private async acquire(slot: string): Promise<ModelLease> {
    if (this.activeLeases > 0 && !this.resident.includes(slot)) {
      // Something else is loaded and running: wait rather than risk the
      // out-of-memory error that would lose the whole run.
      await new Promise<void>((resolve) => this.queue.push({ slot, grant: resolve }));
    }

    this.activeLeases++;
    await this.makeResident(slot);

    let released = false;
    return {
      slot,
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases--;
        this.drain();
      },
    };
  }

  private async makeResident(slot: string): Promise<void> {
    this.resident = this.resident.filter((s) => s !== slot);
    this.resident.push(slot);
    while (this.resident.length > this.concurrency) {
      const evicted = this.resident.shift();
      if (evicted) await this.onEvict?.(evicted);
    }
  }

  private drain(): void {
    if (this.activeLeases > 0) return;
    const next = this.queue.shift();
    next?.grant();
  }
}
