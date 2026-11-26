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

import type { NormalizedActionConfig } from '../../config/types';
import type { MetadataGeneration } from './metadata-base-records';

type ScheduleConfig = Pick<
  NormalizedActionConfig,
  | 'cacheEnabled'
  | 'cleanupEnabled'
  | 'cacheGcMode'
  | 'dependencyGcIntervalMs'
  | 'dependencyGcForceGraceMs'
>;

export function dependencyGcSchedule(
  config: ScheduleConfig,
  generation: MetadataGeneration | undefined,
  now: number,
): { due: 'true' | 'false' | 'unknown'; force: boolean } {
  if (!config.cacheEnabled || !config.cleanupEnabled || config.cacheGcMode === 'off') {
    return { due: 'false', force: false };
  }
  if (generation === undefined) {
    return { due: 'unknown', force: false };
  }
  const lastSweep = generation[12];
  const grace = config.dependencyGcForceGraceMs;
  if (lastSweep === null) {
    return { due: 'true', force: grace !== null };
  }
  const overdue = now - lastSweep - config.dependencyGcIntervalMs;
  return {
    due: overdue >= 0 ? 'true' : 'false',
    force: grace !== null && overdue >= grace,
  };
}
