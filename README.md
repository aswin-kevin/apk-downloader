# apk-downloader

Download Android apps (APK and XAPK) **anonymously** from public sources, from Node.js or the command line.

- **Pluggable sources with automatic fallback**: Aptoide, F-Droid and APKPure are built in, and you can add your own.
- **Safe by default**: only files the source has verified are accepted, checksums are checked, partial files never land on disk, and XAPK extraction blocks path traversal.
- **Library and CLI** in one package: typed promise API (ESM + CommonJS) and a scriptable CLI with `--json` output.
- **Lightweight**: no browser, three small runtime dependencies.

```console
$ npx apk-downloader org.fdroid.fdroid
✔ org.fdroid.fdroid 2.0.3 → /home/me/org.fdroid.fdroid-2.0.3.apk (12.2 MB, fdroid)
```

## Contents

- [Install](#install)
- [Command line](#command-line)
- [Library](#library)
- [Sources and trust](#sources-and-trust)
- [Errors](#errors)
- [Migrating from v1](#migrating-from-v1)
- [Security](#security)
- [Development](#development)
- [Responsible use](#responsible-use)

## Install

Requires **Node.js 20.18.1 or newer**.

```sh
npm install apk-downloader      # as a library
npx apk-downloader --help       # or run the CLI without installing
```

## Command line

```sh
# Download one or more apps into the current directory
apk-downloader org.videolan.vlc org.fdroid.fdroid

# Choose the output directory and file name
apk-downloader org.videolan.vlc -o ./apks -n '{package}_{versionCode}.{ext}'

# A specific version (version name or version code)
apk-downloader org.videolan.vlc -a 13070206

# Many apps from a file (one per line, # comments allowed), four at a time
apk-downloader -i apps.txt -c 4

# Only use F-Droid, then Aptoide, in that order
apk-downloader org.fdroid.fdroid -s fdroid -s aptoide

# Machine-readable output for scripts
apk-downloader org.videolan.vlc --json | jq '.results[0].result.filePath'

# Look things up without downloading
apk-downloader info org.videolan.vlc
apk-downloader versions org.videolan.vlc
apk-downloader sources
```

| Option                                                | Description                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `-o, --out <dir>`                                     | Output directory (default: current directory)                                              |
| `-n, --name <template>`                               | File name template (default `{package}-{version}.{ext}`); also `{versionCode}`, `{source}` |
| `-a, --app-version <ver>`                             | Version name or version code (default: latest)                                             |
| `-f, --format <apk\|xapk\|auto>`                      | File format (default `auto`)                                                               |
| `-x, --extract`                                       | Extract APKs and OBB files from XAPK bundles into `<out>/<package>/`                       |
| `-s, --source <id>`                                   | Only use these sources, in this order (repeatable)                                         |
| `-i, --input <file\|->`                               | Read package names from a file or stdin                                                    |
| `-c, --concurrency <n>`                               | Parallel downloads (default 2)                                                             |
| `--overwrite` / `--skip-existing` / `--fail-existing` | What to do when the file exists (default: skip)                                            |
| `--no-verify`                                         | Skip checksum verification                                                                 |
| `--allow-untrusted`                                   | Accept files the source has not verified (never ones flagged as malware)                   |
| `--timeout <ms>`, `--retries <n>`                     | Network tuning (defaults 30000 and 3)                                                      |
| `--proxy <url>`                                       | HTTP(S) proxy (`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are honoured too)                |
| `--user-agent <ua>`                                   | Custom User-Agent                                                                          |
| `--json`, `-q, --quiet`, `--verbose`, `--no-color`    | Output control (`NO_COLOR` is honoured)                                                    |

**Exit codes:** `0` success, `1` a download or lookup failed, `2` usage error, `130` interrupted (Ctrl-C cancels cleanly; press it twice to force).

## Library

```ts
import { download } from 'apk-downloader';

const result = await download('org.videolan.vlc', { outDir: './apks' });
console.log(result.filePath, result.sha256, result.source);
```

CommonJS works too: `const { download } = require('apk-downloader')`.

### A configured client

```ts
import { ApkDownloader } from 'apk-downloader';

const client = new ApkDownloader({
  sources: ['aptoide', 'fdroid'], // fallback order (default: aptoide, apkpure, fdroid)
  timeout: 20_000, // per request, and the longest a download may stall
  retries: 3, // transient failures, with exponential backoff
  proxy: 'http://127.0.0.1:8080',
});

const result = await client.download('org.videolan.vlc', {
  outDir: './apks',
  version: 'latest',
  onProgress: ({ percent, bytesPerSecond }) => console.log(percent, bytesPerSecond),
});
```

### Download options

| Option           | Default                       | Description                                                                   |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `outDir`         | `process.cwd()`               | Destination directory (created if missing)                                    |
| `fileName`       | `'{package}-{version}.{ext}'` | Template; also `{versionCode}` and `{source}`. Always a single safe file name |
| `version`        | `'latest'`                    | Version name or version code                                                  |
| `format`         | `'auto'`                      | `'apk'`, `'xapk'` or `'auto'` (a complete APK first, else an XAPK bundle)     |
| `extract`        | `false`                       | Extract APKs/OBBs from an XAPK into `<outDir>/<package>/`                     |
| `ifExists`       | `'skip'`                      | `'skip'`, `'overwrite'` or `'error'`                                          |
| `verify`         | `true`                        | Verify the checksum published by the source                                   |
| `source`         | —                             | Use only this source, without fallback                                        |
| `allowUntrusted` | `false`                       | Accept files the source has not verified (never ones flagged as malware)      |
| `signal`         | —                             | `AbortSignal` to cancel                                                       |
| `onProgress`     | —                             | `({ transferred, total?, percent?, bytesPerSecond }) => void`                 |

The result:

```ts
interface DownloadResult {
  packageName: string;
  filePath: string; // absolute path
  format: 'apk' | 'xapk';
  size: number;
  sha256: string;
  source: string; // which source served it
  info: AppInfo; // name, version, developer, signer, trust, ...
  skipped: boolean; // true when the file already existed
  extractedFiles?: string[];
}
```

### Batch downloads

`downloadMany` never rejects because one app failed: every package gets its own result, in input order, and duplicates are removed.

```ts
const results = await client.downloadMany(['org.videolan.vlc', 'org.fdroid.fdroid'], {
  outDir: './apks',
  concurrency: 3,
  onItemProgress: (pkg, p) => console.log(pkg, p.percent),
  onItemDone: (item) => console.log(item.packageName, item.ok ? 'done' : item.error.message),
});
```

### Metadata without downloading

```ts
const info = await client.getInfo('org.videolan.vlc');
// { packageName, name, versionName, versionCode, size, developer, minSdk, signature, trust, source, ... }

const versions = await client.listVersions('org.videolan.vlc');
```

### Cancelling

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);
await download('org.videolan.vlc', { signal: controller.signal }); // rejects with AbortError
```

Cancelled or failed downloads never leave partial files behind, and an existing file at the destination is left untouched.

### Custom sources

A source turns a package name into a download URL. Implement the `Source` interface and register it:

```ts
import { ApkDownloader, AppNotFoundError, type Source } from 'apk-downloader';

const mirror: Source = {
  id: 'my-mirror',
  async getInfo(packageName, { http }) {
    const res = await http.request(`https://mirror.example.com/api/${packageName}`);
    if (res.status === 404) throw new AppNotFoundError(packageName, { source: 'my-mirror' });
    const app = await res.json();
    return { packageName, versionName: app.version, source: 'my-mirror' };
  },
  async resolve(packageName, options) {
    const info = await this.getInfo(packageName, options);
    return {
      source: 'my-mirror',
      url: `https://mirror.example.com/files/${packageName}.apk`,
      format: 'apk',
      info,
    };
  },
};

const client = new ApkDownloader();
client.registerSource(mirror); // appended to the fallback order
await client.download('com.example.app', { source: 'my-mirror' });
```

Throw `AppNotFoundError`, `VersionNotFoundError` or `SourceUnavailableError` so the client knows to try the next source. The `http` you receive already applies the configured timeout, retries, proxy and user agent.

## Sources and trust

| Source    | What it serves                       | Notes                                                                                                                                                                                                             |
| --------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aptoide` | Single APKs, with MD5 checksums      | A user-upload store. Only uploads Aptoide rates **TRUSTED** are accepted unless you pass `allowUntrusted` (uploads flagged as malware are always refused). The rating is in `info.trust`.                         |
| `fdroid`  | Official builds of open-source apps  | Signed by F-Droid, so the signature differs from Play Store builds. Apps that publish one APK per CPU architecture need an exact `versionCode` (see `versions`).                                                  |
| `apkpure` | APKs and XAPK bundles for split apps | Currently **unavailable from Node.js**: its download endpoint is behind bot protection that rejects Node's HTTP client. It reports `blocked` and the next source is used. This library does not try to bypass it. |

Default download order: `aptoide` → `apkpure` → `fdroid`. Metadata lookups use `aptoide` → `fdroid` → `apkpure`.

## Errors

Every error extends `ApkDownloaderError` and has a stable `code`:

| Error                    | `code`                   | When                                                                                 |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| `InvalidPackageError`    | `ERR_INVALID_PACKAGE`    | Not a valid Android package name                                                     |
| `AppNotFoundError`       | `ERR_APP_NOT_FOUND`      | No source has the app                                                                |
| `VersionNotFoundError`   | `ERR_VERSION_NOT_FOUND`  | The app exists but not that version                                                  |
| `AllSourcesFailedError`  | `ERR_ALL_SOURCES_FAILED` | Every source failed for different reasons; see `.errors`                             |
| `SourceUnavailableError` | `ERR_SOURCE_UNAVAILABLE` | A source cannot serve this request; `.reason` says why (`blocked`, `untrusted`, ...) |
| `NetworkError`           | `ERR_NETWORK`            | Connection or HTTP failure after retries                                             |
| `TimeoutError`           | `ERR_TIMEOUT`            | A request or download stalled                                                        |
| `ChecksumMismatchError`  | `ERR_CHECKSUM`           | The file does not match the source's checksum                                        |
| `FileExistsError`        | `ERR_FILE_EXISTS`        | The file exists and `ifExists` is `'error'`                                          |
| `FileSystemError`        | `ERR_FS`                 | Local disk problem (unwritable directory, disk full, ...)                            |
| `InvalidArchiveError`    | `ERR_INVALID_ARCHIVE`    | A corrupt XAPK, or one without any APK                                               |
| `UnsafeArchiveError`     | `ERR_UNSAFE_ARCHIVE`     | An XAPK entry would be written outside the destination                               |
| `InvalidOptionError`     | `ERR_INVALID_OPTION`     | Bad option, e.g. an unknown source id                                                |
| `AbortError`             | `ERR_ABORTED`            | Cancelled through the `AbortSignal`                                                  |

```ts
import { AppNotFoundError, download } from 'apk-downloader';

try {
  await download('com.example.app');
} catch (error) {
  if (error instanceof AppNotFoundError) console.log('No source has this app');
  else throw error;
}
```

## Migrating from v1

v2 is a rewrite; v1 relied on a website that no longer works.

- `downloadAPK(pkg)` still exists but is **deprecated**. It now returns a promise, so **await it**: an unhandled failure would otherwise crash Node.js. Use `download(pkg, { outDir: 'Downloads' })` instead.
- Files are named `<package>-<version>.apk` (v1 used `<package>.apk`) and go to the current directory unless you pass `outDir` (v1 used `./Downloads`).
- Node.js 20.18.1+ is required. Puppeteer and Chromium are no longer needed.

## Security

- Downloads are written to a temporary `.part` file, checked (ZIP signature, size, checksum when the source publishes one) and only then moved into place. SHA-256 is always reported.
- HTTPS downloads are never followed onto plain HTTP. HTML or challenge pages are never saved as APKs.
- File names are always a single sanitised path segment, whatever the upstream metadata says.
- The project pins every dependency to an exact version, disables npm install scripts, verifies registry signatures in CI and pins GitHub Actions to commit SHAs. The runtime dependencies are [`undici`](https://github.com/nodejs/undici) (from the Node.js project, loaded only for proxies), [`yauzl`](https://github.com/thejoshwolfe/yauzl) and its single dependency `pend`.

An APK from any third-party source is still third-party software: check `info.signature` against the developer's known certificate before installing anything important.

## Development

```sh
npm ci                # install (lifecycle scripts are disabled by .npmrc)
npm run verify        # typecheck, lint, format check, unit tests (offline)
npm run test:live     # live tests against the real sources (downloads tens of MB)
npm run build
npm run release       # verify, build, check the package contents, publish
```

Publish with `npm run release` rather than `npm publish`: because `.npmrc` disables lifecycle scripts, npm's `prepublishOnly` hook would not run.

## Responsible use

This tool downloads **free, publicly available** apps from third-party mirrors. Respect the terms of the sources you use and the rights of app developers: do not use it to obtain paid apps or to redistribute software you have no right to share.

## License

[MIT](./LICENSE) © 2020-2026 Aswin Venkat
