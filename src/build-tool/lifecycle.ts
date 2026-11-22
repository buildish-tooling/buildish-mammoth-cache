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

import type { BuildToolLifecycle, LifecycleResolver } from './lifecycle-types';
import type { Context } from '../cache/streaming/schema';

const defaultResolver: LifecycleResolver = async (tool) => {
  if (tool === 'gradle') return (await import('./gradle/lifecycle')).gradleLifecycle;
  if (tool === 'maven') return (await import('./maven/lifecycle')).mavenLifecycle;
  throw new Error('Unsupported build-tool lifecycle.');
};
/** Call only after binding the owner; a next-invocation tool cannot choose recovery. */
export async function resolveLifecycle(
  tool: Context[7],
  resolver = defaultResolver,
): Promise<BuildToolLifecycle> {
  if (tool !== 'gradle' && tool !== 'maven') throw new Error('Unsupported build-tool lifecycle.');
  const lifecycle = await resolver(tool);
  if (lifecycle.tool !== tool) throw new Error('Build-tool lifecycle identity mismatch.');
  return lifecycle;
}
