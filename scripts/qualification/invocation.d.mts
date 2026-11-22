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

export function fileCommands(text: string): Record<string, string>;
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function atomic(file: string, value: unknown): Promise<void>;
export function invocation(
  base: string,
  tool: string,
  identity: string,
  inputs?: Record<string, string>,
): Promise<{
  home: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  phase(
    name: string,
    observer?: (pid: number) => Promise<void>,
  ): Promise<{ outputs: Record<string, string> }>;
}>;
