# apk-downloader v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `apk-downloader` as a production-grade TypeScript library + CLI that downloads public Android apps anonymously from pluggable sources (APKPure, Aptoide) with fallback.

**Architecture:** A `Source` interface per upstream site; an `HttpClient` that owns timeouts/retries/proxy; a streaming downloader that writes `.part` files, hashes, verifies and atomically renames; an `ApkDownloader` client that orchestrates fallback; a zero-dependency CLI on top of the client.

**Tech Stack:** TypeScript (strict), Node ≥ 20, tsup (ESM+CJS+d.ts), vitest, eslint (flat, typescript-eslint), prettier, runtime deps `undici` (proxy only) and `yauzl` (XAPK).

**Spec:** `docs/superpowers/specs/2026-11-14-apk-downloader-v2-design.md` — read it alongside this plan; §6 types are authoritative.

## Global Constraints

- **Nothing runs on the Mac** except editing, `git`, `rsync`, `ssh`. No `npm install`, builds, tests or downloads locally.
- All execution on Kali (`elliot@kali.local`) under `/tmp/apkdl`: Node in `/tmp/apkdl/node`, repo copy in `/tmp/apkdl/repo`, npm cache in `/tmp/apkdl/npm-cache`, live-download output in `/tmp/apkdl/out`.
- Every "Run" step below means: **sync, then run remotely**:
  ```bash
  rsync -a --delete --exclude node_modules --exclude dist --exclude .git ./ elliot@kali.local:/tmp/apkdl/repo/
  ssh elliot@kali.local 'cd /tmp/apkdl/repo && export PATH=/tmp/apkdl/node/bin:$PATH npm_config_cache=/tmp/apkdl/npm-cache && <CMD>'
  ```
  Keep this as `scratchpad/kali.sh <CMD>` (session scratchpad, not committed).
- After any dependency change: run `npm install` on Kali, then `rsync elliot@kali.local:/tmp/apkdl/repo/package-lock.json ./` and commit it.
- Kali `/tmp` is a 3.8 GB tmpfs: live tests use small apps only.
- Node `>=20`; `"type": "module"`; runtime deps only `undici`, `yauzl`.
- Package name `apk-downloader`, version `2.0.0`, repo `https://github.com/aswin-kevin/apk-downloader`.
- Default download source order `['aptoide', 'apkpure', 'fdroid']`; default metadata order `['aptoide', 'fdroid', 'apkpure']` (amended — spec §9).
- Supply chain: exact version pins, `.npmrc` `ignore-scripts=true` + `save-exact=true`, `npm audit` clean, no new dependency without owner approval.
- Defaults: `timeout` 30000 ms, `retries` 3, `fileName` `'{package}-{version}.{ext}'`, `format` `'auto'`, `ifExists` `'skip'`, `verify` true, CLI `concurrency` 2.
- CLI: `-V/--version` = tool version; `-a/--app-version` = app version. Exit codes 0 / 1 / 2 / 130.
- Commit after every task to `main`; push at the end of each task. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- README and LICENSE are **not** touched until Task 11 (owner-confirmed).

## Review Focus

1. **Blocked/HTML response instead of an APK** (captcha, error page with 200) — must not be saved as `.apk`; expect `SourceUnavailableError` and fallback. → Task 6 test `rejects non-zip body`.
2. **Ctrl-C / abort mid-download** — no `.part` left, pre-existing target untouched, `AbortError`. → Task 6 test `abort cleans up part file`; Task 9 SIGINT → exit 130.
3. **Path traversal from upstream data** (`versionName` like `../../x`, odd `content-disposition`, user template with `/`) — file must land inside `outDir`. → Task 2 test `sanitizes template values`.
4. **Missing `content-length`** — progress reports `total: undefined`, `percent: undefined`, no crash, size check skipped. → Task 6 test `progress without content-length`.
5. **Same package twice in a batch** (`downloadMany(['a.b','a.b'])`) — deduplicated, one download, one result per unique package. → Task 8 test `dedupes packages`.

---

### Task 1: Kali environment + project scaffold

**Files:**
- Delete: `index.js`, old `package-lock.json`
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `.npmignore`-free (use `files`), `src/index.ts` (placeholder `export const VERSION`), `test/unit/smoke.test.ts`
- Scratch (not committed): `<scratchpad>/kali.sh`

