/** Run at most `limit` async tasks at a time. Tasks start in the order they are submitted. */
export function pLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < limit) run();
      else queue.push(run);
    });
}
