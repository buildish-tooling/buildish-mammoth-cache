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

import { LocalCodec, type LocalOptions } from '../../../src/cache/streaming/local-schema';
import { invocationId, resolveModel, decisionId } from '../../../src/cache/streaming/model';
import { rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { modelVector, context } from './protocol-fixtures';
export const nonce = 'a'.repeat(32),
  h = 'a'.repeat(64);
export const native = ['native', 1, 'file', '1', '2', '0', 33188, '-1', '0', '1', null] as const;
export const directory = [
  'native',
  1,
  'directory',
  '1',
  '3',
  '0',
  16877,
  '-1',
  '0',
  '1',
  null,
] as const;
export function localOptions(): LocalOptions {
  return {
    model: resolveModel(modelVector, 'vectors-', 1),
    context: [...context],
    invocation: invocationId(context, nonce),
    role: 'standalone',
    access: 'writable',
  };
}
export function localFixtures(options = localOptions(), invocationNonce = nonce) {
  const codec = new LocalCodec(options),
    prefix = codec.schemas.prefix;
  const q = (purpose: string, sha = h): Value[] => [
    'ref',
    purpose,
    prefix + purpose + '.ndjson',
    100,
    sha,
  ];
  const evidence = (): Value => ['evidence', q('native-evidence'), ['span', h, 1, 2]];
  const cursor = (n = 0): Value[] => ['cursor', h, n, n, n, null];
  const policy: Value = [
    'policy',
    1,
    options.role,
    options.access,
    'none',
    'off',
    null,
    1,
    'strict',
    100000,
    [],
  ];
  const bindings: Value[] = [
    'bindings',
    2,
    options.invocation,
    options.context,
    invocationNonce,
    ['/cache', directory],
    q('model'),
    options.model.familyProjection,
    policy,
  ];
  const bytes = codec.encode(bindings);
  const state: Value[] = [
    'local-state',
    2,
    options.invocation,
    1,
    'build-ready',
    ['ref', 'bindings', prefix + 'bindings.json', bytes.length, rawSha(bytes)],
    q('handoff'),
    null,
  ];
  const decision: Value = [
    'decision',
    1,
    options.invocation,
    options.model.id,
    options.model.family,
    h,
    h,
    null,
    h,
    h,
  ];
  const publication: Value[] = [
    'publication',
    1,
    options.invocation,
    decision,
    decisionId(decision),
    q('post-sources'),
    q('publication-partitions'),
    q('generation'),
    'key',
  ];
  const relocation: Value[] = [
    'relocation',
    1,
    options.invocation,
    'data',
    1,
    q('move-plan'),
    null,
    'outbound',
    cursor(),
    cursor(),
    null,
    null,
    null,
    null,
    null,
  ];
  return { codec, options, prefix, q, evidence, cursor, bindings, state, publication, relocation };
}