- [ ] **Step 1: Provision Kali.** Download the latest Node 22 LTS linux-x64 tarball with `curl` on Kali, extract to `/tmp/apkdl/node`. Verify: `/tmp/apkdl/node/bin/node -v` prints `v22.*`.
- [ ] **Step 2: Write `package.json`:** name/version/description, `"type": "module"`, `exports` (`.` → `import: ./dist/index.js`, `require: ./dist/index.cjs`, `types`), `main`/`module`/`types`, `bin: { "apk-downloader": "./bin/apk-downloader.js" }`, `files: ["dist","bin"]`, `engines.node ">=20"`, `sideEffects: false`, scripts `build`, `typecheck` (`tsc --noEmit`), `lint`, `format`, `test` (`vitest run test/unit`), `test:live` (`APKDL_LIVE=1 vitest run test/live`), `prepublishOnly` (`npm run typecheck && npm run lint && npm test && npm run build`). Keywords, author `Aswin Venkat`, license `MIT`, repo/bugs/homepage under `aswin-kevin`.
- [ ] **Step 3: Configs.** tsconfig strict + `noUncheckedIndexedAccess`, `module`/`moduleResolution` `NodeNext`, target `ES2022`. tsup entries `src/index.ts` and `src/cli/main.ts`, formats `esm,cjs`, `dts: true` (index only), `clean`. Smoke test asserts `VERSION === '2.0.0'`.
- [ ] **Step 4: Install on Kali:** `npm i -D typescript tsup vitest eslint typescript-eslint @eslint/js prettier @types/node @types/yauzl` and `npm i undici yauzl`. Copy lockfile back.
- [ ] **Step 5: Run** `npm run typecheck && npm run lint && npm test && npm run build`. Expected: all pass; `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` exist.
- [ ] **Step 6: Commit** `chore: scaffold v2 TypeScript project, remove v1 implementation`.

### Task 2: Errors, types, validation, filename templating

**Files:**
- Create: `src/errors.ts`, `src/types.ts`, `src/util/package-name.ts`, `src/util/filename.ts`
- Test: `test/unit/errors.test.ts`, `test/unit/package-name.test.ts`, `test/unit/filename.test.ts`

**Interfaces — Produces:**
- `src/types.ts`: exactly the spec §6.1/§6.2 types: `Source`, `ResolveOptions`, `ResolvedDownload`, `AppInfo`, `AppVersion { versionName: string; versionCode?: number; size?: number; added?: string }`, `ApkFormat = 'apk'|'xapk'`, `FormatOption = ApkFormat|'auto'`, `IfExists = 'skip'|'overwrite'|'error'`, `Progress { transferred: number; total?: number; percent?: number; bytesPerSecond: number }`, `DownloadOptions`, `DownloadResult`, `BatchResult`, `ClientOptions { sources?: (string|Source)[]; infoSources?: (string|Source)[]; timeout?: number; retries?: number; proxy?: string; userAgent?: string; fetch?: typeof fetch }`.
- `src/errors.ts`: `ApkDownloaderError extends Error { code: string; source?: string }` and subclasses with codes: `InvalidPackageError` `ERR_INVALID_PACKAGE`, `AppNotFoundError` `ERR_APP_NOT_FOUND`, `VersionNotFoundError` `ERR_VERSION_NOT_FOUND`, `SourceUnavailableError` `ERR_SOURCE_UNAVAILABLE` (+ `reason?: string`), `NetworkError` `ERR_NETWORK` (+ `status?`, `url`), `TimeoutError` `ERR_TIMEOUT`, `ChecksumMismatchError` `ERR_CHECKSUM` (+ `expected`, `actual`), `FileExistsError` `ERR_FILE_EXISTS` (+ `path`), `AbortError` (`name = 'AbortError'`, `ERR_ABORTED`), `AllSourcesFailedError` `ERR_ALL_SOURCES_FAILED` (+ `errors: ApkDownloaderError[]`). All accept `{ cause }`.
- `assertPackageName(pkg: string): void` — regex from spec §6.3.
- `renderFileName(template: string, vars: { package: string; version?: string; versionCode?: number; source: string; ext: string }): string`

