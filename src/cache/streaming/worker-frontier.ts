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

import type { Readable } from 'node:stream';
import { withAbort } from './abort';
import { add, type Value } from './encoding';
import { readWorkerArchive, type WorkerFile } from './worker-codec';
import type { WorkerContext, WorkerSummary } from './worker-state';

export type FrontierItem =
  | { readonly type: 'control'; readonly value: Value }
  | { readonly type: 'file'; readonly file: WorkerFile };
// Protocol: docs/dev/cache-protocol.md#reader-state-machine.
// One rendezvous slot. Advancing acknowledges body consumption FIRST; immediate
// validated file-meta is a separate rendezvous. Never wait for it inside consumeFile.
export class WorkerFrontier {
  readonly work = { peakPending: 0, bodyBytes: 0, files: 0, controls: 0, archivePasses: 1 };
  readonly completion: Promise<WorkerSummary>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private slot: FrontierItem | null = null;
  private acknowledge: (() => void) | null = null;
  private notify: (() => void) | null = null;
  private done = false;
  private failure: unknown;
  private waiting = false;
  private delivered = false;
  private failed = false;
  constructor(source: Readable, options: WorkerContext, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.completion = readWorkerArchive(
      source,
      {
        ...options,
        consumeFile: async (file, s) => {
          this.work.files++;
          const self = this;
          const counted = {
            ...file,
            body: (async function* () {
              for await (const b of file.body) {
                self.work.bodyBytes = add(self.work.bodyBytes, b.length);
                yield b;
              }
            })(),
          };
          await this.offer({ type: 'file', file: counted }, s);
        },
        event: async (value, s) => {
          this.work.controls++;
          await this.offer({ type: 'control', value }, s);
        },
      },
      this.signal,
    );
    // Attach immediately: a transport error can occur before the first consumer next.
    void this.completion.then(
      () => {
        this.done = true;
        this.notify?.();
      },
      (error) => {
        this.failed = true;
        this.failure = error;
        this.done = true;
        this.notify?.();
      },
    );
  }
  private async offer(item: FrontierItem, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.slot || this.acknowledge) throw new Error('Unacknowledged worker frontier.');
    let release!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.slot = item;
    this.acknowledge = release;
    this.work.peakPending = 1;
    this.notify?.();
    await withAbort(acknowledged, signal);
  }
  async next(): Promise<FrontierItem | null> {
    if (this.waiting) throw new Error('Concurrent frontier consumer.');
    this.waiting = true;
    try {
      this.signal.throwIfAborted();
      if (this.delivered) {
        this.delivered = false;
        this.slot = null;
        const ack = this.acknowledge;
        this.acknowledge = null;
        ack?.();
      }
      while (!this.slot && !this.done) {
        await withAbort(
          new Promise<void>((resolve) => {
            this.notify = resolve;
          }),
          this.signal,
        );
        this.notify = null;
      }
      this.signal.throwIfAborted();
      if (this.failed) throw this.failure;
      this.delivered = this.slot !== null;
      return this.slot;
    } finally {
      this.waiting = false;
    }
  }
  cancel(reason: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }
  async close(): Promise<void> {
    if (!this.done) this.cancel(new Error('Worker frontier closed.'));
    await this.completion.catch(() => {});
    this.slot = null;
    this.acknowledge = null;
    this.notify = null;
  }
}
