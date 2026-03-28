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

import type { InputProvider } from '../config/types';

/** Host capability for resolving action inputs. */
export type HostInputSource = InputProvider;

/** Host capability for persisting cross-phase action state. */
export interface HostStateStore {
  getState(name: string): string;
  saveState(name: string, value: string): void;
}

/** Host capability for publishing entrypoint outputs. */
export interface HostOutputSink {
  setOutput(name: string, value: unknown): void;
}

/** Host capability for non-fatal diagnostics. */
export interface HostReporter {
  info(message: string): void;
  warning(message: string): void;
}

/** Host capability for marking the active execution as failed. */
export interface HostFailureReporter {
  setFailed(message: string): void;
}

/** Composite host used by provider implementations that need all capabilities. */
export type CompositeHost = HostInputSource &
  HostStateStore &
  HostOutputSink &
  HostReporter &
  HostFailureReporter;

/**
 * Provider-specific reporting surface used by shared action flows.
 */
export interface ReportSink {
  /** Publishes the provided lines as a grouped log block using the provider-specific log surface. */
  publishLogGroup(
    title: string,
    lines: readonly string[],
    writeLine: (message: string) => void,
  ): void;
  /** Publishes the provided Markdown lines to the provider summary surface. */
  publishSummary(lines: readonly string[]): Promise<void>;
  /** Replaces the current provider-managed summary content when supported. */
  replaceSummary(lines: readonly string[]): Promise<void>;
}