- [ ] **Step 1: Failing tests.** `errors`: each class `instanceof ApkDownloaderError`, has its code, preserves `cause`. `package-name`: accepts `com.whatsapp`, `a.b_c.d1`; rejects `whatsapp`, `com..x`, `1com.x`, `com/x`, `''`. `filename`: `renderFileName('{package}-{version}.{ext}', {package:'a.b',version:'1.0',source:'aptoide',ext:'apk'}) === 'a.b-1.0.apk'`; missing version → `'latest'`; **`sanitizes template values`**: version `'../../x'` and template `'{package}/../{version}.{ext}'` produce a name with no `/`, `\`, or leading `.`, and `path.basename(result) === result`; result length ≤ 200.
- [ ] **Step 2: Run** `npx vitest run test/unit/errors.test.ts test/unit/package-name.test.ts test/unit/filename.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement.** Sanitize each substituted value *and* the final string: replace `[\/\\:*?"<>|\x00-\x1f]` with `_`, strip leading dots.
- [ ] **Step 4: Run** same command → PASS; plus `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: add error hierarchy, public types, validation and filename templating`.

### Task 3: HTTP layer

**Files:**
- Create: `src/http/retry.ts`, `src/http/client.ts`
- Test: `test/unit/http.test.ts` (uses a local `http.createServer` on port 0)

**Interfaces — Produces:**
- `computeBackoff(attempt: number, retryAfter?: string | null): number` — base 500 ms × 2^attempt, ±20% jitter, cap 30 s; `Retry-After` (seconds or HTTP date) wins, capped 60 s.
- `class HttpClient { constructor(opts: { timeout: number; retries: number; userAgent: string; proxy?: string; fetch?: typeof fetch }); request(url: string, init?: RequestInit & { signal?: AbortSignal; timeout?: number | false }): Promise<Response>; json<T>(url: string, init?): Promise<T> }`
  - Retries network errors and status 408/425/429/500/502/503/504; returns the `Response` for all other statuses (sources interpret 404 etc.).
  - After retries exhausted: `NetworkError` (with `status` when HTTP).
  - Per-attempt timeout via `AbortSignal.timeout`, merged with caller signal via `AbortSignal.any`; timeout → `TimeoutError`; caller abort → `AbortError` (never retried).
  - `timeout: false` disables per-request timeout (used for body streaming; downloader applies an idle timeout instead).
  - Proxy: explicit `proxy`, else `HTTPS_PROXY`/`HTTP_PROXY` (respect `NO_PROXY`) → lazily `import('undici')` and pass `dispatcher: new ProxyAgent(url)`.
  - Sets `user-agent` header unless caller supplies one.
- `DEFAULT_USER_AGENT` constant (desktop Chrome 130 UA).

- [ ] **Step 1: Failing tests:** `retries 503 then succeeds` (3 hits, final 200); `honours Retry-After` (via `computeBackoff(0,'2') === 2000`); `does not retry 404` (1 hit, status 404 returned); `throws NetworkError after retries` (`status === 503`); `timeout raises TimeoutError` (server never responds, `timeout: 100`); `caller abort raises AbortError and does not retry`; `sends user-agent`. Use `retries: 2` and stub backoff to 0 via an injected `sleep` option or `vi.useFakeTimers`.
- [ ] **Step 2: Run** `npx vitest run test/unit/http.test.ts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS; `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** `feat: add HTTP client with retries, timeouts, abort and proxy support`.

### Task 4: Aptoide source

**Files:**
- Create: `src/sources/aptoide.ts`, `test/fixtures/aptoide/getMeta-ok.json`, `getMeta-notfound.json`, `listAppVersions-ok.json` (+ any split-app fixture)
- Test: `test/unit/sources/aptoide.test.ts`

**Interfaces — Consumes:** `Source`, `ResolveOptions`, `HttpClient.json`, errors. **Produces:** `export const aptoide: Source` with `id: 'aptoide'`, `getInfo`, `resolve`, `listVersions`.

- [ ] **Step 1: Record fixtures live on Kali** with `curl` for a small app (choose one < 10 MB, e.g. an F-Droid-style app present on Aptoide) and a non-existent package; trim to relevant fields. Also find a known split/OBB app and record whether `getMeta` exposes splits (`data.file` keys like `splits`, `obb`) — note result in a code comment.
- [ ] **Step 2: Failing tests** (inject a fake `HttpClient` returning fixtures): `getInfo maps fields` (name, versionName, versionCode, size, developer, iconUrl, minSdk from `hardware.sdk`, architectures from `hardware.cpus`, signature sha1/owner, `source: 'aptoide'`); `not found → AppNotFoundError` (status FAIL, code `APP-1`); other FAIL → `SourceUnavailableError`; `resolve latest` → url = `file.path`, format `apk`, checksum `{algorithm:'md5', value}`, size; `resolve version by name` and `by code` → uses `listAppVersions`, then `getMeta?package_name=…&vercode=…`; unknown version → `VersionNotFoundError`; `format: 'xapk'` → `SourceUnavailableError` reason `format-unsupported`; split app → `SourceUnavailableError` reason `split-unsupported`; `listVersions` maps to `AppVersion[]`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** Base `https://ws75.aptoide.com/api/7`. Verify the `vercode` query param live before relying on it; if absent, take `path` from the matching `listAppVersions` entry.
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** `feat: add Aptoide source`.

