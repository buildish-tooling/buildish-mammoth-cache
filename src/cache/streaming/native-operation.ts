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

import type { TimingOptions } from '../../util/timing';

import type { WorkingBudget } from './tree-state';

export interface NativeOperationOptions extends TimingOptions {
  readonly budget: WorkingBudget;
  readonly signal?: AbortSignal;
  readonly maxDirectoryEntries?: number;
}
export async function settleNativeCleanup(
  actions: (() => unknown)[],
  primary?: unknown,
): Promise<void> {
  const results = await Promise.allSettled(actions.map(async (action) => action()));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  if (errors.length)
    throw new AggregateError(
      primary === undefined ? errors : [primary, ...errors],
      'Native object cleanup failed.',
    );
}
