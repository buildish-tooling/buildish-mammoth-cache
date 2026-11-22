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

import type { OwnedStore } from '../../cache/streaming/owned-store';
import { registrationDirectory } from '../../cache/streaming/quiescence';
import { installGradleBuildResultCapture } from './build-results';
import type { CiJobContext } from '../../ci/types';
// Protocol: docs/dev/cache-lifecycle-protocol.md#gradle-installation-registration.
export async function installGradleLifecycleCapture(
  store: OwnedStore,
  context: Pick<CiJobContext, 'tempDirectory'>,
): Promise<void> {
  if (
    store.codec.options.model.tuple[2] !== 'gradle' ||
    store.codec.options.role === 'distributed-worker' ||
    store.codec.options.access !== 'writable'
  )
    throw new Error('Operational capture requires writable Gradle base role.');
  const directory = registrationDirectory(store);
  await store.makeParents(directory + '/placeholder');
  await installGradleBuildResultCapture(store.root.path, context, {
    invocation: store.codec.options.invocation,
    directory: store.root.resolve(directory),
  });
}
