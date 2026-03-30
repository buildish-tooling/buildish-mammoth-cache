/*
 * Copyright 2026 The Apache Software Foundation
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

/**
 * Config-domain validation and normalization utilities shared by every build-tool-specific
 * config normalizer.
 *
 * Unlike the generic helpers in `../util/action-input`, the functions here carry domain
 * knowledge: cache key format rules, partition glob constraints, pull-request read-only
 * semantics, and workspace-relative path normalization.
 */

import * as path from 'node:path';

import { isAbsolutePosixOrWindowsPath, normalizeUserSuppliedRelativePath } from '../util/paths';
import { parseSerializedJson } from '../util/serialization';
import { CACHE_KEY_TEMPLATE_PLACEHOLDERS, type ConfiguredCachePartitionInput } from './types';

// ---------------------------------------------------------------------------
// Private constants
// ---------------------------------------------------------------------------

const CACHE_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CACHE_PARTITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const UNSUPPORTED_GLOB_TOKENS_PATTERN = /[?[\]{}!]/u;
const MAX_TEMPLATE_LENGTH = 200;

// ---------------------------------------------------------------------------
// Exported domain validators
// ---------------------------------------------------------------------------

/**
 * Restricts the cache key prefix to a conservative character set.
 *
 * @throws {Error} When the value does not start with an alphanumeric character or contains
 *   unsupported characters.
 */
export function validateCacheKeyPrefix(input: string): string {
  const trimmed = input.trim();
  if (!CACHE_KEY_PREFIX_PATTERN.test(trimmed)) {
    throw new Error(
      'cache-key-prefix must start with an alphanumeric character and only contain letters, numbers, dot, underscore, and dash.',
    );
  }
  return trimmed;
}

/**
 * Validates the optional cache key template against the supported placeholder set.
 *
 * Returns `null` for empty inputs (the normalizer will fall back to the default template).
 *
 * @throws {Error} When the template is too long, uses an unsupported placeholder, contains
 *   unsafe literal characters, or omits the mandatory `${partitionFingerprint}` placeholder.
 */
export function validateCacheKeyTemplate(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`cache-key-template must be at most ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  const allowedPlaceholders = new Set<string>(CACHE_KEY_TEMPLATE_PLACEHOLDERS);
  for (const match of trimmed.matchAll(/\$\{([A-Za-z0-9]+)}/g)) {
    if (!allowedPlaceholders.has(match[1])) {
      throw new Error(`cache-key-template uses unsupported placeholder '${match[1]}'.`);
    }
  }
  const literalPortion = trimmed.replace(/\$\{([A-Za-z0-9]+)}/g, '');
  if (!/^[A-Za-z0-9._:-]*$/.test(literalPortion)) {
    throw new Error(
      'cache-key-template may only contain supported placeholders and the literal characters A-Z, a-z, 0-9, dot, underscore, colon, and dash.',
    );
  }
  if (!trimmed.includes('${partitionFingerprint}')) {
    throw new Error(
      'cache-key-template must include ${partitionFingerprint} so different cache partition layouts do not share the same cache key.',
    );
  }
  return trimmed;
}

/**
 * Parses the optional JSON cache-partitions input into validated partition descriptors.
 *
 * @throws {Error} On malformed JSON, duplicate partition ids, or invalid glob syntax.
 */
export function parseCachePartitionsInput(input: string): readonly ConfiguredCachePartitionInput[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  const parsed = parseSerializedJson(trimmed, 'cache-partitions');
  const partitionValues = validateArray(parsed, 'cache-partitions');
  const seenIds = new Set<string>();
  return partitionValues.map((partitionValue, index) => {
    const partition = validateRecord(partitionValue, `cache-partitions entry ${index}`);
    const id = validateCachePartitionId(partition.id, `cache-partitions entry ${index} id`);
    if (seenIds.has(id)) {
      throw new Error(`cache-partitions contains duplicate partition id '${id}'.`);
    }
    seenIds.add(id);
    return {
      id,
      includes: validateCachePartitionGlobList(
        partition.includes,
        `cache-partitions entry '${id}' includes`,
        'include',
      ),
      excludes: validateCachePartitionGlobList(
        partition.excludes ?? [],
        `cache-partitions entry '${id}' excludes`,
        'exclude',
      ),
    } satisfies ConfiguredCachePartitionInput;
  });
}

/**
 * Normalizes user-controlled relative paths and rejects workspace-escaping traversal.
 *
 * @throws {Error} When the path is empty, begins with `~`, or would escape the workspace.
 */
export function normalizeRelativePath(input: string, inputName: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error(`${inputName} must not be empty.`);
  if (trimmed.startsWith('~')) {
    throw new Error(`${inputName} must not use home-directory expansion.`);
  }
  return normalizeUserSuppliedRelativePath(trimmed, inputName);
}

/**
 * Returns `true` for GitHub Actions events that should default to read-only cache access.
 *
 * Pull requests from forks run with limited permissions and should not mutate shared cache state.
 */
export function defaultReadOnlyForEvent(eventName: string): boolean {
  return eventName === 'pull_request' || eventName === 'pull_request_target';
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function validateCachePartitionId(value: unknown, label: string): string {
  const id = validateString(value, label).trim();
  if (!CACHE_PARTITION_ID_PATTERN.test(id)) {
    throw new Error(
      `${label} must match ${CACHE_PARTITION_ID_PATTERN} using lowercase letters, numbers, and dashes only.`,
    );
  }
  return id;
}

function validateCachePartitionGlobList(
  value: unknown,
  label: string,
  kind: 'include' | 'exclude',
): readonly string[] {
  const entries = validateArray(value, label);
  return entries.map((entryValue, index) =>
    normalizeCachePartitionGlob(entryValue, `${label} entry ${index}`, kind),
  );
}

function normalizeCachePartitionGlob(
  value: unknown,
  label: string,
  kind: 'include' | 'exclude',
): string {
  const raw = validateString(value, label).trim();
  if (raw.length === 0) throw new Error(`${label} must not be blank.`);
  if (raw.startsWith('~')) throw new Error(`${label} must not use home-directory expansion.`);
  const posixRaw = raw.replaceAll('\\', '/');
  const rawSegments = posixRaw.split('/');
  if (rawSegments.includes('..'))
    throw new Error(`${label} must not use '..' path traversal segments.`);
  if (rawSegments.includes('.')) throw new Error(`${label} must not contain '.' path segments.`);
  const normalized = path.posix.normalize(posixRaw);
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    isAbsolutePosixOrWindowsPath(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`${label} must be a cache-root-relative glob.`);
  }
  if (normalized.startsWith('!')) throw new Error(`${label} must not be a negated glob.`);
  if (UNSUPPORTED_GLOB_TOKENS_PATTERN.test(normalized)) {
    throw new Error(
      `${label} uses unsupported glob syntax. Supported wildcards are '*' within a segment and '**' as a whole path segment.`,
    );
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new Error(`${label} must not contain empty path segments.`);
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`${label} may only use '**' as a complete path segment.`);
    }
  }
  if (kind === 'include') {
    if (segments.at(-1) !== '**') throw new Error(`${label} must end with '/**'.`);
    if (segments.slice(0, -1).includes('**')) {
      throw new Error(`${label} may only use '**' as the final path segment.`);
    }
  }
  return normalized;
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function validateArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function validateRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
