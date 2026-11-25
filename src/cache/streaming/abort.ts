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

/** A removable per-operation subscription, never a shared pending-Promise chain. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
        cleanup();
        reject(signal.reason);
      },
      cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
}

/** Producers must cancel their own I/O with signal; retirement cannot delay abort. */
export async function* abortableValues<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      const item = await withAbort(iterator.next(), signal);
      if (item.done) {
        done = true;
        return;
      }
      yield item.value;
    }
  } finally {
    if (!done && iterator.return) {
      const retirement = iterator.return();
      if (signal.aborted) {
        void retirement.catch(() => {});
      } else {
        await retirement;
      }
    }
  }
}
