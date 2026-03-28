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

import type { CiJobContext } from '../ci';
import { parseBooleanInput } from '../util/action-input';
import { defaultReadOnlyForEvent } from './shared';

/** Origin of the effective raw `read-only` value after config-file overlay. */
export type ReadOnlyInputSource = 'direct' | 'config-file' | 'unset';

const readOnlySources = new WeakMap<object, ReadOnlyInputSource>();

/** Records provenance without adding internal fields to the public raw-input shape. */
export function recordReadOnlyInputSource(inputs: object, source: ReadOnlyInputSource): void {
  readOnlySources.set(inputs, source);
}

/**
 * Resolves the effective write policy while preserving the pull-request safety floor.
 *
 * A committed repository config is part of the checked-out workspace and may be controlled by a
 * pull-request author. It can make execution stricter, but only a direct workflow input may lower
 * the event-derived read-only default.
 */
export function resolveReadOnlyInput(
  inputs: object,
  rawValue: string,
  ciContext: Pick<CiJobContext, 'eventName'>,
): boolean {
  if (rawValue.length === 0) {
    return defaultReadOnlyForEvent(ciContext.eventName);
  }

  const requestedReadOnly = parseBooleanInput(rawValue, 'read-only');
  const source = readOnlySources.get(inputs) ?? 'direct';
  if (!requestedReadOnly && defaultReadOnlyForEvent(ciContext.eventName) && source !== 'direct') {
    return true;
  }
  return requestedReadOnly;
}
