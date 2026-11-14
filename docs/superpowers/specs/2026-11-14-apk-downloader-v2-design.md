# apk-downloader v2 — Design

Date: 2026-11-14
Status: Draft for approval

## 1. Intent

`apk-downloader` v1 (2020) downloaded Android apps by driving a headless Chrome
(Puppeteer) against `apk.support`. It no longer works: `apk.support` times out,
`request` is deprecated, and the API is fire-and-forget with global state.

v2 is a ground-up rewrite, published as a **public npm package for developers**
under the same name (`apk-downloader@2.0.0`). It ships as both:

- a **library** — typed, promise-based, predictable errors, embeddable in other tools;
- a **CLI** — `npx apk-downloader <package>` for direct use and scripting.

The why: production-grade quality — readable code, a clean extensible design,
and resilience to the thing that killed v1 (a single upstream site changing).

## 2. Goals, non-goals, anti-goals

**Goals**
- Anonymous downloads of public Android apps by package name.
- Pluggable "sources" with automatic fallback; users can pin a source or add their own.
- First-class library API (ESM + CJS + `.d.ts`) and a polished CLI from one codebase.
- Rich options: output dir/filename, version, overwrite policy, timeout, retries,
  proxy, cancellation, progress, user agent, concurrency for batches.
- Metadata lookup without downloading.
- APK and XAPK (split APK bundle) support, with optional XAPK extraction.
- Integrity: verify checksums when a source provides them; always report SHA-256.
- Lightweight: no browser, minimal dependencies.

**Non-goals**
- Google Play login / account-based downloads (explicitly excluded by owner).
- Installing APKs to devices (adb), decompiling, or analysing APKs.
- Browser support — Node only.
- Paid apps or anything requiring authentication.

**Anti-goals** (failure even if it "works")
- Pulling in Puppeteer/Chromium or any multi-hundred-MB dependency.
- Silent failure: every failure must surface as a typed error / non-zero exit.
- Leaving partial/corrupt files at the destination path.
- A design where one upstream site change breaks every user with no workaround.

## 3. Constraints

- **Runtime:** Node.js ≥ 20 (built-in `fetch`, `AbortSignal.timeout`, `node:util.parseArgs`, `node:stream/promises`).
- **Development split:** code is edited/committed/pushed on the owner's Mac;
  *nothing is installed, built, run or downloaded there*. All `npm install`,
  builds, tests and live downloads happen on Kali (`elliot@kali.local`) under `/tmp`.
  Kali has no Node: install a Node tarball into `/tmp/apkdl/node` (self-contained;
  cleanup = `rm -rf /tmp/apkdl`). Code is synced Mac → Kali with `rsync`
  (excluding `node_modules`, `dist`). `package-lock.json` is generated on Kali and
  copied back to the Mac for commit.
- Kali `/tmp` is a 3.8 GB tmpfs — live tests use small apps, never WhatsApp-size files.
- README and LICENSE are rewritten **last**, after code is done.
- At the end: remove `/tmp/apkdl` on Kali and any stray artifacts on the Mac.

## 4. Upstream sources (verified from Kali, 2026-11-14)

| Source | Status | Notes |
|---|---|---|
| **APKPure** | ✅ works | `GET https://d.apkpure.com/b/{APK\|XAPK}/{pkg}?version=latest` → 302 to `data.winudf.com` with `filename`, `full_size` in query; final response has `content-length`, `content-disposition`. Unknown package → 404. Specific version: `?versionCode=<code>` (to be confirmed during implementation). No checksum. |
| **Aptoide** | ✅ works | `GET https://ws75.aptoide.com/api/7/app/getMeta?package_name={pkg}` → JSON with name, developer, icon, `file.vername`, `file.vercode`, `file.md5sum`, `file.filesize`, `file.path`, `file.signature.{sha1,owner}`, `file.hardware.{sdk,cpus}`, `file.malware.rank`. Not found → `status: FAIL`, error code `APP-1`. Versions: `api/7/listAppVersions?package_name=…`. Plain APK only. |
| apk.support (v1) | ❌ timeout | dropped |
| APKMirror | ❌ 403 (Cloudflare) | excluded |
| ApkCombo, apkpure.com pages | ❌ timeout | excluded (only the `d.apkpure.com` endpoint is used) |
| Uptodown | ⚠️ 200, HTML only | possible future source; not in v2.0 |

