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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
        if (tool === 'gradle' && name === 'layered_workers') {
          // Each warm-layer qualification owns a fresh producer, including on reruns.
          expect(prefix).toBe(
            'it-gradle-layer-${{ github.run_id }}-a${{ needs.layer_seed.outputs.attempt }}-',
          );
          continue;
        }
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
            ACTION_READ_ONLY: 'false',
            ACTION_DEPENDENT_DELTA_STATUS: 'applied',
            ACTION_DEPENDENT_DELTA_ARTIFACT_COUNT: '3',
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
    env: Record<string, string>;
    jobs: Record<string, { steps: { with?: Record<string, string> }[] }>;
  };
  for (const name of ['maven_workers', 'maven_aggregator']) {
    const action = workflow.jobs[name]!.steps.find((s) =>
      s.with?.['job-mode']?.startsWith('distributed-'),
    );
    expect(action!.with!['cache-partitions']).toBe('${{ env.IT_CACHE_PARTITIONS }}');
    expect(JSON.parse(workflow.env.IT_CACHE_PARTITIONS!)).toContainEqual({
      id: 'repository',
      'conflict-handling': 'choose-worker-directory',
    });
  }
});

// Protect the transport graph and native invocation boundaries, without emulating an OS.
it.each(['gradle', 'maven'])(
  '%s native readers wait for publication and share its family',
  async (tool) => {
    const workflow = parse(await readFile(`.github/workflows/it-reusable-${tool}.yml`, 'utf8'));
    const prefix = tool === 'maven' ? 'maven_' : '';
    const workers = workflow.jobs[prefix + 'workers'];
    const aggregator = workflow.jobs[prefix + 'aggregator'];
    const reader = workflow.jobs[prefix + 'standalone_cross_platform'];
    expect(aggregator.needs).toEqual([prefix + 'workers']);
    expect(reader.needs).toEqual([prefix + 'aggregator']);
    expect(reader.if).toContain('inputs.run-cross-platform');
    expect(reader.if).toContain('inputs.run-writable-scenarios');
    expect(workers.strategy.matrix.worker.map((w: { id: string }) => w.id)).toEqual(
      ['a', 'b', 'c'].map((id) => prefix + 'worker_' + id),
    );
    expect(reader.strategy.matrix.reader).toEqual([
      { id: 'windows', os: 'windows-2025', arch: 'x64', java: '21' },
      { id: 'macos', os: 'macos-15', arch: 'arm64', java: '25' },
    ]);
    const action = (job: typeof aggregator) =>
      job.steps.find((s: { uses?: string }) => s.uses === `./actions/github/${tool}`);
    for (const job of [workers, aggregator, reader]) {
      expect(action(job).with['cache-partitions']).toBe('${{ env.IT_CACHE_PARTITIONS }}');
      expect(action(job).with['cache-key-prefix']).toBe(
        action(aggregator).with['cache-key-prefix'],
      );
    }
    expect(action(reader).with['read-only']).toBe(true);
    for (const job of [workers, reader]) {
      const native = job.steps.find((s: { name: string }) => s.name.includes('(Windows)'));
      expect(native.if).toBe("runner.os == 'Windows'");
      expect(native.shell).toBe('pwsh');
      expect(native.run).toContain(tool === 'gradle' ? './gradlew.bat' : 'mvn.cmd');
      expect(native.run).toContain('$LASTEXITCODE');
    }
    const partitions = JSON.parse(workflow.env.IT_CACHE_PARTITIONS);
    expect(partitions).toContainEqual({
      id: 'it-portability',
      includes: ['it-portability/**'],
      publication: 'aggregate',
    });
    if (tool === 'gradle')
      expect(partitions).toContainEqual({ id: 'dependency-metadata', writer: 'aggregator' });
  },
);

it('keeps native write jobs out of PR routing and requires local integration tool homes', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  for (const tool of ['gradle', 'maven']) {
    const pr = workflow.jobs[`integration-pr-${tool}`];
    expect(pr.if).toBe("github.event_name == 'pull_request'");
    expect(pr.with['run-writable-scenarios']).toBe(false);
    expect(pr.with['run-cross-platform']).toBe(false);
    expect(workflow.jobs[`integration-trusted-${tool}`].if).toBe("github.event_name == 'push'");
    expect(workflow.jobs.required_checks.needs).toContain(`integration-trusted-${tool}`);
    expect(workflow.jobs.required_checks.needs).toContain(`integration-pr-${tool}`);
  }
  const local = workflow.jobs['local-integration-tests'].steps
    .map((s: { run?: string }) => s.run || '')
    .join('\n');
  for (const value of [
    'BUILDISH_TEST_GRADLE_EXECUTABLE',
    'BUILDISH_TEST_JAVA_21_HOME',
    'BUILDISH_TEST_JAVA_25_HOME',
  ]) {
    expect(local).toContain(`test -x "$${value}`);
  }
  const setup = parse(await readFile('.github/actions/it-setup/action.yml', 'utf8'));
  expect(
    setup.runs.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/setup-java@')).with[
      'java-version'
    ],
  ).toBe('${{ inputs.java-version }}');
});

