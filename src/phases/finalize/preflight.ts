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
import { decideSingleRunFinalizeExecution } from '../../guard/job-single-run';
import { preflightCutoffLifecycle, type CutoffPreflight } from '../cutoff-lifecycle';
import type { HostStateStore, HostReporter } from '../../host/types';

/** This graph must stay free of provider SDKs, config and build-tool imports. */
export async function runGuardedCutoffPost(
  host: Pick<HostStateStore, 'getState'> & Pick<HostReporter, 'info'>,
  run: (preflight: CutoffPreflight) => Promise<void>,
): Promise<void> {
  const decision = decideSingleRunFinalizeExecution(host);
  if (!decision.shouldRun) {
    host.info(decision.message);
    return;
  }
  const preflight = await preflightCutoffLifecycle(host.getState);
  await run(preflight);
}
