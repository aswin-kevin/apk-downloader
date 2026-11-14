import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { ApkDownloader, type DownloadManyOptions } from '../client.js';
import { InvalidOptionError } from '../errors.js';
import { VERSION } from '../index.js';
import { builtinSources, DEFAULT_SOURCES } from '../sources/index.js';
import type { AppInfo, BatchResult, ClientOptions } from '../types.js';
import { parseCli, UsageError, type CliOptions } from './args.js';
import { createStyle, errorDetails, formatBytes, serializeError, type Style } from './output.js';
import { ProgressLine } from './progress.js';

export interface CliIO {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  /** Whether stderr is an interactive terminal (progress bar, colors). */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Cancels in-flight work (wired to SIGINT by the executable). */
  signal?: AbortSignal;
  /** Injected for tests. */
  client?: ApkDownloader;
}

export const HELP = `Usage:
  apk-downloader <package...> [options]       Download apps (default command)
  apk-downloader info <package> [options]     Show app metadata
  apk-downloader versions <package> [options] List available versions
  apk-downloader sources                      List built-in sources

Download options:
  -o, --out <dir>            Output directory (default: current directory)
  -n, --name <template>      File name template (default: {package}-{version}.{ext})
                             Placeholders: {package} {version} {versionCode} {source} {ext}
  -a, --app-version <ver>    App version name or code (default: latest)
  -f, --format <fmt>         apk | xapk | auto (default: auto)
  -x, --extract              Extract APKs/OBBs from XAPK bundles into <out>/<package>/
  -s, --source <id>          Use only these sources, in this order (repeatable)
  -i, --input <file|->       Read package names from a file or stdin (one per line, # comments)
  -c, --concurrency <n>      Parallel downloads (default: 2)
      --overwrite            Replace existing files
      --skip-existing        Keep existing files (default)
      --fail-existing        Fail when the file already exists
      --no-verify            Skip checksum verification
      --allow-untrusted      Accept files the source has not verified (never ones flagged as malware)

Network options:
      --timeout <ms>         Per-request timeout (default: 30000)
      --retries <n>          Retries for transient failures (default: 3)
      --proxy <url>          HTTP(S) proxy (default: HTTPS_PROXY / HTTP_PROXY)
      --user-agent <ua>      Custom User-Agent

Output options:
      --json                 Print one JSON document to stdout
  -q, --quiet                Only print failures
      --verbose              Show per-source failure details
      --no-color             Disable colors (also: NO_COLOR=1)
  -h, --help                 Show this help
  -V, --version              Show the version

Exit codes: 0 success, 1 a download or lookup failed, 2 usage error, 130 interrupted.
`;

