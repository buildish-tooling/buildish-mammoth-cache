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

/**
 * Generic GitHub Actions input parsing utilities.
 *
 * These helpers have no knowledge of any specific build tool or cache domain — they deal only
 * with the raw string values that `@actions/core.getInput` returns and the common patterns
 * (boolean strings, enums, comma/newline-separated lists, name validation) that every action
 * input normalizer needs.
 */

const NAME_PATTERN = /^[A-Za-z0-9._ -]{1,100}$/;

/**
 * Coerces a raw `'true'` / `'false'` action input string to a boolean.
 *
 * @throws {Error} When the trimmed, lower-cased value is neither `'true'` nor `'false'`.
 */
export function parseBooleanInput(input: string, inputName: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${inputName} must be either 'true' or 'false'.`);
}

/**
 * Validates that a raw input string is one of the allowed enum members.
 *
 * @throws {Error} When the value is not in `allowedValues`.
 */
export function parseEnumInput<const T extends readonly string[]>(
  input: string,
  allowedValues: T,
  inputName: string,
): T[number] {
  if (allowedValues.includes(input as T[number])) {
    return input as T[number];
  }
  throw new Error(`${inputName} must be one of: ${allowedValues.join(', ')}.`);
}

/**
 * Splits a comma- or newline-separated list action input into trimmed non-empty entries.
 */
export function parseListInput(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Validates that a human-readable name used for cache coordination only contains safe characters.
 *
 * Allowed: letters, digits, space, dot, underscore, dash — up to 100 characters.
 *
 * @throws {Error} When the value contains unsupported characters.
 */
export function validateNamedValue(value: string, inputName: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `${inputName} contains unsupported characters. Allowed characters are letters, numbers, space, dot, underscore, and dash.`,
    );
  }
  return value;
}