### Task 5: APKPure source

**Files:**
- Create: `src/sources/apkpure.ts`, `test/fixtures/apkpure/*.txt` (recorded status + location headers)
- Test: `test/unit/sources/apkpure.test.ts`

**Interfaces — Produces:** `export const apkpure: Source` with `id: 'apkpure'`, `getInfo`, `resolve` (no `listVersions`).

- [ ] **Step 1: Live investigation on Kali** (curl, headers only, `-o /dev/null`), record findings as a comment block at top of `apkpure.ts`: (a) param for specific version — try `?versionCode=`, `?version=<name>`; (b) what `/b/APK/` returns for a known split app (404? base APK? XAPK filename?) — this defines split detection; (c) status for unknown package (404 confirmed).
- [ ] **Step 2: Failing tests** (fake fetch returning 302 + `location`): `resolve latest apk` → `request(..., { redirect: 'manual' })`, url = location, `fileName` from `filename` query param, `size` from `full_size`, versionName parsed from filename `<Name>_<ver>_APKPure.apk`; `404 → AppNotFoundError`; `auto tries APK then XAPK` (APK path signals split → XAPK resolved, format `xapk`); `unknown version → VersionNotFoundError`; 403/other → `SourceUnavailableError`; `getInfo` returns minimal `AppInfo` built from the same redirect.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** per findings. **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: add APKPure source`.

### Task 5b: F-Droid source (added — spec §9)

**Files:** Create `src/sources/fdroid.ts`, fixtures `test/fixtures/fdroid/*.json`; Test `test/unit/sources/fdroid.test.ts`.

**Interfaces — Produces:** `createFdroidSource({ baseUrl? }): Source`, `fdroid: Source` (`id: 'fdroid'`, `getInfo`, `resolve`, `listVersions`).

- [ ] Failing tests: getInfo/listVersions map `api/v1/packages/<pkg>`; 404 `{"error":"NOT_FOUND"}` → `AppNotFoundError`; resolve latest = suggestedVersionCode confirmed by HEAD on `/repo/<pkg>_<code>.apk`, falling back to the next newest listed code on 404 (max 3 HEADs) → else `SourceUnavailableError` reason `not-hosted`; size from `content-length`; specific version by name or code, missing file → `VersionNotFoundError`; `format: 'xapk'` → `format-unsupported`.
- [ ] Implement, run, commit `feat: add F-Droid source`.

### Task 6: Streaming download pipeline

**Files:**
- Create: `src/download/downloader.ts`
- Test: `test/unit/downloader.test.ts` (local HTTP server serving a tiny zip fixture built in-test)

**Interfaces — Produces:**
`downloadToFile(args: { http: HttpClient; resolved: ResolvedDownload; target: string; verify: boolean; signal?: AbortSignal; onProgress?: (p: Progress) => void; idleTimeout?: number }): Promise<{ size: number; sha256: string }>`
(`ifExists` is decided by the client before calling; this function always writes `target`.)

- [ ] **Step 1: Failing tests:** `writes file and returns sha256`; `no .part left on success`; `size mismatch → NetworkError and no files`; `checksum mismatch → ChecksumMismatchError` (md5 given); `verify:false skips checksum`; **`rejects non-zip body`** (200 `text/html` body → `SourceUnavailableError` reason `not-an-apk`, checks first bytes `PK\x03\x04`); **`abort cleans up part file`** (abort mid-stream; `.part` gone; pre-existing `target` content unchanged; rejects `AbortError`); **`progress without content-length`** (chunked response; progress called with `total === undefined`, `percent === undefined`); progress throttled (≤ ~10 calls/s) and final call has `transferred === size`; idle timeout → `TimeoutError`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: `http.request(url, { timeout: false, headers: resolved.headers })`, `pipeline(Readable.fromWeb(body), hashTransform, createWriteStream(part))`, md5 alongside sha256 when needed, then `rename`. `mkdir -p` dir. Default `idleTimeout` 60 s.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat: add streaming downloader with hashing, verification and atomic writes`.

### Task 7: XAPK extraction

**Files:** Create `src/download/xapk.ts`; Test `test/unit/xapk.test.ts` (fixture zip generated in-test with yauzl-compatible writer — use `zlib` + hand-built store-only zip helper in `test/helpers/zip.ts`).

**Interfaces — Produces:** `extractXapk(file: string, destDir: string): Promise<string[]>` — extracts `*.apk` and `Android/obb/**` entries plus `manifest.json`; returns absolute paths.

- [ ] **Step 1: Failing tests:** extracts apks + obb preserving `Android/obb/<pkg>/` subpath; ignores other entries; **zip-slip**: entry `../evil.apk` is rejected (throws `ApkDownloaderError` code `ERR_UNSAFE_ARCHIVE`, add this class to `errors.ts`); corrupt zip → same-family error.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `yauzl` (lazy import). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add XAPK extraction`.

### Task 8: ApkDownloader client + public exports

**Files:**
- Create: `src/client.ts`, `src/sources/index.ts`, `src/util/concurrency.ts`; Modify: `src/index.ts`
- Test: `test/unit/client.test.ts`, `test/unit/concurrency.test.ts`

**Interfaces — Consumes:** everything above. **Produces:**
- `src/sources/index.ts`: `builtinSources: Record<string, Source>`, `DEFAULT_SOURCES = ['apkpure','aptoide']`, `DEFAULT_INFO_SOURCES = ['aptoide','apkpure']`.
- `pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T>`
- `class ApkDownloader { constructor(opts?: ClientOptions); download(pkg: string, opts?: DownloadOptions): Promise<DownloadResult>; downloadMany(pkgs: string[], opts?: DownloadOptions & { concurrency?: number }): Promise<BatchResult[]>; getInfo(pkg: string, opts?: { source?: string; signal?: AbortSignal }): Promise<AppInfo>; listVersions(pkg, opts?): Promise<AppVersion[]>; registerSource(source: Source): void; readonly sources: string[] }`
- `src/index.ts` exports: `ApkDownloader`, `download`, `getInfo`, `listVersions`, `downloadAPK` (deprecated; `download(pkg, { outDir: 'Downloads' })`, `process.emitWarning(..., 'DeprecationWarning')` once), all errors, all types, `builtinSources`, `VERSION`.

- [ ] **Step 1: Failing tests** (fake sources as plain objects; fake downloader via injecting a local server URL): `falls back to next source on SourceUnavailableError`; `all not-found → AppNotFoundError`; `mixed failures → AllSourcesFailedError with errors[]`; `pinned source does not fall back`; `unknown source id → InvalidArgument` (use `ApkDownloaderError` code `ERR_INVALID_OPTION`, add to errors); `invalid package → InvalidPackageError before any request`; `ifExists skip returns skipped:true without request`; `ifExists error → FileExistsError`; `extract:true on xapk returns extractedFiles under <outDir>/<package>/`; `getInfo uses info order aptoide→apkpure`; `listVersions skips sources without it`; `registerSource then pin it`; `downloadMany never rejects, returns ok/error per item, honours concurrency` (max in-flight ≤ n); **`dedupes packages`**; `downloadAPK warns once`. `concurrency`: never exceeds n; propagates rejections.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Fallback rule: `AppNotFoundError`, `VersionNotFoundError`, `SourceUnavailableError`, `NetworkError`, `TimeoutError` → try next; `AbortError`, `ChecksumMismatchError`, `FileExistsError` → stop. Fallback also applies if `downloadToFile` fails with a fallback-eligible error.
- [ ] **Step 4: Run** full `npm test && npm run typecheck && npm run lint && npm run build` → PASS.
- [ ] **Step 5: Commit** `feat: add ApkDownloader client with source fallback and batch downloads`.

### Task 9: CLI

**Files:**
- Create: `src/cli/main.ts`, `src/cli/args.ts`, `src/cli/progress.ts`, `src/cli/output.ts`, `bin/apk-downloader.js`
- Test: `test/unit/cli/args.test.ts`, `test/unit/cli/main.test.ts`

**Interfaces — Produces:**
- `parseCli(argv: string[]): { command: 'download'|'info'|'versions'|'sources'|'help'|'version'; packages: string[]; options: CliOptions }` — throws `UsageError` (exit 2). Flags exactly as spec §6.6 with `-a/--app-version`, `-V/--version`; `-s` repeatable (order = source order); `--overwrite|--skip-existing|--fail-existing` mutually exclusive.
- `run(argv: string[], io: { stdout: Writable; stderr: Writable; stdin: Readable; isTTY: boolean; env: NodeJS.ProcessEnv; client?: ApkDownloader }): Promise<number>` — returns the exit code (testable without spawning).
- `bin/apk-downloader.js`: `#!/usr/bin/env node`, imports `dist/cli/main.js`, calls `run(process.argv.slice(2), …)`, wires SIGINT → abort controller → exit 130, `process.exitCode = code`.

- [ ] **Step 1: Failing tests:** args — every flag maps; `-a 1.2` sets version; `-V` → command `version`; conflicting ifExists flags → UsageError; unknown flag → UsageError; `-i -` reads stdin, ignores blank lines and `#` comments. main (with fake client) — `--json` writes exactly one JSON document to stdout and nothing else; human mode writes to stderr; exit 0 all ok, 1 if any failed, 2 on usage error; `info --json` prints AppInfo; `sources` lists ids; `NO_COLOR` / non-TTY → no ANSI codes; progress bar only when TTY and not `--quiet`/`--json`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`node:util.parseArgs`, hand-rolled colors/progress bar on stderr, `\r` redraw ≤ 10/s).
- [ ] **Step 4: Run** unit tests → PASS; then on Kali `npm run build && node bin/apk-downloader.js --help && node bin/apk-downloader.js -V` → help text, `2.0.0`.
- [ ] **Step 5: Commit** `feat: add command-line interface`.

### Task 10: Live tests, CI, release polish

**Files:** Create `test/live/sources.live.test.ts`, `test/live/cli.live.test.ts`, `.github/workflows/ci.yml`, `CHANGELOG.md`; Modify `package.json` if needed.

- [ ] **Step 1: Live tests** (skipped unless `APKDL_LIVE=1`, output to `/tmp/apkdl/out`, 120 s timeout): per built-in source — `getInfo` small app; `download` small app → file exists, starts with `PK`, sha256 64 hex; not-found package → `AppNotFoundError`; aptoide `listVersions` non-empty; specific older version download via aptoide; XAPK small split app via apkpure with `extract:true` → ≥ 2 `.apk` files; CLI `--json` end-to-end exit 0 and `info` exit 0.
- [ ] **Step 2: Run** `npm run test:live` on Kali → PASS (investigate any upstream drift with superpowers:systematic-debugging).
- [ ] **Step 3: CI workflow**: on push/PR, matrix Node 20/22/24, `npm ci`, typecheck, lint, unit tests, build. (Not run locally.)
- [ ] **Step 4: CHANGELOG** `2.0.0` entry: breaking changes (ESM/CJS, Node ≥ 20, promise API, `downloadAPK` deprecated, no Puppeteer), new features.
- [ ] **Step 5: Package check** on Kali: `npm pack --dry-run` lists only `dist/**`, `bin/**`, `package.json`, README, LICENSE, CHANGELOG; `npm pack` then in a scratch dir `npm i ../apk-downloader-2.0.0.tgz` and run both `import('apk-downloader')` and `require('apk-downloader')` and `npx apk-downloader -V`.
- [ ] **Step 6: Commit + push** `test: add live tests; ci: add workflow; docs: add changelog`.

### Task 11: README + LICENSE (with owner) and cleanup

- [ ] **Step 1:** Ask owner: license (MIT?) and copyright holder/year. Rewrite `LICENSE`.
- [ ] **Step 2:** Rewrite `README.md`: tagline, features, install, CLI usage + examples, library API with examples (download, options table, getInfo, batch, custom source), error handling, sources & fallback, legal/ethical note (public apps only, respect upstream ToS), contributing/dev setup, license.
- [ ] **Step 3:** Commit + push `docs: rewrite README and LICENSE for v2`.
- [ ] **Step 4: Cleanup** after owner confirms: `ssh elliot@kali.local 'rm -rf /tmp/apkdl'`; verify `ls /tmp` on Kali has no `apkdl`; on Mac ensure no `node_modules`/`dist`/`*.apk` in repo and `git status` clean; delete scratchpad helper.
