import { FileSystemError } from '../errors.js';

/** Syscalls made by local file operations (as opposed to sockets). */
const FS_SYSCALLS = new Set([
  'open',
  'write',
  'read',
  'close',
  'rename',
  'mkdir',
  'unlink',
  'stat',
  'fsync',
  'copyfile',
]);

interface SystemError extends Error {
  code?: string;
  syscall?: string;
  path?: string;
}

/** Wrap a Node.js filesystem error as a {@link FileSystemError}; other values are returned unchanged. */
export function asFileSystemError(error: unknown): unknown {
  const e = error as SystemError | undefined;
  if (!(e instanceof Error) || !e.syscall || !FS_SYSCALLS.has(e.syscall)) return error;
  const where = e.path ? ` (${e.path})` : '';
  return new FileSystemError(`Cannot ${e.syscall} file${where}: ${e.code ?? e.message}`, {
    cause: error,
    ...(e.path !== undefined ? { path: e.path } : {}),
    ...(e.code !== undefined ? { systemCode: e.code } : {}),
  });
}
