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

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { parseCachePartitionsInput } from '../../src/config/shared';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import { createCachePartitions } from '../../src/cache/model';
import { cutoffFixtureCi } from '../support/cutoff-fixture';

interface Workflow {
  env: { MAMMOTH_CACHE_PARTITIONS: string };
  jobs: Record<
    string,
    { needs?: string[]; if?: string; steps: { uses?: string; with?: Record<string, string> }[] }
  >;
}
describe('distributed Gradle workflow examples', () => {
  it.each(['gradle-distributed.yml', 'gradle-optional-metadata-writer.yml'])(
    'uses one compatible partition policy in every participating job in %s',
    async (name) => {
      const text = await readFile('examples/' + name, 'utf8');
      const workflow = parse(text) as Workflow;
      const partitions = parseCachePartitionsInput(workflow.env.MAMMOTH_CACHE_PARTITIONS);
      const writer = partitions[0]!.writer!;
      expect(workflow.jobs[writer]).toBeDefined();
      const guide = await readFile('docs/user/distributed-jobs.md', 'utf8');
      expect(guide).toContain(text.slice(text.indexOf('name: ')).trim());
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const action = job.steps.find((step) => step.uses?.includes('/actions/github/gradle@'))!;
        expect(action.with?.['cache-partitions']).toBe('${{ env.MAMMOTH_CACHE_PARTITIONS }}');
        const source = {
          getInput: (key: string) =>
            key === 'cache-partitions'
              ? workflow.env.MAMMOTH_CACHE_PARTITIONS
              : (action.with?.[key] ?? ''),
        };
        const config = normalizeGradleActionConfig(readGradleActionInputs(source), {
          phase: 'prepare',
          ciContext: cutoffFixtureCi(process.cwd(), jobName),
          env: {},
        });
        const adapter = new GradleBuildToolAdapter(config);
        const resolved = createCachePartitions(
          '/cache',
          config.cachePartitions,
          adapter.getBuiltInPartitionPresets(),
          adapter.getHardCacheExcludeGlobs(),
        );
        expect(resolved.find((p) => p.id === 'dependency-metadata')).toMatchObject({
          publication: 'single-writer',
          writer,
        });
        if (action.with?.['job-mode'] === 'distributed-aggregator') {
          expect(job.needs).toContain(writer);
          expect(job.if).toContain('always()');
          if (name === 'gradle-optional-metadata-writer.yml') {
            expect(config.dependentJobs).not.toContain(writer);
            expect(config.dependentJobs).toEqual(['build']);
            expect(workflow.jobs[writer]!.if).toContain('inputs.run_metadata');
          } else expect(config.dependentJobs).toContain(writer);
        }
      }
    },
  );
});
