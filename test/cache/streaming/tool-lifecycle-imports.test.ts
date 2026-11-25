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

import { beforeEach, expect, it, vi } from 'vitest';
import type { Context } from '../../../src/cache/streaming/schema';

const loads = vi.hoisted(() => ({ gradle: 0, capture: 0, consumers: 0, process: 0, reports: 0 }));
vi.mock('../../../src/build-tool/gradle/lifecycle', async (original) => {
  loads.gradle++;
  return original();
});
vi.mock('../../../src/build-tool/gradle/lifecycle-capture', () => {
  loads.capture++;
  return { installGradleLifecycleCapture: vi.fn() };
});
vi.mock('../../../src/build-tool/gradle/consumers', () => {
  loads.consumers++;
  return { quiesceGradle: vi.fn() };
});
vi.mock('../../../src/build-tool/gradle/process-inspection', () => {
  loads.process++;
  return { inspectGradleDaemons: async () => ({ remaining: false, uncertain: false }) };
});
vi.mock('../../../src/build-tool/gradle/build-results', () => {
  loads.reports++;
  return { cleanupGradleBuildResultCapture: async (root: string) => [root] };
});
beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(loads) as (keyof typeof loads)[]) {
    loads[key] = 0;
  }
});
it('executes only the needed modules across guard, Maven, Gradle quiescence and cleanup routes', async () => {
  {
    await import('../../../src/phases/streaming/post');
    await import('../../../src/ci/github/streaming');
    expect(loads).toEqual({ gradle: 0, capture: 0, consumers: 0, process: 0, reports: 0 });
  }
  {
    const { resolveLifecycle } = await import('../../../src/build-tool/lifecycle');
    const tool = await resolveLifecycle('maven'),
      ordinary = vi.fn(async () => {});
    await tool.prepareCapture(undefined as never, { tempDirectory: 'temp' }, ordinary);
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect(await tool.quiesce(undefined as never)).toBeUndefined();
    expect(await tool.removeKnownHooks('root')).toEqual([]);
    expect(loads).toEqual({ gradle: 0, capture: 0, consumers: 0, process: 0, reports: 0 });
  }
  {
    const { resolveLifecycle } = await import('../../../src/build-tool/lifecycle');
    await (await resolveLifecycle('gradle')).quiesce(undefined as never);
    expect(loads).toEqual({ gradle: 1, capture: 0, consumers: 1, process: 0, reports: 0 });
  }
  {
    const { gitHubStreamingFactories } = await import('../../../src/ci/github/streaming');
    const factories = gitHubStreamingFactories();
    expect(await factories.removeHooks('old-root', 'maven')).toEqual([]);
    expect(loads.gradle).toBe(1);
    expect(await factories.removeHooks('old-root', 'gradle')).toEqual(['old-root']);
    expect(loads).toEqual({ gradle: 1, capture: 0, consumers: 1, process: 0, reports: 1 });
  }
});
it('rejects unsupported identity before resolution and wrong-tool factory results', async () => {
  const { resolveLifecycle } = await import('../../../src/build-tool/lifecycle');
  const resolver = vi.fn(async () => resolveLifecycle('maven'));
  await expect(resolveLifecycle('unknown' as Context[7], resolver)).rejects.toThrow('Unsupported');
  expect(resolver).not.toHaveBeenCalled();
  await expect(resolveLifecycle('gradle', resolver)).rejects.toThrow('identity mismatch');
  expect(resolver).toHaveBeenCalledWith('gradle');
});
