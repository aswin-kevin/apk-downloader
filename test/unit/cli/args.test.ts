import { describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../../../src/cli/args.js';

describe('parseCli', () => {
  it('defaults to the download command', () => {
    const parsed = parseCli(['com.a.b', 'org.c.d']);
    expect(parsed.command).toBe('download');
    expect(parsed.packages).toEqual(['com.a.b', 'org.c.d']);
    expect(parsed.options).toMatchObject({
      sources: [],
      extract: false,
      verify: true,
      json: false,
      quiet: false,
      verbose: false,
      allowUntrusted: false,
      concurrency: 2,
    });
  });

  it('maps every download flag', () => {
    const { options } = parseCli([
      'com.a.b',
      '-o', 'out',
      '-n', '{package}.{ext}',
      '-a', '1.2.3',
      '-f', 'xapk',
      '-x',
      '-s', 'fdroid',
      '-s', 'aptoide',
      '-c', '4',
      '--overwrite',
      '--no-verify',
      '--timeout', '5000',
      '--retries', '1',
      '--proxy', 'http://127.0.0.1:8080',
      '--user-agent', 'ua',
      '--allow-untrusted',
      '--json',
      '--verbose',
      '--no-color',
    ]);
    expect(options).toMatchObject({
      outDir: 'out',
      fileName: '{package}.{ext}',
      version: '1.2.3',
      format: 'xapk',
      extract: true,
      sources: ['fdroid', 'aptoide'],
      concurrency: 4,
      ifExists: 'overwrite',
      verify: false,
      timeout: 5000,
      retries: 1,
      proxy: 'http://127.0.0.1:8080',
      userAgent: 'ua',
      allowUntrusted: true,
      json: true,
      verbose: true,
      color: false,
    });
  });

  it('-a sets the app version and -V prints the tool version', () => {
    expect(parseCli(['com.a.b', '-a', '1.2']).options.version).toBe('1.2');
    expect(parseCli(['--app-version', '7', 'com.a.b']).options.version).toBe('7');
    expect(parseCli(['-V']).command).toBe('version');
    expect(parseCli(['--version']).command).toBe('version');
  });

  it('help wins over everything', () => {
    expect(parseCli(['-h']).command).toBe('help');
    expect(parseCli(['info', '--help']).command).toBe('help');
    expect(parseCli([]).command).toBe('help');
    expect(parseCli(['help']).command).toBe('help');
  });

  it('recognises subcommands', () => {
    expect(parseCli(['info', 'com.a.b', '--json'])).toMatchObject({ command: 'info', packages: ['com.a.b'] });
    expect(parseCli(['versions', 'com.a.b'])).toMatchObject({ command: 'versions', packages: ['com.a.b'] });
    expect(parseCli(['sources']).command).toBe('sources');
  });

  it('-i sets the input file', () => {
    expect(parseCli(['-i', '-']).options.input).toBe('-');
    expect(parseCli(['--input', 'list.txt']).options.input).toBe('list.txt');
  });

  it.each([
    [['com.a.b', '--overwrite', '--skip-existing'], /only one of/i],
    [['com.a.b', '--bogus'], /unknown option/i],
    [['com.a.b', '-f', 'zip'], /--format/],
    [['com.a.b', '-c', '0'], /--concurrency/],
    [['com.a.b', '--timeout', 'soon'], /--timeout/],
    [['com.a.b', '--retries', '-1'], /--retries/],
    [['info'], /exactly one package/i],
    [['info', 'a.b', 'c.d'], /exactly one package/i],
    [['versions'], /exactly one package/i],
    [['sources', 'a.b'], /does not take/i],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
    expect(() => parseCli(argv)).toThrow(message);
  });
});
