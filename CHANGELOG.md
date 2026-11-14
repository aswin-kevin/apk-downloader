# Changelog

## 2.0.0 — 2026-11-14

A ground-up rewrite. v1 drove a headless Chrome against apk.support, which no longer works.

### Breaking changes

- Requires **Node.js 20.18.1 or newer**.
- **Promise-based API.** `download()` resolves with a `DownloadResult` (path, size, SHA-256, source,
  app info) and rejects with a typed error. v1's `downloadAPK()` returned nothing and only logged.
- Files are written to the current directory by default (v1 used `./Downloads`); pass `outDir`.
- `downloadAPK()` is kept for compatibility (still downloads into `./Downloads`), returns a promise
  and is **deprecated**.
- No more Puppeteer/Chromium or `request` dependencies.
- The package ships ESM and CommonJS builds with TypeScript types.

### New

- **Pluggable sources with automatic fallback:** Aptoide, APKPure and F-Droid built in;
  register your own with `registerSource()` or pin one with `source`.
- **Command-line interface:** `npx apk-downloader <package...>`, plus `info`, `versions`
  and `sources` commands, `--json` output, progress bar and proper exit codes.
- **Options:** output directory, filename templates, app version, APK/XAPK format, XAPK
  extraction, existing-file policy, timeout, retries with backoff, proxy (`HTTPS_PROXY`
  supported), cancellation via `AbortSignal`, progress callbacks, custom user agent.
- **Batch downloads** with a concurrency limit and per-package results.
- **Metadata lookups** without downloading: `getInfo()` and `listVersions()`.
- **Integrity:** checksums verified when the source publishes them, SHA-256 always reported,
  ZIP signature checked, partial files never left behind.
- **Safety:** Aptoide uploads that Aptoide has not verified are refused unless `allowUntrusted`
  is set; XAPK extraction rejects path-traversal entries.
- **Typed errors** with stable `code` values (`ERR_APP_NOT_FOUND`, `ERR_ALL_SOURCES_FAILED`, ...).

### Known limitations

- APKPure is currently unavailable from Node.js: its download endpoint is behind bot protection
  that rejects Node's HTTP client. The source reports this as `blocked` and the next source is
  used. Split apps (XAPK) are therefore not downloadable through the built-in sources for now.
- F-Droid apps that publish one APK per CPU architecture need an exact `versionCode`.