Default source order: **APKPure → Aptoide**. (APKPure first because it covers
XAPK/split apps; Aptoide is the fallback and provides checksums + richer metadata.)

## 5. Approaches considered

- **A. Single hard-wired source (APKPure).** Simplest, fastest to ship. One upstream
  change breaks every user until a release — the v1 failure mode. Rejected.
- **B. Pluggable sources with fallback. ← chosen by owner.** Each site is a small
  module implementing a common `Source` interface; the core tries sources in order;
  users can pin (`--source`) or register custom sources. More up-front design, but a
  broken site is a one-module fix and users can route around it themselves.
- **C. Headless-browser scraping (like v1).** Gets past some bot protection but costs
  ~150 MB Chromium, is slow and layout-fragile. Rejected as core; could be a separate
  opt-in plugin package later if a site ever requires it.

## 6. Architecture

```
src/
  index.ts              public library exports
  client.ts             ApkDownloader class (core orchestration)
  types.ts              public types/interfaces
  errors.ts             error hierarchy
  sources/
    source.ts           Source interface + helpers
    apkpure.ts
    aptoide.ts
    index.ts            built-in registry, default order
  http/
    fetch.ts            fetch wrapper: UA, timeout, retries/backoff, proxy, abort
    retry.ts
  download/
    downloader.ts       streaming to temp file, progress, hashing, atomic rename
    xapk.ts             XAPK (zip) extraction
  util/
    filename.ts         safe filename templating
    concurrency.ts      tiny p-limit equivalent
  cli/
    main.ts             arg parsing, commands, exit codes
    progress.ts         TTY progress bar (no dep)
    output.ts           human vs --json output
bin/apk-downloader.js   shebang shim → dist/cli
test/
  unit/                 mocked HTTP, no network
  live/                 real network, opt-in (APKDL_LIVE=1), run only on Kali
```

### 6.1 Source interface

```ts
interface Source {
  readonly id: string;                         // 'apkpure' | 'aptoide' | custom
  getInfo(pkg: string, opts: ResolveOptions): Promise<AppInfo>;
  resolve(pkg: string, opts: ResolveOptions): Promise<ResolvedDownload>;
  listVersions?(pkg: string, opts: ResolveOptions): Promise<AppVersion[]>;
}

interface ResolveOptions {
  version?: string | 'latest';     // versionName or versionCode
  format?: 'apk' | 'xapk' | 'auto';
  signal?: AbortSignal;
  http: HttpClient;                // shared, preconfigured (UA, proxy, retries)
}

interface ResolvedDownload {
  source: string;
  url: string;
  format: 'apk' | 'xapk';
  fileName?: string;               // suggested by upstream
  size?: number;
  checksum?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string };
  info: AppInfo;
  headers?: Record<string, string>;
}

interface AppInfo {
  packageName: string;
  name?: string;
  versionName?: string;
  versionCode?: number;
  size?: number;
  developer?: string;
  iconUrl?: string;
  minSdk?: number;
  architectures?: string[];
  signature?: { sha1?: string; owner?: string };
  source: string;
}
```

Sources must throw the typed errors in §6.4 (`AppNotFoundError` vs
`SourceUnavailableError`) so the client can decide whether to fall back.

### 6.2 Public library API

```ts
import { ApkDownloader, download, getInfo } from 'apk-downloader';

// Convenience functions (use a default client)
const result = await download('com.example.app', { outDir: './apks' });
const info   = await getInfo('com.example.app');

// Configured client
const client = new ApkDownloader({
  sources: ['apkpure', 'aptoide'],   // order = fallback order; ids or Source objects
  timeout: 30_000,                   // per request (ms)
  retries: 3,                        // with exponential backoff + jitter
  proxy: 'http://127.0.0.1:8080',    // also honours HTTPS_PROXY env
  userAgent: '...',
});

await client.download(pkg, options);
await client.downloadMany(pkgs, { concurrency: 3, ...options }); // never rejects for per-item failure
await client.getInfo(pkg, { source? });
await client.listVersions(pkg, { source? });
client.registerSource(mySource);
```

