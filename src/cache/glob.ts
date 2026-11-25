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

type GlobSegment = { readonly regex: RegExp } | 'globstar';

export function createCacheGlobMatcher(patterns: readonly string[]) {
  const compiled: GlobSegment[][] = patterns.map((pattern) =>
    pattern
      .split('/')
      .map((segment) => (segment === '**' ? 'globstar' : { regex: compileSegmentRegex(segment) })),
  );
  return (name: string, scope: 'exact' | 'descendants' | 'subtree' = 'exact'): boolean => {
    const segments = name.split('/');
    return compiled.some(
      (pattern) =>
        (scope !== 'subtree' || pattern.at(-1) === 'globstar') &&
        matchesGlobSegments(segments, pattern, scope === 'descendants'),
    );
  };
}

function matchesGlobSegments(
  pathSegments: readonly string[],
  patternSegments: readonly GlobSegment[],
  descendants: boolean,
  pathIndex = 0,
  patternIndex = 0,
): boolean {
  if (descendants && pathIndex === pathSegments.length) {
    return patternIndex < patternSegments.length;
  }
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === 'globstar') {
    if (descendants) {
      return true;
    }
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (
        matchesGlobSegments(
          pathSegments,
          patternSegments,
          descendants,
          nextPathIndex,
          patternIndex + 1,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  if (pathIndex === pathSegments.length) {
    return false;
  }

  return (
    patternSegment.regex.test(pathSegments[pathIndex]) &&
    matchesGlobSegments(pathSegments, patternSegments, descendants, pathIndex + 1, patternIndex + 1)
  );
}

function compileSegmentRegex(patternSegment: string): RegExp {
  return new RegExp(
    `^${patternSegment.replaceAll(/([.+^${}()|[\]\\])/g, '\\$1').replaceAll('*', '[^/]*')}$`,
    'u',
  );
}