/** Run the CLI. Returns the process exit code. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    return usageError(io, error);
  }
  const { command, packages, options } = parsed;
  const style = createStyle(
    io.isTTY && !io.env.NO_COLOR && options.color !== false && !options.json,
  );

  if (command === 'help') return (write(io.stdout, HELP), 0);
  if (command === 'version') return (write(io.stdout, `${VERSION}\n`), 0);
  if (command === 'sources') return (listSources(io, options), 0);

  let client: ApkDownloader;
  try {
    client = io.client ?? new ApkDownloader(clientOptions(options));
  } catch (error) {
    return usageError(io, error);
  }

  try {
    if (command === 'info')
      return await showInfo(io, client, packages[0] as string, options, style);
    if (command === 'versions')
      return await showVersions(io, client, packages[0] as string, options);

    let all = packages;
    if (options.input !== undefined) {
      try {
        all = [...packages, ...(await readPackageList(options.input, io.stdin))];
      } catch (error) {
        return usageError(
          io,
          new UsageError(`Cannot read ${options.input}: ${(error as Error).message}`),
        );
      }
      if (all.length === 0) return usageError(io, new UsageError('No package names given'));
    }
    return await downloadAll(io, client, all, options, style);
  } catch (error) {
    if (io.signal?.aborted) return 130;
    if (error instanceof InvalidOptionError) return usageError(io, error);
    fail(io, options, style, error as Error);
    return 1;
  }
}

async function downloadAll(
  io: CliIO,
  client: ApkDownloader,
  packages: string[],
  options: CliOptions,
  style: Style,
): Promise<number> {
  const showProgress = io.isTTY && !options.quiet && !options.json;
  const progress = showProgress ? new ProgressLine(io.stderr, style) : undefined;

  const manyOptions: DownloadManyOptions = {
    concurrency: options.concurrency,
    extract: options.extract,
    verify: options.verify,
    allowUntrusted: options.allowUntrusted,
    onItemDone: (item) => {
      progress?.finish(item.packageName);
      if (!options.json) reportItem(io, options, style, item);
    },
  };
  if (options.outDir !== undefined) manyOptions.outDir = options.outDir;
  if (options.fileName !== undefined) manyOptions.fileName = options.fileName;
  if (options.version !== undefined) manyOptions.version = options.version;
  if (options.format !== undefined) manyOptions.format = options.format;
  if (options.ifExists !== undefined) manyOptions.ifExists = options.ifExists;
  if (io.signal) manyOptions.signal = io.signal;
  if (progress) manyOptions.onItemProgress = (pkg, p) => progress.update(pkg, p);

  const results = await client.downloadMany(packages, manyOptions);
  progress?.clear();
  if (io.signal?.aborted) return 130;

  if (options.json) {
    const doc = {
      results: results.map((r) =>
        r.ok ? r : { packageName: r.packageName, ok: false, error: serializeError(r.error) },
      ),
    };
    write(io.stdout, `${JSON.stringify(doc, null, 2)}\n`);
  } else if (!options.quiet && results.length > 1) {
    const failed = results.filter((r) => !r.ok).length;
    const summary = `${results.length - failed} of ${results.length} downloaded`;
    write(io.stderr, `${failed ? style.yellow(summary) : style.green(summary)}\n`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

function reportItem(io: CliIO, options: CliOptions, style: Style, item: BatchResult): void {
  if (!item.ok) {
    write(io.stderr, `${style.red('✖')} ${style.bold(item.packageName)}: ${item.error.message}\n`);
    if (options.verbose)
      for (const line of errorDetails(item.error)) write(io.stderr, `    ${style.dim(line)}\n`);
    return;
  }
  if (options.quiet) return;
  const r = item.result;
  const version = r.info.versionName ? ` ${r.info.versionName}` : '';
  const details = style.dim(`(${formatBytes(r.size)}, ${r.source})`);
  const mark = r.skipped ? style.yellow('↷') : style.green('✔');
  const note = r.skipped ? ` ${style.dim('already exists')}` : '';
  write(
    io.stderr,
    `${mark} ${style.bold(r.packageName)}${version} → ${r.filePath} ${details}${note}\n`,
  );
  for (const file of r.extractedFiles ?? []) write(io.stderr, `    ${style.dim(file)}\n`);
}

async function showInfo(
  io: CliIO,
  client: ApkDownloader,
  pkg: string,
  options: CliOptions,
  style: Style,
): Promise<number> {
  const info = await client.getInfo(pkg, io.signal ? { signal: io.signal } : {});
  if (options.json) {
    write(io.stdout, `${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }
  write(io.stdout, formatInfo(info, style));
  return 0;
}

function formatInfo(info: AppInfo, style: Style): string {
  const rows: Array<[string, string | undefined]> = [
    [
      'Version',
      info.versionName
        ? `${info.versionName}${info.versionCode !== undefined ? ` (${info.versionCode})` : ''}`
        : undefined,
    ],
    ['Format', info.format],
    ['Size', info.size !== undefined ? formatBytes(info.size) : undefined],
    ['Developer', info.developer],
    ['Min SDK', info.minSdk !== undefined ? String(info.minSdk) : undefined],
    ['ABIs', info.architectures?.length ? info.architectures.join(', ') : undefined],
    ['Signer', info.signature?.owner],
    ['Cert SHA-1', info.signature?.sha1],
    ['Trust', info.trust],
    ['Source', info.source],
  ];
  const title = info.name
    ? `${style.bold(info.name)} ${style.dim(`(${info.packageName})`)}`
    : style.bold(info.packageName);
  const lines = rows
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${style.dim(k.padEnd(11))}${v}`);
  return `${title}\n${lines.join('\n')}\n`;
}

async function showVersions(
  io: CliIO,
  client: ApkDownloader,
  pkg: string,
  options: CliOptions,
): Promise<number> {
  const versions = await client.listVersions(pkg, io.signal ? { signal: io.signal } : {});
  if (options.json) {
    write(io.stdout, `${JSON.stringify(versions, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(7, ...versions.map((v) => v.versionName.length));
  for (const v of versions) {
    const extra = [v.size !== undefined ? formatBytes(v.size) : '', v.trust ?? '', v.added ?? '']
      .filter(Boolean)
      .join('  ');
    write(
      io.stdout,
      `${v.versionName.padEnd(width)}  ${String(v.versionCode ?? '').padEnd(12)}${extra}\n`.replace(
        /\s+\n$/,
        '\n',
      ),
    );
  }
  return 0;
}

function listSources(io: CliIO, options: CliOptions): void {
  const list = DEFAULT_SOURCES.map((id) => ({
    id,
    description: builtinSources[id]?.description ?? '',
  }));
  if (options.json) write(io.stdout, `${JSON.stringify(list, null, 2)}\n`);
  else for (const s of list) write(io.stdout, `${s.id.padEnd(10)} ${s.description}\n`);
}

function clientOptions(options: CliOptions): ClientOptions {
  const result: ClientOptions = {};
  if (options.sources.length > 0) {
    result.sources = options.sources;
    result.infoSources = options.sources;
  }
  if (options.timeout !== undefined) result.timeout = options.timeout;
  if (options.retries !== undefined) result.retries = options.retries;
  if (options.proxy !== undefined) result.proxy = options.proxy;
  if (options.userAgent !== undefined) result.userAgent = options.userAgent;
  return result;
}

async function readPackageList(input: string, stdin: Readable): Promise<string[]> {
  const text = input === '-' ? await readStream(stdin) : await readFile(input, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

async function readStream(stream: Readable): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

function fail(io: CliIO, options: CliOptions, style: Style, error: Error): void {
  if (options.json) {
    write(io.stdout, `${JSON.stringify({ error: serializeError(error) }, null, 2)}\n`);
    return;
  }
  write(io.stderr, `${style.red('✖')} ${error.message}\n`);
  if (options.verbose)
    for (const line of errorDetails(error)) write(io.stderr, `    ${style.dim(line)}\n`);
}

function usageError(io: CliIO, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  write(io.stderr, `apk-downloader: ${message}\nRun "apk-downloader --help" for usage.\n`);
  return 2;
}

function write(stream: Writable, text: string): void {
  stream.write(text);
}
