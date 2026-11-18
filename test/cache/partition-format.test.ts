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

import { expect, it } from 'vitest';
import { cutoffFixtureModel } from '../support/cutoff-fixture';
import { createCacheGeneration } from '../../src/cache/model';
import {
  partitionObjectKey,
  storageDigest,
  validatePartitionDescriptor,
  validateGenerationRecord,
  createRecoveryGroups,
  type PartitionDescriptor,
  type PartitionReference,
  type GenerationRecord,
} from '../../src/cache/partition-format';
const model = cutoffFixtureModel('/tmp/partition-format');
function fixture() {
  const identity = {
    familyKey: model.cacheFamilyKey,
    lineagePrefix: model.currentRefLineagePrefix,
    partitionId: 'data',
    writerId: 'run-1',
    decisionDigest: 'a'.repeat(64),
  };
  const descriptor: PartitionDescriptor = {
    schemaVersion: 1,
    identity,
    buildToolId: model.buildToolId,
    partitionFingerprint: model.partitionFingerprint,
    kind: 'aggregate',
    workspaces: [],
    files: [
      {
        relativePath: 'data/a',
        payloadPath: 'data/a',
        contentSha256: 'b'.repeat(64),
        size: 3,
        mode: 0o644,
        mtimeMs: 1,
      },
    ],
  };
  const reference: PartitionReference = {
    identity,
    key: partitionObjectKey(identity),
    descriptorDigest: storageDigest(descriptor),
  };
  const generation = createCacheGeneration(model, 'c'.repeat(64));
  const record: GenerationRecord = {
    schemaVersion: 1,
    familyKey: model.cacheFamilyKey,
    buildToolId: model.buildToolId,
    partitionFingerprint: model.partitionFingerprint,
    lineagePrefix: generation.lineagePrefix,
    generationId: generation.generationId,
    decisionDigest: generation.contentDigest,
    key: generation.key,
    partitions: [{ partitionId: 'data', kind: 'object', reference }],
    recoveryGroups: [['data']],
  };
  return { descriptor, reference, record };
}
it('validates exact generation/partition identity and keeps object keys out of generation prefixes', () => {
  const { descriptor, reference, record } = fixture();
  expect(validateGenerationRecord(model, record, record.key)).toEqual(record);
  expect(validatePartitionDescriptor(model, descriptor, reference)).toEqual(descriptor);
  expect(reference.key.startsWith(model.currentRefLineagePrefix)).toBe(false);
  expect(() => validateGenerationRecord(model, record, record.key + '-suffix')).toThrow();
});
it('rejects foreign origins, descriptor tampering, disabled partitions and duplicate groups', () => {
  const { descriptor, reference, record } = fixture();
  expect(() =>
    validateGenerationRecord(
      model,
      { ...record, recoveryGroups: [['data'], ['data']] },
      record.key,
    ),
  ).toThrow();
  expect(() =>
    validateGenerationRecord(model, { ...record, partitions: [] }, record.key),
  ).toThrow();
  expect(() =>
    validatePartitionDescriptor(model, { ...descriptor, files: [] }, reference),
  ).toThrow();
  const foreign = {
    ...reference,
    identity: { ...reference.identity, lineagePrefix: 'foreign-gen-' },
  };
  expect(() => validatePartitionDescriptor(model, descriptor, foreign)).toThrow();
});
it('rejects unmanaged payloads even when the descriptor checksum was recomputed', () => {
  const { descriptor, reference } = fixture();
  descriptor.files[0]!.relativePath = '.mammoth/local-journal';
  reference.descriptorDigest = storageDigest(descriptor);
  expect(() => validatePartitionDescriptor(model, descriptor, reference)).toThrow();
});
it('accepts explicit empty and zero-partition records without payload objects', () => {
  const { record } = fixture();
  record.partitions = [{ partitionId: 'data', kind: 'empty' }];
  expect(validateGenerationRecord(model, record, record.key)).toEqual(record);
  expect(
    validateGenerationRecord(
      { ...model, partitions: [] },
      { ...record, partitions: [], recoveryGroups: [] },
      record.key,
    ).partitions,
  ).toEqual([]);
});
it('groups connected Maven directory owners while leaving unrelated partitions separate', () => {
  const { descriptor } = fixture();
  const multi = {
    ...model,
    buildToolId: 'maven',
    partitions: ['jar', 'marker', 'other'].map((id) => ({ ...model.partitions[0]!, id })),
  };
  const d = (id: string, relativePath: string): PartitionDescriptor => ({
    ...descriptor,
    identity: { ...descriptor.identity, partitionId: id },
    files: [{ ...descriptor.files[0]!, relativePath }],
  });
  expect(
    createRecoveryGroups(multi, [
      d('jar', 'repository/g/a/1/a.jar'),
      d('marker', 'repository/g/a/1/_remote.repositories'),
      d('other', 'repository/g/b/1/b.jar'),
    ]),
  ).toEqual([['jar', 'marker'], ['other']]);
});