`DownloadOptions`:
| Option | Default | Meaning |
|---|---|---|
| `outDir` | `process.cwd()` | destination directory (created if missing) |
| `fileName` | `'{package}-{version}.{ext}'` | template: `{package} {version} {versionCode} {source} {ext}` |
| `version` | `'latest'` | versionName or versionCode |
| `format` | `'auto'` | `apk` \| `xapk` \| `auto` (prefer APK, fall back to XAPK when app is split) |
| `extract` | `false` | if result is XAPK, also extract contained `.apk`s (and OBBs) to `<outDir>/<package>/` |
| `ifExists` | `'skip'` | `skip` \| `overwrite` \| `error` |
| `verify` | `true` | verify checksum when source supplies one |
| `source` | — | pin to one source (no fallback) |
| `signal` | — | `AbortSignal` for cancellation |
| `onProgress` | — | `({ transferred, total?, percent?, bytesPerSecond }) => void` |

`DownloadResult`:
`{ packageName, filePath, format, size, sha256, source, info, skipped, extractedFiles? }`

`downloadMany` returns `Array<{ packageName, ok: true, result } | { packageName, ok: false, error }>`.

**Back-compat:** keep `downloadAPK(pkg)` as a deprecated alias of `download(pkg, { outDir: 'Downloads' })`,
now returning the promise. Emits a one-time deprecation warning.

### 6.3 Download pipeline

1. Validate package name (`/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/`) → `InvalidPackageError`.
2. For each source in order (or the pinned one): `resolve()`.
   - `AppNotFoundError` / `VersionNotFoundError` → record, try next.
   - `SourceUnavailableError` / `NetworkError` (after retries) → record, try next.
   - All failed → `AllSourcesFailedError` with per-source causes. If every cause was
     not-found → throw `AppNotFoundError` instead (clearer for users).
3. Compute target path; apply `ifExists`.
4. Stream body to `<target>.part` in the same dir, hashing SHA-256 (+ source's
   algorithm if different) and reporting progress (throttled ~10/s).
5. Verify size (if known) and checksum → `ChecksumMismatchError`; delete `.part` on any failure/abort.
6. Atomic `rename` to target. Optionally extract XAPK.

### 6.4 Errors

All extend `ApkDownloaderError` (with `code` string, `cause`, and `source?`):
`InvalidPackageError`, `AppNotFoundError`, `VersionNotFoundError`,
`SourceUnavailableError`, `NetworkError` (status?, url), `TimeoutError`,
`ChecksumMismatchError` (expected, actual), `FileExistsError`, `AbortError`
(re-uses standard `AbortError` name), `AllSourcesFailedError` (`errors[]`).

### 6.5 HTTP layer

- Built-in `fetch`; `undici` `ProxyAgent` only when a proxy is set (explicit option or `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`).
- Retries on network errors, 408/425/429/5xx; honours `Retry-After`; exponential backoff with jitter; never retries 4xx otherwise.
- Per-request timeout combined with caller's `signal` via `AbortSignal.any`.
- Default UA: a current desktop Chrome UA string (sources may override).

### 6.6 CLI

```
apk-downloader <package...> [options]          # download (default command)
apk-downloader info <package> [--source s] [--json]
apk-downloader versions <package> [--source s] [--json]
apk-downloader sources                          # list built-in sources

Download options:
  -o, --out <dir>            output directory (default: cwd)
  -n, --name <template>      filename template
  -a, --app-version <ver>    version name or code (default: latest)
  -f, --format <apk|xapk|auto>
  -x, --extract              extract XAPK contents
  -s, --source <id>          pin a source (repeatable to set order)
  -i, --input <file|->       read package names from file or stdin (one per line, # comments)
  -c, --concurrency <n>      parallel downloads (default 2)
      --overwrite | --skip-existing | --fail-existing
      --no-verify
      --timeout <ms>  --retries <n>  --proxy <url>  --user-agent <ua>
      --json                 machine-readable output (one JSON doc on stdout)
  -q, --quiet  --verbose  --no-color
  -h, --help  -V, --version
```

