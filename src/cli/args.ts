import { parseArgs } from 'node:util';
import type { FormatOption, IfExists } from '../types.js';

export type Command = 'download' | 'info' | 'versions' | 'sources' | 'help' | 'version';

export interface CliOptions {
  outDir?: string;
  fileName?: string;
  version?: string;
  format?: FormatOption;
  extract: boolean;
  /** Source ids in fallback order; empty = library defaults. */
  sources: string[];
  /** File with package names, or `-` for stdin. */
  input?: string;
  concurrency: number;
  ifExists?: IfExists;
  verify: boolean;
  timeout?: number;
  retries?: number;
  proxy?: string;
  userAgent?: string;
  allowUntrusted: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  /** `false` when `--no-color` was given. */
  color?: boolean;
}

export interface ParsedCli {
  command: Command;
  packages: string[];
  options: CliOptions;
}

/** Invalid command-line usage (exit code 2). */
export class UsageError extends Error {
  override name = 'UsageError';
}

const SUBCOMMANDS = new Set(['info', 'versions', 'sources', 'help']);
const FORMATS = new Set(['apk', 'xapk', 'auto']);

export function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    return { command: 'help', packages: [], options: defaults() };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        name: { type: 'string', short: 'n' },
        'app-version': { type: 'string', short: 'a' },
        format: { type: 'string', short: 'f' },
        extract: { type: 'boolean', short: 'x' },
        source: { type: 'string', short: 's', multiple: true },
        input: { type: 'string', short: 'i' },
        concurrency: { type: 'string', short: 'c' },
        overwrite: { type: 'boolean' },
        'skip-existing': { type: 'boolean' },
        'fail-existing': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
        proxy: { type: 'string' },
        'user-agent': { type: 'string' },
        'allow-untrusted': { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const { values, positionals } = parsed;
  if (values.version) return { command: 'version', packages: [], options: defaults() };

  const first = positionals[0];
  const command: Command = first && SUBCOMMANDS.has(first) ? (first as Command) : 'download';
  const packages = command === 'download' ? positionals : positionals.slice(1);

  const options = defaults();
  if (values.out !== undefined) options.outDir = values.out;
  if (values.name !== undefined) options.fileName = values.name;
  if (values['app-version'] !== undefined) options.version = values['app-version'];
  if (values.format !== undefined) {
    if (!FORMATS.has(values.format))
      throw new UsageError(`--format must be apk, xapk or auto (got ${values.format})`);
    options.format = values.format as FormatOption;
  }
  options.extract = values.extract ?? false;
  options.sources = values.source ?? [];
  if (values.input !== undefined) options.input = values.input;
  if (values.concurrency !== undefined)
    options.concurrency = integer('--concurrency', values.concurrency, 1);

  const ifExists = (['overwrite', 'skip-existing', 'fail-existing'] as const).filter(
    (flag) => values[flag],
  );
  if (ifExists.length > 1)
    throw new UsageError('Use only one of --overwrite, --skip-existing, --fail-existing');
  if (ifExists[0])
    options.ifExists = (
      { overwrite: 'overwrite', 'skip-existing': 'skip', 'fail-existing': 'error' } as const
    )[ifExists[0]];

  options.verify = !values['no-verify'];
  if (values.timeout !== undefined) options.timeout = integer('--timeout', values.timeout, 1);
  if (values.retries !== undefined) options.retries = integer('--retries', values.retries, 0);
  if (values.proxy !== undefined) options.proxy = values.proxy;
  if (values['user-agent'] !== undefined) options.userAgent = values['user-agent'];
  options.allowUntrusted = values['allow-untrusted'] ?? false;
  options.json = values.json ?? false;
  options.quiet = values.quiet ?? false;
  options.verbose = values.verbose ?? false;
  if (values['no-color']) options.color = false;

  if (command === 'help') return { command, packages: [], options };
  if ((command === 'info' || command === 'versions') && packages.length !== 1) {
    throw new UsageError(`${command} requires exactly one package name`);
  }
  if (command === 'sources' && packages.length > 0) {
    throw new UsageError('sources does not take package names');
  }
  if (command === 'download' && packages.length === 0 && options.input === undefined) {
    throw new UsageError('No package names given');
  }
  return { command, packages, options };
}

function defaults(): CliOptions {
  return {
    extract: false,
    sources: [],
    concurrency: 2,
    verify: true,
    allowUntrusted: false,
    json: false,
    quiet: false,
    verbose: false,
  };
}

function integer(flag: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < min) {
    throw new UsageError(`${flag} must be an integer >= ${min} (got ${raw})`);
  }
  return value;
}
