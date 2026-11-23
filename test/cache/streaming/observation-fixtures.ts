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

import { vi } from 'vitest';
import type { Value } from '../../../src/cache/streaming/encoding';
import { installFixture } from './install-fixture';
import { PostAttempt } from '../../../src/cache/streaming/lifecycle-attempt';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { ExclusiveWindow } from '../../../src/cache/streaming/quiescence';
import {
  captureObservations,
  type ObservationCaptureOptions,
  type FrozenObservation,
} from '../../../src/cache/streaming/observation-capture';
import { GcSurvivorOwner, type GcOptions } from '../../../src/cache/streaming/gc-execute';
import type { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import type { OwnedStore } from '../../../src/cache/streaming/owned-store';
import type { LifecycleResolver } from '../../../src/build-tool/lifecycle-types';
export const rows = (values: readonly Value[]) =>
  (async function* () {
    yield* values;
  })();
type Active = {
  attempt: PostAttempt;
  index?: ObservationIndex;
  owner?: GcSurvivorOwner;
  window?: ExclusiveWindow;
  finish: () => Promise<void>;
};
const active = new WeakMap<OwnedStore, Active>();
export async function observationFixture(
  tool: 'gradle' | 'maven' = 'maven',
  options: Parameters<typeof installFixture>[1] = {},
  activity: readonly Value[] = [
    ['dir-open', ''],
    ['dir-close', ''],
  ],
) {
  return initializeObservationFixture(await installFixture(tool, options), activity);
}
export async function initializeObservationFixture(
  f: Awaited<ReturnType<typeof installFixture>>,
  activity: readonly Value[] = [
    ['dir-open', ''],
    ['dir-close', ''],
  ],
  cutoff = Date.now() + 600000,
) {
  const spec = { budget: f.budget, partition: null },
    b = f.bindings,
    policy = b[8] as Value[];
  b[6] = await f.store.writeStream(
    'model',
    spec,
    rows([
      ['model-header', f.model.tuple[2], f.model.tuple[3]],
      ...f.model.partitions.map((p) => ['partition', ...p]),
    ]),
  );
  const imported = await f.store.writeStream('activity', spec, rows(activity));
  policy[5] = 'timestamp';
  policy[6] = 1000000;
  policy[7] = cutoff;
  await f.store.initialize(b);
  const handoff = await f.store.writeStream(
    'handoff',
    spec,
    rows([
      [
        'handoff',
        2,
        'refs/heads/main',
        null,
        null,
        7,
        'enabled',
        1000000,
        null,
        imported,
        cutoff,
        0,
      ],
      ...f.model.partitions.map((p) => ['partition', p[0], 'miss', null, null]),
    ]),
  );
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'build-ready';
  state[6] = f.store.codec.schemas.ref('handoff').parse(handoff);
  await f.store.updateState(state);
  const opened = await OpenedInvocation.current(f.root, f.budget);
  if (!opened) throw new Error('Fixture prepare missing');
  vi.spyOn(opened.store, 'fail').mockImplementation(f.store.fail);
  f.store = opened.store;
  const attempt = await PostAttempt.open(opened, {
    budget: f.budget,
    assertCurrent: (): undefined => {},
  });
  const context: Active = {
    attempt,
    finish: async () => {
      await context.owner?.dispose();
      await context.index?.dispose();
      context.window?.close();
      attempt.close();
    },
  };
  active.set(f.store, context);
  if (
    f.store.codec.options.role !== 'distributed-worker' &&
    f.store.codec.options.access === 'writable'
  ) {
    const lifecycle: LifecycleResolver = async (tool) => ({
      tool,
      prepareCapture: async () => {},
      removeKnownHooks: async () => [],
      quiesce: async (input) =>
        tool === 'gradle'
          ? input.store.writeStream(
              'installations',
              { budget: input.budget, partition: null },
              rows([]),
            )
          : undefined,
    });
    const window = await ExclusiveWindow.establish(f.store, f.budget, {
      assertCurrent: (): undefined => {},
      lifecycle,
    });
    if (window.status !== 'ready') throw new Error(window.message);
    context.window = window.window;
    attempt.attachWindow(window.window);
  }
  const close = f.close;
  return Object.assign(f, {
    attempt,
    finish: context.finish,
    close: async () => {
      try {
        await context.finish();
      } finally {
        await close();
      }
    },
  });
}
/** Test convenience only: passes the genuine operation owner explicitly to production. */
export async function captureFixtureObservations(
  store: OwnedStore,
  options: Omit<ObservationCaptureOptions, 'attempt'>,
): Promise<FrozenObservation> {
  const context = active.get(store);
  if (!context) throw new Error('Absent active fixture owner');
  const result = await captureObservations(store, {
    ...options,
    attempt: context.attempt,
    retainIndex: true,
  });
  context.index = result.index;
  return result;
}
export async function executeFixtureGc(store: OwnedStore, options: GcOptions) {
  const context = active.get(store);
  if (!context?.index) throw new Error('Absent original fixture capture');
  context.owner = await GcSurvivorOwner.execute(context.index, options);
  context.index = undefined;
  return { cursor: context.owner.cursor, owner: context.owner };
}
