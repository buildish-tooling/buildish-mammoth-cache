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

/**
 * Operation-local wall time only; never lifecycle authority. Nested spans overlap,
 * and concurrent durations cannot be summed. SDK spans include archive utilities,
 * compression/extraction, service calls and network waits; they do not isolate
 * network transfer or CPU time. An unmatched start after a hard kill means
 * interrupted/unknown, never successful completion.
 */
export interface TimingOptions {
  readonly timing?: {
    readonly info: (message: string) => void;
    readonly now?: () => number;
  };
  readonly signal?: AbortSignal;
}
export function formatElapsed(milliseconds: number): string {
  const ms = Math.max(0, Math.floor(milliseconds));
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function emit(options: TimingOptions, message: string): void {
  try {
    options.timing?.info('Mammoth: ' + message);
  } catch {
    /* Timing must not affect work. */
  }
}
export function timingDecision(options: TimingOptions, label: string, outcome: string): void {
  emit(options, `${label} (${outcome}).`);
}
export async function timed<T>(
  options: TimingOptions,
  label: string,
  work: () => Promise<T>,
  outcome: (value: T) => string = () => 'success',
  failure: (error: unknown) => string = () => (options.signal?.aborted ? 'cancelled' : 'failed'),
): Promise<T> {
  if (!options.timing) return work();
  const now = options.timing.now ?? (() => performance.now());
  const read = () => {
    try {
      return now();
    } catch {
      return undefined;
    }
  };
  const start = read();
  emit(options, `Started ${label}.`);
  let terminal = 'failed';
  try {
    const value = await work();
    try {
      terminal = outcome(value);
    } catch {
      terminal = 'unavailable';
    }
    return value;
  } catch (error) {
    try {
      terminal = failure(error);
    } catch {
      terminal = 'failed';
    }
    throw error;
  } finally {
    const end = read();
    emit(
      options,
      `Finished ${label} after ${start === undefined || end === undefined ? 'unavailable' : formatElapsed(end - start)} (${terminal}).`,
    );
  }
}
