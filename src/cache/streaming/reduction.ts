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

import { z } from 'zod';
import { modeSchema, nameSchema, shaSchema, uintSchema } from './schema';

// Protocol: docs/dev/cache-protocol.md#ordinary-file-reduction
export const candidateSchema = z.tuple([nameSchema, shaSchema, uintSchema, uintSchema, modeSchema]);
export type Candidate = z.infer<typeof candidateSchema>;
export function ordinaryOrder(jobs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const job of jobs) {
    nameSchema.parse(job);
    if (!seen.has(job)) {
      if (seen.size === 16) throw new Error('Producer admission exceeded.');
      seen.add(job);
      result.push(job);
    }
  }
  return result;
}
export function foldOrdinary(
  current: Candidate | null,
  incoming: Candidate,
  policy: 'strict' | 'newer-mtime',
  launcher = false,
): Candidate {
  if (policy !== 'strict' && policy !== 'newer-mtime') throw new Error('Invalid duplicate policy.');
  const e = candidateSchema.parse(incoming);
  if (launcher && e[4] !== 493) throw new Error('Noncanonical launcher mode.');
  if (!current) return e;
  const r = candidateSchema.parse(current);
  if (launcher && r[4] !== 493) throw new Error('Noncanonical launcher mode.');
  if (r[1] === e[1] && r[2] === e[2]) {
    const chosen = e[3] > r[3] ? e : r;
    return [
      chosen[0],
      chosen[1],
      chosen[2],
      Math.max(r[3], e[3]),
      launcher ? 493 : 420 | ((r[4] | e[4]) & 73),
    ];
  }
  if (policy === 'strict' || r[3] === e[3]) throw new Error('Prohibited ordinary-file conflict.');
  return e[3] > r[3] ? e : r;
}
/** This map is only the admitted <=16-candidate frontier for one path. */
export function reduceOrdinary(
  candidates: Iterable<Candidate>,
  jobs: readonly string[],
  policy: 'strict' | 'newer-mtime',
  launcher = false,
): Candidate | null {
  const frontier = new Map<string, Candidate>();
  for (const input of candidates) {
    const c = candidateSchema.parse(input);
    if (frontier.has(c[0])) throw new Error('Duplicate producer identity.');
    if (frontier.size === 16) throw new Error('Producer admission exceeded.');
    frontier.set(c[0], c);
  }
  let result: Candidate | null = null;
  for (const job of ordinaryOrder(jobs)) {
    const candidate = frontier.get(job);
    if (candidate) result = foldOrdinary(result, candidate, policy, launcher);
  }
  return result;
}
