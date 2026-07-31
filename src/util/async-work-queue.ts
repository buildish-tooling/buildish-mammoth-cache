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

const QUEUE_COMPACTION_THRESHOLD = 4_096;
const NO_FAILURE = Symbol('no-failure');

/** Adds newly discovered work to a bounded asynchronous traversal. */
export type EnqueueAsyncWork<T> = (items: Iterable<T>) => void;

/**
 * Processes an expandable work queue without creating one promise per queued item.
 *
 * At most `maxConcurrency` processors are active. When one processor fails, no new work starts,
 * already-active processors are allowed to settle, and the first failure is rethrown.
 */
export async function processAsyncWorkQueue<T>(
  initialItems: Iterable<T>,
  maxConcurrency: number,
  processItem: (item: T, enqueue: EnqueueAsyncWork<T>) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('Async work queue concurrency must be a positive integer.');
  }

  const queue: T[] = [];
  for (const item of initialItems) {
    queue.push(item);
  }

  await new Promise<void>((resolve, reject) => {
    let cursor = 0;
    let activeCount = 0;
    let failure: unknown | typeof NO_FAILURE = NO_FAILURE;
    let settled = false;

    const enqueue: EnqueueAsyncWork<T> = (items) => {
      if (failure !== NO_FAILURE || settled) {
        return;
      }
      for (const item of items) {
        queue.push(item);
      }
    };

    const compactQueue = (): void => {
      if (cursor >= QUEUE_COMPACTION_THRESHOLD && cursor * 2 >= queue.length) {
        queue.splice(0, cursor);
        cursor = 0;
      }
    };

    const schedule = (): void => {
      if (settled) {
        return;
      }

      if (failure !== NO_FAILURE) {
        if (activeCount === 0) {
          settled = true;
          reject(failure);
        }
        return;
      }

      while (activeCount < maxConcurrency && cursor < queue.length) {
        const item = queue[cursor]!;
        cursor += 1;
        activeCount += 1;

        void Promise.resolve()
          .then(() => processItem(item, enqueue))
          .catch((error: unknown) => {
            if (failure === NO_FAILURE) {
              failure = error;
            }
          })
          .finally(() => {
            activeCount -= 1;
            compactQueue();
            schedule();
          });
      }

      if (activeCount === 0 && cursor >= queue.length) {
        settled = true;
        resolve();
      }
    };

    schedule();
  });
}
