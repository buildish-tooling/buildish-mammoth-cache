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

import type { BuildToolLifecycle } from '../lifecycle-types';
import type { DaemonInspection } from './process-inspection';
import type { GradleInstallation } from './stop-client';

/** Native dependencies belong to Gradle; shared lifecycle callers select only a tool. */
export interface GradleConsumerDependencies {
  readonly inspect?: (signal: AbortSignal) => Promise<DaemonInspection>;
  readonly stop?: (
    installation: GradleInstallation,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<void>;
}

export function createGradleLifecycle(
  dependencies: GradleConsumerDependencies = {},
): BuildToolLifecycle {
  const deps = Object.freeze({ ...dependencies });
  return Object.freeze({
    tool: 'gradle' as const,
    async assertRestoreConsumersAbsent(signal) {
      signal.throwIfAborted();
      const unavailable = (cause?: unknown) =>
        new Error(
          'Could not establish that Gradle daemons are absent before restore. ' +
            'Use a runner with working process inspection and run Mammoth before Gradle.',
          { cause },
        );
      let result: DaemonInspection;
      try {
        const inspect = deps.inspect ?? (await import('./process-inspection')).inspectGradleDaemons;
        signal.throwIfAborted();
        result = await inspect(signal);
      } catch (cause) {
        signal.throwIfAborted();
        throw unavailable(cause);
      }
      signal.throwIfAborted();
      if (result.remaining) {
        throw new Error(
          'A running Gradle daemon was detected before restore. ' +
            'Use a runner without active Gradle daemons and run Mammoth before Gradle.',
        );
      }
      if (result.uncertain) {
        throw unavailable();
      }
    },
    async prepareCapture(store, context, ordinaryHooks, layerVersion) {
      if (
        store.codec.options.access === 'writable' &&
        (store.codec.options.role !== 'distributed-worker' || layerVersion !== undefined)
      ) {
        const { installGradleLifecycleCapture } = await import('./lifecycle-capture');
        await installGradleLifecycleCapture(store, context, layerVersion);
      } else {
        await ordinaryHooks();
      }
    },
    async quiesce(input) {
      const { quiesceGradle } = await import('./consumers');
      return quiesceGradle(input, deps);
    },
    async removeKnownHooks(root) {
      const { cleanupGradleBuildResultCapture } = await import('./build-results');
      return cleanupGradleBuildResultCapture(root);
    },
  } satisfies BuildToolLifecycle);
}
export const gradleLifecycle = createGradleLifecycle();
