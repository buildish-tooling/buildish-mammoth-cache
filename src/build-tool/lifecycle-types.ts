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

import type { OwnedStore, Reference } from '../cache/streaming/owned-store';
import type { WorkingBudget } from '../cache/streaming/tree-state';
import type { Context } from '../cache/streaming/schema';
import type { CiJobContext } from '../ci';
import type { DependencyLayer } from '../cache/streaming/dependency-layer-descriptor';
import type { MetadataBaseRestore } from '../cache/streaming/metadata-base-restore';
import type { NativeOperationOptions } from '../cache/streaming/native-operation';
import type { Overlay, OverlayCapture } from '../cache/streaming/overlay';
import type { HandoffEntry } from '../cache/streaming/lifecycle-handoff';
import type { LocalOptions } from '../cache/streaming/local-schema';
import type { ResolvedModel } from '../cache/streaming/model';

export interface LayerInputs {
  readonly hasWrapper?: () => boolean;
  readonly existingDependencyLayer?: string;
}

export interface DependencyLayerPolicy {
  assertInputs(
    model: ResolvedModel,
    owner: Pick<LocalOptions, 'role' | 'access' | 'context'>,
    cleanup: string,
    inputs: LayerInputs,
  ): void;
  prepare(
    store: OwnedStore,
    restored: MetadataBaseRestore,
    cleanup: string,
    inputs: LayerInputs,
    options: NativeOperationOptions,
  ): Promise<DependencyLayer | undefined>;
  check(store: OwnedStore, layer: DependencyLayer, key: string | null): void;
  verify(store: OwnedStore, layer: DependencyLayer): Promise<void>;
  retire(store: OwnedStore, layer: DependencyLayer, options: NativeOperationOptions): Promise<void>;
  path(store: OwnedStore, layer: DependencyLayer): string;
}

export interface OverlayPolicy {
  prepareTarget(
    store: OwnedStore,
    restored: MetadataBaseRestore,
    inputs: LayerInputs,
  ): Promise<string | undefined>;
  accepts(store: OwnedStore, target: string, entries: readonly HandoffEntry[]): boolean;
  capture(
    store: OwnedStore,
    overlay: Overlay,
    options: NativeOperationOptions & { readonly signal: AbortSignal },
  ): Promise<OverlayCapture>;
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#build-tool-lifecycle-boundary.
/** Tool operations only; shared cache code retains lifecycle/mutation authority. */
export interface BuildToolLifecycle {
  readonly tool: Context[7];
  readonly dependencyLayer?: DependencyLayerPolicy;
  readonly overlay?: OverlayPolicy;
  assertRestoreConsumersAbsent(signal: AbortSignal): Promise<void>;
  prepareCapture(
    store: OwnedStore,
    context: Pick<CiJobContext, 'tempDirectory'>,
    ordinaryHooks: () => Promise<void>,
    layered?: boolean,
  ): Promise<void>;
  quiesce(input: ConsumerWindowInput): Promise<Reference | undefined>;
  removeKnownHooks(root: string): Promise<readonly string[]>;
}

export interface ConsumerWindowInput {
  readonly store: OwnedStore;
  readonly budget: WorkingBudget;
  readonly installations: Reference | undefined;
  readonly sourcesFrozen: boolean;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly deadline: number;
  readonly clientTimeout: number;
  readonly exitGrace: number;
}

/** Always selected from the currently validated owner, including OLD-owner recovery. */
export type LifecycleResolver = (tool: Context[7]) => Promise<BuildToolLifecycle>;
