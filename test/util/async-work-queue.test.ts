/*
 * Copyright 2026 The Buildish Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';

import { processAsyncWorkQueue } from '../../src/util/async-work-queue';

describe('processAsyncWorkQueue', () => {
  it('bounds active processors and handles dynamically discovered work', async () => {
    let activeCount = 0;
    let peakActiveCount = 0;
    const processed: number[] = [];

    await processAsyncWorkQueue([0, 1, 2, 3, 4, 5], 3, async (item, enqueue) => {
      activeCount += 1;
      peakActiveCount = Math.max(peakActiveCount, activeCount);
      await Promise.resolve();
      processed.push(item);
      if (item === 0) {
        enqueue([6, 7, 8]);
      }
      activeCount -= 1;
    });

    expect(peakActiveCount).toBe(3);
    expect(processed.sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('waits for active processors to settle before reporting the first failure', async () => {
    let siblingSettled = false;

    await expect(
      processAsyncWorkQueue([0, 1], 2, async (item) => {
        await Promise.resolve();
        if (item === 0) {
          throw new Error('primary failure');
        }
        siblingSettled = true;
      }),
    ).rejects.toThrow('primary failure');

    expect(siblingSettled).toBe(true);
  });

  it('does not lose work when compacting a large consumed queue prefix', async () => {
    const itemCount = 10_000;
    let processedCount = 0;
    let processedSum = 0;

    await processAsyncWorkQueue(
      Array.from({ length: itemCount }, (_, index) => index),
      8,
      async (item) => {
        await Promise.resolve();
        processedCount += 1;
        processedSum += item;
      },
    );

    expect(processedCount).toBe(itemCount);
    expect(processedSum).toBe((itemCount * (itemCount - 1)) / 2);
  });

  it.each([0, -1, 1.5])('rejects invalid concurrency %s', async (maxConcurrency) => {
    await expect(processAsyncWorkQueue([], maxConcurrency, async () => {})).rejects.toThrow(
      /positive integer/u,
    );
  });
});
