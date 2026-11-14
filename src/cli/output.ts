import { AllSourcesFailedError, ApkDownloaderError, SourceUnavailableError } from '../errors.js';

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;

export function createStyle(enabled: boolean): Style {
  const plain = (text: string) => text;
  return enabled
    ? {
        bold: wrap(1, 22),
        dim: wrap(2, 22),
        green: wrap(32, 39),
        red: wrap(31, 39),
        yellow: wrap(33, 39),
        cyan: wrap(36, 39),
      }
    : { bold: plain, dim: plain, green: plain, red: plain, yellow: plain, cyan: plain };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** JSON-safe representation of an error. */
export function serializeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (error instanceof ApkDownloaderError) {
    out.code = error.code;
    if (error.source !== undefined) out.source = error.source;
  }
  if (error instanceof SourceUnavailableError && error.reason !== undefined)
    out.reason = error.reason;
  if (error instanceof AllSourcesFailedError) out.errors = error.errors.map(serializeError);
  return out;
}

/** Per-source details for `--verbose`. */
export function errorDetails(error: Error): string[] {
  if (!(error instanceof AllSourcesFailedError)) return [];
  return error.errors.map((e) => {
    const reason = e instanceof SourceUnavailableError && e.reason ? ` [${e.reason}]` : '';
    return `${e.source ?? 'unknown'}: ${e.message}${reason}`;
  });
}
