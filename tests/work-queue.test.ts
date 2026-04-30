import assert from 'node:assert/strict';
import test from 'node:test';

import { runWorkQueue } from '../src/work-queue.js';

test('runWorkQueue never exceeds the configured concurrency', async () => {
  let active = 0;
  let maxActive = 0;

  await runWorkQueue({
    items: [1, 2, 3, 4],
    concurrency: 2,
    worker: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });

  assert.equal(maxActive, 2);
});