- Arg parsing: `node:util.parseArgs` (zero deps). Colors: `NO_COLOR`/TTY aware, hand-rolled.
- Progress bar on TTY stderr only; plain line logs when not a TTY; nothing but JSON on stdout in `--json` mode.
- Exit codes: `0` all ok, `1` any download failed, `2` usage error, `130` interrupted (SIGINT cancels in-flight downloads and cleans `.part` files).

### 6.7 Packaging & tooling (builder's call where unstated)

- TypeScript (strict), built with `tsup` to `dist/` as ESM + CJS + `.d.ts`; `exports` map; `bin`.
- Runtime deps: `undici` (proxy only), `yauzl` (XAPK extraction). Nothing else.
- Dev: `typescript`, `tsup`, `vitest`, `eslint` (flat config, typescript-eslint), `prettier`.
- `package.json`: `"engines": { "node": ">=20" }`, `"files": ["dist", "bin"]`, `"type": "module"`, `sideEffects: false`.
- Repo: `https://github.com/aswin-kevin/apk-downloader` (fix stale v1 URLs).
- CI: GitHub Actions workflow running lint, typecheck, unit tests on Node 20/22/24 (written, not run locally).
- `CHANGELOG.md` with the v2 breaking-change notes.

## 7. Testing

- **Unit (offline):** sources parsed against recorded fixture responses; HTTP layer
  (retries, Retry-After, timeout, abort); download pipeline (progress, checksum
  mismatch, `.part` cleanup, `ifExists`); filename templating; XAPK extraction with
  a tiny fixture zip; CLI arg parsing, exit codes, JSON output. Mock via a local
  `http.createServer` or injected `fetch` — no real network.
- **Live (opt-in, `APKDL_LIVE=1`, Kali only):** for each built-in source: info,
  versions, download of a small app, not-found handling; XAPK download+extract of a
  small split app; CLI end-to-end.
- All test execution happens on Kali under `/tmp/apkdl`.

## 8. Decisions settled after review

**Owner decisions**
- **Delivery:** commit and push directly to `main` on `github.com/aswin-kevin/apk-downloader`.
  Stop there; the owner decides on npm publishing / tags / release automation afterwards.
- **Repo/npm identity:** the old `2016508006` GitHub account is the owner's renamed
  account (now `aswin-kevin`); the owner holds the `apk-downloader` npm name. Update all
  URLs in `package.json` to `aswin-kevin`.
- **LICENSE / README:** rewritten last; license terms and holder confirmed with the owner then.

**Calls made by the designer (owner may override)**
- **Kali access:** passwordless SSH + rsync to `elliot@kali.local` is verified working, so
  the builder runs the sync → test → fix loop directly. First task: provision Node into
  `/tmp/apkdl/node` and confirm the loop.
- **`format: 'auto'` and split apps:** never return a base-only APK for a split app
  (that is a silent-failure anti-goal). Per source, `auto` tries a complete APK first,
  then XAPK, before moving to the next source. A source that can only provide an
  incomplete artifact for a split app throws `SourceUnavailableError` (reason
  `split-unsupported`) for that request, and fallback proceeds. How each source detects
  "split" is verified live on Kali (APKPure APK endpoint behaviour for split apps; Aptoide
  metadata fields such as splits/OBB).
- **Metadata (`getInfo`, `listVersions`):** use a separate default order, **Aptoide →
  APKPure**, because Aptoide has the rich data. `getInfo` takes the first source that
  answers (no merging). APKPure's `getInfo` is minimal (package, version, size, format,
  from the redirect) and `listVersions` is optional, so APKPure doesn't implement it.
  `DownloadResult.info` comes from the source that served the download.
- **Sources stay independent:** no source calls another. If APKPure can't resolve a
  requested version (e.g. it only accepts versionCode), it throws `VersionNotFoundError`
  and fallback moves on to Aptoide.
- **CLI flags:** `-V, --version` prints the tool version (convention). The app version is
  `-a, --app-version <ver>`. This replaces `-v, --version <ver>` in §6.6.

## 9. Left to the builder

- Exact APKPure query param for specific versions (verify live).
- Choice of small test apps for live tests (APK and XAPK cases).
- Internal module boundaries beyond §6 layout; lint rule specifics.
