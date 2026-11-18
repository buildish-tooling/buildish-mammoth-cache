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

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each(['gradle', 'maven'])(
  '%s distributed fixtures keep one cache family across attempts',
  async (tool) => {
    const workflow = parse(await readFile(`.github/workflows/it-reusable-${tool}.yml`, 'utf8')) as {
      jobs: Record<string, { steps: { with?: Record<string, string> }[] }>;
    };
    const prefixes = new Map<string, string>();
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.with?.['job-mode']?.startsWith('distributed-')) continue;
        const prefix = step.with['cache-key-prefix']!;
        expect(prefix).toContain('${{ github.run_id }}');
        expect(prefix).not.toContain('github.run_attempt');
        prefixes.set(name, prefix);
      }
    }
    const jobPrefix = tool === 'maven' ? 'maven_' : '';
    expect(prefixes.size).toBe(4);
    expect(prefixes.get(`${jobPrefix}workers`)).toBe(prefixes.get(`${jobPrefix}aggregator`));
    expect(prefixes.get(`${jobPrefix}pull_request_worker`)).toBe(
      prefixes.get(`${jobPrefix}pull_request_read_only`),
    );
    expect(prefixes.get(`${jobPrefix}workers`)).not.toBe(
      prefixes.get(`${jobPrefix}pull_request_worker`),
    );
  },
);

it.each(['gradle', 'maven'])(
  '%s aggregator assertions distinguish initial isolation from rerun reuse',
  (tool) => {
    for (const attempt of ['1', '2']) {
      for (const status of [
        'miss',
        'current-lineage-hit',
        'fallback-lineage-hit',
        'feature-unavailable',
      ]) {
        const result = spawnSync('bash', [`.github/scripts/it-assert-${tool}-aggregator.sh`], {
          env: {
            ...process.env,
            GITHUB_RUN_ATTEMPT: attempt,
            ACTION_BASE_CACHE_RESTORE_STATUS: status,
            ACTION_JOB_MODE: 'distributed-aggregator',
            ACTION_DEPENDENT_DELTA_STATUS: 'applied',
            ACTION_DEPENDENT_DELTA_ARTIFACT_COUNT: '2',
          },
        });
        expect(result.error).toBeUndefined();
        const accepted = status === 'miss' || (attempt !== '1' && status === 'current-lineage-hit');
        expect(result.status, `attempt ${attempt}, restore ${status}`).toBe(accepted ? 0 : 1);
      }
    }
  },
);

it('Maven writable workers and aggregator explicitly share the directory conflict policy', async () => {
  const workflow = parse(await readFile('.github/workflows/it-reusable-maven.yml', 'utf8')) as {
    jobs: Record<string, { steps: { with?: Record<string, string> }[] }>;
  };
  for (const name of ['maven_workers', 'maven_aggregator']) {
    const action = workflow.jobs[name]!.steps.find((s) =>
      s.with?.['job-mode']?.startsWith('distributed-'),
    );
    expect(JSON.parse(action!.with!['cache-partitions']!)).toEqual([
      { id: 'repository', 'conflict-handling': 'choose-worker-directory' },
    ]);
  }
});
