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

import { expect, it } from 'vitest';
import { timed, formatElapsed } from '../../../src/util/timing';
import { settleNativeCleanup } from '../../../src/cache/streaming/native-operation';

it('formats elapsed monotonic time with stable correlation and unbounded minutes', async () => {
  let now = 10;
  const logs: string[] = [];
  const options = { timing: { now: () => now, info: (s: string) => logs.push(s) } };
  expect(
    await timed(
      options,
      'base SDK restore [partition=q0]',
      async () => {
        now += 12345;
        return 'hit';
      },
      (value) => value,
    ),
  ).toBe('hit');
  expect(logs).toEqual([
    'Mammoth: Started base SDK restore [partition=q0].',
    'Mammoth: Finished base SDK restore [partition=q0] after 00:12.345 (hit).',
  ]);
  expect(formatElapsed(60000)).toBe('01:00.000');
  expect(formatElapsed(3600001)).toBe('60:00.001');
});
it('preserves failure, cancellation and actual non-success returns', async () => {
  const logs: string[] = [],
    controller = new AbortController();
  const options = {
    timing: { now: () => 0, info: (s: string) => logs.push(s) },
    signal: controller.signal,
  };
  const error = new Error('primary');
  await expect(
    timed(options, 'work', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(logs.at(-1)).toContain('(failed)');
  controller.abort();
  await expect(
    timed(options, 'work', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(logs.at(-1)).toContain('(cancelled)');
  expect(
    await timed(
      options,
      'work',
      async () => 'abandoned',
      (value) => value,
    ),
  ).toBe('abandoned');
  expect(logs.at(-1)).toContain('(abandoned)');
  expect(logs.filter((s) => s.includes('Started'))).toHaveLength(3);
  expect(logs.filter((s) => s.includes('Finished'))).toHaveLength(3);
});
it('throwing diagnostics cannot suppress work, cleanup or aggregated errors', async () => {
  const options = {
    timing: {
      info: () => {
        throw new Error('sink');
      },
    },
  };
  const primary = new Error('primary'),
    cleanup = new Error('cleanup');
  let cleaned = false;
  await expect(
    timed(options, 'work', async () => {
      try {
        throw primary;
      } catch (error) {
        await timed(options, 'cleanup', () =>
          settleNativeCleanup(
            [
              () => {
                cleaned = true;
                throw cleanup;
              },
            ],
            error,
          ),
        );
        throw error;
      }
    }),
  ).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(cleaned).toBe(true);
  expect(await timed(options, 'work', async () => 42)).toBe(42);
  await expect(
    timed(options, 'work', async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
});
