export interface FileNameVars {
  package: string;
  version?: string | undefined;
  versionCode?: number | undefined;
  source: string;
  ext: string;
}

const MAX_LENGTH = 200;
// Path separators, characters reserved on Windows, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const FALLBACK = 'app';

function sanitize(value: string): string {
  return value.replace(UNSAFE, '_');
}

/**
 * Render a filename template. Supported placeholders: `{package}`, `{version}`,
 * `{versionCode}`, `{source}`, `{ext}`. Unknown placeholders are left as-is.
 *
 * The result is always a single safe path segment: separators and reserved characters
 * are replaced with `_`, leading dots are stripped, and the length is capped at
 * 200 characters (keeping the extension).
 */
export function renderFileName(template: string, vars: FileNameVars): string {
  const values: Record<string, string> = {
    package: vars.package,
    version: vars.version ?? 'latest',
    versionCode: vars.versionCode === undefined ? '' : String(vars.versionCode),
    source: vars.source,
    ext: vars.ext,
  };

  const rendered = template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? sanitize(values[key] ?? '') : match,
  );

  let name = sanitize(rendered).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name.length === 0) name = FALLBACK;
  return truncate(name);
}

function truncate(name: string): string {
  if (name.length <= MAX_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return name.slice(0, MAX_LENGTH - ext.length) + ext;
}
