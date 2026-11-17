import { setTimeout as delay } from 'node:timers/promises';
export class DownloadPacer {
  private available = 0;
  private updatedAt = Date.now();
  constructor(private rate: number) {}
  setRate(rate: number) {
    if (!Number.isSafeInteger(rate) || rate < 1 || rate > 1000000000) throw new Error('Invalid download allocation.');
    this.available = Math.min(this.available, rate / 4); this.rate = rate;
  }
  async wait(bytes: number, signal: AbortSignal) {
    let remaining = bytes;
    while (remaining > 0) {
      signal.throwIfAborted();
      const now = Date.now();
      this.available = Math.min(this.rate / 4, this.available + Math.max(0, now - this.updatedAt) * this.rate / 1000);
      this.updatedAt = now;
      const consumed = Math.min(remaining, this.available);
      remaining -= consumed; this.available -= consumed;
      if (remaining > 0) await delay(Math.max(1, Math.min(200, remaining * 1000 / this.rate)), undefined, { signal });
    }
  }
}
