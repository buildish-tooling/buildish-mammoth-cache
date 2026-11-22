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

export function relativeFile(index: number, count: number): string;
export function body(index: number, changed?: boolean): Buffer;
export function generate(root: string, count: number): Promise<void>;
export function mutate(
  root: string,
  count: number,
): Promise<{ modified: number; deleted: number; added: number; untouched: number }>;
export function verify(
  root: string,
  count: number,
  changed?: boolean,
): Promise<{ files: number; bytes: number }>;
export function capacity(
  root: string,
  count: number,
): Promise<{ free: number; allocationPerFile: number; estimatedRequired: number }>;
