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

import { OpenedInvocation } from './invocation';
import {
  lifecycleDocuments,
  type LifecycleBindings,
  type LifecycleState,
  type LifecycleTerminal,
} from './lifecycle-documents';
import { LifecycleHandoff } from './lifecycle-handoff';
import { readMetadataGeneration } from './metadata-base-restore';
import type { MetadataGeneration } from './metadata-base-records';
import { ExclusiveWindow } from './quiescence';
import { assertLifecycleWindow } from './post-admission';
import type { LifecycleOptions } from './lifecycle-options';
import type { OwnedStore } from './owned-store';
import { encodeRecord, equal } from './encoding';

const attempts = new WeakSet<PostAttempt>();
/** One fresh-process post claim. Only successful main data crosses; operation authority never does. */
export class PostAttempt {
  #active = true;
  #captured = false;
  #window: ExclusiveWindow | undefined;
  #signal: AbortSignal;
  readonly #lifetime = new AbortController();
  private constructor(
    readonly store: OwnedStore,
    private readonly originalBindings: LifecycleBindings,
    readonly handoff: LifecycleHandoff,
    private readonly originalGeneration: MetadataGeneration | null,
    private readonly originalState: LifecycleState,
    readonly options: LifecycleOptions,
    private readonly release: () => void,
  ) {
    this.#signal = AbortSignal.any([
      this.#lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    attempts.add(this);
  }
  get signal(): AbortSignal {
    return this.#signal;
  }
  get bindings(): LifecycleBindings {
    return structuredClone(this.originalBindings);
  }
  get generation(): MetadataGeneration | null {
    return structuredClone(this.originalGeneration);
  }
  get state(): LifecycleState {
    return structuredClone(this.originalState);
  }
  assert(): void {
    if (!attempts.has(this) || !this.#active) throw new Error('Unavailable post attempt.');
    this.signal.throwIfAborted();
    this.#window?.assertCurrent();
    if (this.options.assertCurrent() !== undefined)
      throw new Error('Post lifetime assertion must be synchronous.');
  }
  static async open(opened: OpenedInvocation, options: LifecycleOptions): Promise<PostAttempt> {
    OpenedInvocation.assert(opened);
    const store = opened.store,
      docs = lifecycleDocuments(store.codec.options),
      state = docs['local-state'].parse(opened.state),
      bindings = docs.bindings.parse(opened.bindings);
    if (state[4] !== 'build-ready' && state[4] !== 'completed')
      throw new Error(
        'Interrupted prepare/post cannot resume; use a fresh dedicated root or handle retained data manually.',
      );
    options.signal?.throwIfAborted();
    await store.assertNoIntents();
    equal(await store.state(), state, 'fresh post exact root state');
    const handoff = await LifecycleHandoff.read(store, state[6]!, options);
    let release = () => {};
    try {
      equal(handoff.header[10], bindings[8][7], 'successful prepare cutoff');
      const generation = handoff.header[8]
        ? await readMetadataGeneration(store, handoff.header[8][1], handoff.header[8][0], options)
        : null;
      handoff.checkGeneration(store, generation);
      release = options.budget.holdRecord(
        generation ? 512 + encodeRecord(generation).length * 8 : 0,
      );
      if (state[4] === 'build-ready') {
        state[3]++;
        state[4] = 'post-active';
        await store.updateState(state);
      }
      return new PostAttempt(
        store,
        bindings,
        handoff,
        generation,
        state,
        Object.freeze({ ...options }),
        release,
      );
    } catch (error) {
      release();
      handoff.close();
      throw error;
    }
  }
  attachWindow(window: ExclusiveWindow): void {
    this.assert();
    ExclusiveWindow.assertReceipt(window, this.store);
    if (this.#window || this.store.codec.options.role === 'distributed-worker')
      throw new Error('Unexpected exclusive post window.');
    this.#window = window;
    this.#signal = AbortSignal.any([this.#signal, window.signal]);
  }
  claimCapture(): void {
    this.assert();
    if (
      this.originalState[4] !== 'post-active' ||
      this.#captured ||
      this.store.codec.options.access !== 'writable' ||
      (this.store.codec.options.role !== 'distributed-worker' && !this.#window)
    )
      throw new Error('Post capture has no current exclusive owner.');
    this.#captured = true;
  }
  async guard(): Promise<void> {
    this.assert();
    await assertLifecycleWindow(this.store, this.originalBindings, {
      signal: this.signal,
      assertCurrent: () => {
        this.assert();
        return undefined;
      },
    });
  }
  async finish(terminal: LifecycleTerminal): Promise<void> {
    await this.guard();
    if (this.originalState[4] !== 'post-active') throw new Error('Post attempt already completed.');
    equal(await this.store.state(), this.originalState, 'post terminal original attempt');
    if (terminal[1] !== 'skipped-not-quiescent') {
      const activity = this.handoff.header[9];
      if (!this.store.hasAdmittedMetadata(activity))
        for await (const row of this.store.rows(
          activity,
          'activity',
          { ...this.options, partition: null },
          this.signal,
        ))
          void row;
      await this.store.retireAdmittedMetadata(activity);
    }
    this.originalState[3]++;
    this.originalState[4] = 'completed';
    this.originalState[7] = terminal;
    await this.store.updateState(this.originalState);
    await this.guard();
  }
  close(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#lifetime.abort(new Error('Post attempt closed.'));
    this.handoff.close();
    this.release();
  }
}
