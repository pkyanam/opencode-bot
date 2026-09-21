export type StartupState = {
  state: "starting" | "ready" | "error";
  startedAt: string;
  error?: string;
  retryAfterMs: number;
};

/** One background warmup per Durable Object, with bounded transient retries. */
export class ComputerStartup {
  private pending?: Promise<void>;
  private retryAt = 0;
  private started = 0;
  private value?: StartupState;
  constructor(private readonly now = () => Date.now()) {}

  read(start: () => Promise<void>, retain: (work: Promise<void>) => void, retry = false): StartupState {
    if (retry && !this.pending) this.value = undefined;
    if (!this.value) {
      this.started = this.now();
      this.retryAt = 0;
      this.value = { state: "starting", startedAt: new Date(this.started).toISOString(), retryAfterMs: 3000 };
    }
    if (this.value.state === "starting" && !this.pending && this.now() >= this.retryAt) {
      this.pending = Promise.resolve().then(start).then(() => {
        this.value = { state: "ready", startedAt: new Date(this.started).toISOString(), retryAfterMs: 0 };
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const transient = /timeout|timed out|starting|provision|not.*ready|container.*start|not.*running|port.*available|\b50[0234]\b/i.test(message);
        if (transient && this.now() - this.started < 10 * 60_000) {
          this.retryAt = this.now() + 10_000;
          this.value = { state: "starting", startedAt: new Date(this.started).toISOString(), retryAfterMs: 3000 };
        } else {
          this.value = { state: "error", startedAt: new Date(this.started).toISOString(), retryAfterMs: 0,
            error: /recovery|restore/i.test(message)
              ? "Your computer needs recovery. Open Computer & checkpoints to restore it."
              : "Your computer could not start. Retry, or check Computer & checkpoints." };
        }
      }).finally(() => { this.pending = undefined; });
      retain(this.pending);
    }
    return { ...this.value };
  }

  peek(): StartupState | undefined { return this.value ? { ...this.value } : undefined; }

  invalidate() {
    if (!this.pending) this.value = undefined;
  }
}
