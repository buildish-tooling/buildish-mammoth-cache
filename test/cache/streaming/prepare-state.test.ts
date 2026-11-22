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

import { afterEach, expect, it, vi } from 'vitest';
import { PrepareFacts, localRecords } from '../../../src/cache/streaming/prepare-state';
import { prepareStateFixture } from './prepare-state-fixture';
const fixtures: Awaited<ReturnType<typeof prepareStateFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const f = await prepareStateFixture();
  fixtures.push(f);
  return f;
}
it('charges and freezes decoded facts, and releases its process-local receipt on close', async () => {
  const f = await fixture(),
    facts = await PrepareFacts.open(f.store, { budget: f.budget });
  expect(f.budget.retained).toBeGreaterThan(0);
  expect(Object.isFrozen(facts.selection)).toBe(true);
  expect(() => {
    facts.selection![2] = 'changed';
  }).toThrow();
  PrepareFacts.assert(facts);
  facts.close();
  facts.close();
  expect(f.budget.retained).toBe(0);
  expect(() => PrepareFacts.assert(facts)).toThrow();
});
it('commits exact selections, installed stages and final cutoff through matching bindings', async () => {
  const f = await fixture();
  let facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[5] = ['miss'];
    s[6] = ['selected', []];
    s[7] = [];
    await facts.commit({ selection: s });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[9] = 'base-installed';
    await facts.commit({ selection: s, baseline: null });
  } finally {
    facts.close();
  }
  const activity = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    localRecords([
      ['dir-open', ''],
      ['dir-close', ''],
    ]),
  );
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[9] = 'workers-installed';
    await facts.commit({ selection: s, activity });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await facts.commit({ cutoff: 12345, ready: true });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    expect(facts.state[4]).toBe('build-ready');
    expect(facts.bindings[8][7]).toBe(12345);
    expect(facts.bindings[12]).toEqual(activity);
    await expect(facts.commit({ cutoff: 99999 })).rejects.toThrow('writable');
  } finally {
    facts.close();
  }
});
it('rejects config drift, skipped stages and a changed committed cold outcome', async () => {
  const f = await fixture();
  let facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[2] = 'other';
    await expect(facts.commit({ selection: s })).rejects.toThrow('configuration');
    const next = structuredClone(facts.selection!);
    next[5] = ['miss'];
    next[6] = ['selected', []];
    next[7] = [];
    next[9] = 'workers-installed';
    await expect(facts.commit({ selection: next })).rejects.toThrow('stage');
    next[9] = 'selected';
    await facts.commit({ selection: next });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[5] = ['pending'];
    s[7] = null;
    await expect(facts.commit({ selection: s })).rejects.toThrow('pinned base');
  } finally {
    facts.close();
  }
});
it('pins caller-owned replacement arrays before its first await', async () => {
  const f = await fixture(),
    facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const s = structuredClone(facts.selection!);
    s[5] = ['miss'];
    s[6] = ['selected', []];
    s[7] = [];
    const commit = facts.commit({ selection: s });
    s[2] = 'mutated-after-call';
    await commit;
  } finally {
    facts.close();
  }
  const fresh = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    expect(fresh.selection![2]).toBe('refs/heads/main');
  } finally {
    fresh.close();
  }
});
