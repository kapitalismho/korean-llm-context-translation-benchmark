export interface WorkQueueOptions<T> {
  items: T[];
  concurrency: number;
  worker: (item: T, index: number) => Promise<void>;
}

export async function runWorkQueue<T>(options: WorkQueueOptions<T>): Promise<void> {
  const { items, concurrency, worker } = options;
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;

      if (current >= items.length) {
        return;
      }

      await worker(items[current] as T, current);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}
