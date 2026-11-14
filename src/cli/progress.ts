import type { Writable } from 'node:stream';
import type { Progress } from '../types.js';
import { formatBytes, type Style } from './output.js';

const REDRAW_INTERVAL_MS = 100;
const BAR_WIDTH = 20;
const CLEAR_LINE = '\r\u001b[2K';

/** A single status line on a TTY summarising every active download. */
export class ProgressLine {
  private readonly active = new Map<string, Progress>();
  private lastDraw = 0;
  private drawn = false;

  constructor(
    private readonly stream: Writable,
    private readonly style: Style,
  ) {}

  update(packageName: string, progress: Progress): void {
    this.active.set(packageName, progress);
    const now = Date.now();
    if (now - this.lastDraw < REDRAW_INTERVAL_MS) return;
    this.lastDraw = now;
    this.draw();
  }

  /** Forget a package and remove the line so a permanent message can be printed. */
  finish(packageName: string): void {
    this.active.delete(packageName);
    this.clear();
  }

  clear(): void {
    if (!this.drawn) return;
    this.stream.write(CLEAR_LINE);
    this.drawn = false;
  }

  private draw(): void {
    const parts = [...this.active].map(([pkg, p]) => {
      const amount = p.total
        ? `${formatBytes(p.transferred)}/${formatBytes(p.total)}`
        : formatBytes(p.transferred);
      const speed = `${formatBytes(p.bytesPerSecond)}/s`;
      if (p.percent === undefined) return `${pkg} ${amount} ${this.style.dim(speed)}`;
      const filled = Math.round((p.percent / 100) * BAR_WIDTH);
      const bar =
        this.style.cyan('█'.repeat(filled)) + this.style.dim('░'.repeat(BAR_WIDTH - filled));
      return `${pkg} ${bar} ${p.percent.toFixed(1)}% ${amount} ${this.style.dim(speed)}`;
    });
    this.stream.write(`${CLEAR_LINE}${this.style.cyan('⇣')} ${parts.join('  ·  ')}`);
    this.drawn = true;
  }
}
