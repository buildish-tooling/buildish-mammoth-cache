/*
 * Copyright 2026 The Apache Software Foundation
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

import {
  createPrepareActionOutputs,
  executePrepareAction,
  type PrepareActionDependencies,
} from '../../prepare-flow';
import type { HostOutputSink } from '../../host/types';
import { claimSingleRunPrepareExecution } from '../../guard/job-single-run';

/**
 * Runtime host required at the prepare entrypoint boundary.
 *
 * Extends the base main-action runtime host with {@link HostOutputSink} so the entrypoint can
 * emit action outputs (e.g. `cache-key`) after the prepare phase completes.
 */
export type PrepareEntrypointRuntimeHost = PrepareActionDependencies['runtimeHost'] &
  HostOutputSink;

/**
 * Full dependency bundle for the prepare entrypoint.
 *
 * Same as {@link PrepareActionDependencies} but with the runtime host narrowed to
 * {@link PrepareEntrypointRuntimeHost} so output emission is available.
 */
export type PrepareEntrypointDependencies = Omit<PrepareActionDependencies, 'runtimeHost'> & {
  readonly runtimeHost: PrepareEntrypointRuntimeHost;
};

/**
 * Entrypoint for the prepare (main) phase of the action.
 *
 * Claims the single-run guard before delegating to {@link executePrepareAction}. Emits action
 * outputs and forwards log/warning messages from the main flow to the runtime reporter.
 * Throws if another action invocation already claimed ownership of this CI job.
 */
export async function runPrepareExecution(
  dependencies: PrepareEntrypointDependencies,
): Promise<void> {
  const { ciProvider, runtimeHost } = dependencies;
  const singleRunClaim = await claimSingleRunPrepareExecution({
    ciContext: ciProvider.context,
    saveState: runtimeHost.saveState,
  });
  if (!singleRunClaim.accepted) {
    throw new Error(singleRunClaim.message);
  }

  const status = await executePrepareAction(dependencies);
  for (const [name, value] of Object.entries(createPrepareActionOutputs(status))) {
    runtimeHost.setOutput(name, value);
  }
  if (status.bootstrap.baseCacheResult) {
    runtimeHost.info(status.bootstrap.baseCacheResult.message);
  }
  if (status.dependentDeltaResult) {
    runtimeHost.info(status.dependentDeltaResult.message);
    for (const warning of status.dependentDeltaResult.warnings) {
      runtimeHost.warning(warning);
    }
  }
  runtimeHost.info(status.message);
}