it.each(['gradle', 'maven'])(
  '%s initializes runner-dependent cache roots in steps',
  async (tool) => {
    const workflow = parse(await readFile(`.github/workflows/it-reusable-${tool}.yml`, 'utf8'));
    const prefix = tool === 'maven' ? 'maven_' : '';
    const home = tool === 'gradle' ? 'GRADLE_USER_HOME' : 'MAVEN_USER_HOME';
    for (const job of Object.values(workflow.jobs) as { env?: Record<string, string> }[]) {
      expect(JSON.stringify(job.env || {})).not.toContain('runner.');
    }
    for (const name of ['workers', 'aggregator', 'standalone_cross_platform']) {
      const steps = workflow.jobs[prefix + name].steps;
      const initialize = steps.findIndex(
        (step: { env?: Record<string, string> }) => step.env?.IT_CACHE_HOME,
      );
      const setup = steps.findIndex(
        (step: { uses?: string }) => step.uses === '$/.github/actions/it-setup',
      );
      expect(initialize).toBeGreaterThanOrEqual(0);
      expect(initialize).toBeLessThan(setup);
      expect(steps[initialize].env.IT_CACHE_HOME).toContain('${{ runner.temp }}');
      expect(steps[initialize].run).toContain(home + '=%s');
      expect(steps[initialize].run).toContain('"$GITHUB_ENV"');
    }
  },
);

it('inspects transported Groovy workspaces before any fixture build can repair them', async () => {
  const workflow = parse(await readFile('.github/workflows/it-reusable-gradle.yml', 'utf8'));
  for (const name of ['aggregator', 'standalone_cross_platform']) {
    const steps = workflow.jobs[name].steps;
    const inspection = steps.findIndex((step: { run?: string }) =>
      step.run?.includes('it-cache-fixture.mjs groovy'),
    );
    const firstBuild = steps.findIndex(
      (step: { run?: string }) =>
        step.run?.includes('it-verify-worker-deltas.sh') || step.run?.includes('./gradlew'),
    );
    expect(inspection).toBeGreaterThanOrEqual(0);
    expect(firstBuild).toBeGreaterThan(inspection);
  }
});

it.skipIf(process.platform === 'win32')(
  'accepts native Maven Central origin keys and rejects a different URL',
  async () => {
    const root = await mkdtemp(path.resolve('build/maven-marker-fixture-'));
    const env = { ...process.env, MAVEN_USER_HOME: root };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['.github/scripts/it-cache-fixture.mjs', ...args], {
        env,
        encoding: 'utf8',
      });
    try {
      for (const worker of ['worker_a', 'worker_b', 'worker_c']) {
        expect(run('seed', 'maven', worker).status).toBe(0);
      }
      const artifacts = [
        ['com/google/guava/guava/33.6.0-jre', 'guava-33.6.0-jre.jar'],
        ['commons-io/commons-io/2.22.0', 'commons-io-2.22.0.jar'],
        ['org/apache/commons/commons-collections4/4.5.0', 'commons-collections4-4.5.0.jar'],
      ];
      // Actual tracking key observed in Maven 3.10.0's hosted worker artifact.
      const central = 'central-8fac3ebd6edbaca3c794783fa38088af0aa128e7';
      for (const [directory, jar] of artifacts) {
        const target = path.join(root, 'repository', directory!);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, jar!), 'artifact');
        await writeFile(path.join(target, '_remote.repositories'), `${jar}>${central}=\r\n`);
      }
      const restored = run('assert', 'maven');
      expect(restored.status, restored.stderr).toBe(0);
      const marker = path.join(root, 'repository', artifacts[0]![0]!, '_remote.repositories');
      for (const origin of ['central', 'central-0000000000000000000000000000000000000000', '']) {
        await writeFile(marker, `${artifacts[0]![1]}>${origin}=\n`);
        expect(run('assert', 'maven').status, `Unexpected origin accepted: ${origin}`).not.toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('stages identical Gradle source bytes despite checkout line endings', async () => {
  const root = await mkdtemp(path.resolve('build/fixture-line-endings-'));
  try {
    const source = path.join(root, 'source');
    await mkdir(source);
    const scripts = ['build.gradle', 'settings.gradle', 'gradlew'];
    for (const name of scripts) {
      const text = await readFile(
        path.join('test/fixtures/integration/gradle-project', name),
        'utf8',
      );
      await writeFile(
        path.join(source, name),
        text.replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n'),
      );
    }
    const binary = Buffer.from([0, 13, 10, 255]);
    await writeFile(path.join(source, 'payload.bin'), binary);
    await writeFile(path.join(source, 'gradlew.bat'), '@echo off\r\n');
    await writeFile(path.join(source, 'pom.xml'), '<project/>\r\n');
    const result = spawnSync('bash', ['.github/scripts/stage-fixture.sh', 'line-endings'], {
      env: { ...process.env, ACTION_DIRECTORY: root, FIXTURE_SOURCE_DIRECTORY: source },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const staged = path.join(root, 'build/integration-fixtures/line-endings');
    for (const name of scripts) {
      expect(await readFile(path.join(staged, name))).toEqual(
        Buffer.from(
          (
            await readFile(path.join('test/fixtures/integration/gradle-project', name), 'utf8')
          ).replace(/\r\n/gu, '\n'),
        ),
      );
      expect(await readFile(path.join(source, name), 'utf8')).toContain('\r\n');
    }
    expect(await readFile(path.join(staged, 'payload.bin'))).toEqual(binary);
    expect(await readFile(path.join(staged, 'gradlew.bat'), 'utf8')).toBe('@echo off\r\n');
    expect(await readFile(path.join(staged, 'pom.xml'), 'utf8')).toBe('<project/>\r\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
