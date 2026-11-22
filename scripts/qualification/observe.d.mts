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

interface Row {
  pid: number;
  parent: number;
  rss: number;
}
export function treeRss(rows: Row[], parent: number): number;
export function snapshot(): Promise<{
  rows: Row[];
  available: number;
  total: number;
  paging: { input: number; output: number } | null;
}>;
export function observe(control: string, output: string): Promise<void>;

export function cgroupDirectories(group: string, mountRoot?: string): string[] | null;

export function cgroupLimits(
  directories: string[],
  read?: (file: string, encoding: string) => Promise<string>,
): Promise<{ total: number; available: number }>;
