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
    async prepareCapture(store, context, ordinaryHooks) {
      if (
        store.codec.options.access === 'writable' &&
        store.codec.options.role !== 'distributed-worker'
      ) {
        const { installGradleLifecycleCapture } = await import('./lifecycle-capture');
        await installGradleLifecycleCapture(store, context);
      } else await ordinaryHooks();
    },
    async quiesce(input) {
      const { quiesceGradle } = await import('./consumers');
      return quiesceGradle(input, deps);
    },
    async verifyRecoveryConsumers(signal) {
      const { inspectGradleDaemons } = await import('./process-inspection');
      const proof = await (deps.inspect ?? inspectGradleDaemons)(signal);
      if (proof.remaining || proof.uncertain)
        throw new Error(proof.reason ?? 'Recovery requires finished Gradle consumers.');
    },
    async removeKnownHooks(root) {
      const { cleanupGradleBuildResultCapture } = await import('./build-results');
      return cleanupGradleBuildResultCapture(root);
    },
  } satisfies BuildToolLifecycle);
}
export const gradleLifecycle = createGradleLifecycle();
