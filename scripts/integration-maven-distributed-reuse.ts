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
 * Local Maven distributed-reuse integration test.
 *
 * Exercises the full worker-A → worker-B → aggregator delta-exchange flow using
 * {@link MavenBuildToolAdapter} and a staged Maven fixture project.  The GitHub Actions cache
 * is replaced by {@link UNAVAILABLE_CACHE_API}; artifact exchange uses an in-process
 * {@link FakeArtifactApi} that copies artifact directories on disk.
 *
 * Each job gets an isolated Maven user home (`<job-root>/m2`).  The MAVEN_USER_HOME env var
 * is set so the action normalizer picks up the right cache root.  Every `mvn` invocation also
 * receives `-Dmaven.repo.local=<job-root>/m2/repository` so that Maven itself uses the same
 * isolated directory.
 *
 * Assertion strategy: after the aggregator applies both worker deltas, both
 * `mvn -P worker-a dependency:resolve --offline` and
 * `mvn -P worker-b dependency:resolve --offline` must succeed.  Offline mode guarantees the
 * artifacts came from the delta-merged local repository, not from the network.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WorkflowArtifactDescriptor } from '../src/delta/service';
import { createGitHubPlatform, createGitHubReportSink } from '../src/ci/github';
import { MavenBuildToolAdapter } from '../src/build-tool/maven/adapter';
import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
  resolveMavenActionInputsFromConfigFile,
} from '../src/build-tool/maven/config';
import type { NormalizedMavenConfig } from '../src/config/types';
import { createPrepareActionOutputs, executePrepareAction } from '../src/phases/prepare/flow';
import { executeFinalizeAction } from '../src/phases/finalize/flow';
import type { SummaryWriter } from '../src/ci/github/report-sink';
import type { CompositeHost } from '../src/host/types';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../src/delta/backend';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../src/cache/backend';

const RUN_ID = '92003';
const RUN_ATTEMPT = '1';
const CACHE_KEY_PREFIX = `local-it-maven-distributed-${RUN_ID}-${RUN_ATTEMPT}-`;
const INTEGRATION_WORKFLOW_NAME = 'Local Maven Distributed Reuse Integration Test';
const FIXTURE_JOB_NAMES = ['maven_worker_a', 'maven_worker_b', 'maven_aggregator'] as const;
const UNAVAILABLE_CACHE_API: BaseCacheBackend = {
  capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  isFeatureAvailable(): boolean {
    return false;
  },
  async restoreCache(): Promise<string | undefined> {
    throw new Error('restoreCache must not be called when the cache feature is unavailable.');
  },
  async saveCache(): Promise<number> {
    throw new Error('saveCache must not be called when the cache feature is unavailable.');
  },
};

interface LocalMavenJobRuntime {
  readonly jobName: string;
  readonly jobRoot: string;
  readonly projectDirectory: string;
  /** Isolated Maven user home — set as MAVEN_USER_HOME so the action normalizer uses it. */
  readonly mavenUserHome: string;
  /** Path to the local repository inside mavenUserHome — passed to mvn via -Dmaven.repo.local. */
  readonly localRepository: string;
  readonly env: NodeJS.ProcessEnv;
  readonly state: Map<string, string>;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const fixtureSourceDirectory = path.join(
    repoRoot,
    'test',
    'fixtures',
    'integration',
    'maven-project',
  );
  const buildRoot = path.join(repoRoot, 'build');
  await mkdir(buildRoot, { recursive: true });

  const stagedRoot = await mkdtemp(path.join(buildRoot, 'integration-maven-distributed-reuse-'));
  let keepStagedRoot = process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT === '1';

  try {
    const artifactApi = new FakeArtifactApi(path.join(stagedRoot, 'artifacts'));
    const jobs = await stageJobs(stagedRoot, fixtureSourceDirectory);

    // Worker A resolves guava and publishes a delta artifact.
    await runWorkerJob(jobs.maven_worker_a, 'worker-a', artifactApi);
    // Worker B resolves commons-io and publishes a separate delta artifact.
    await runWorkerJob(jobs.maven_worker_b, 'worker-b', artifactApi);

    const uploadedArtifacts = await artifactApi.listArtifacts();
    assert.equal(
      uploadedArtifacts.length,
      2,
      'Expected both worker delta artifacts to be available.',
    );

    // Aggregator downloads and merges both worker deltas into its local repository.
    const aggregatorPrepareStatus = await executePreparePhase(
      jobs.maven_aggregator,
      {
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': 'maven_worker_a,maven_worker_b',
        'cache-key-prefix': CACHE_KEY_PREFIX,
      },
      artifactApi,
    );
    const aggregatorOutputs = createPrepareActionOutputs(aggregatorPrepareStatus);
    assert.equal(aggregatorOutputs['downloaded-dependent-artifact-count'], '2');
    printOutputs('maven_aggregator', aggregatorOutputs);

    // Both profiles must resolve offline — proves the delta merge populated the local repo.
    await runMaven(
      jobs.maven_aggregator,
      ['-P', 'worker-a', 'dependency:resolve', '--offline'],
      'aggregator-mvn-worker-a-offline',
    );
    await runMaven(
      jobs.maven_aggregator,
      ['-P', 'worker-b', 'dependency:resolve', '--offline'],
      'aggregator-mvn-worker-b-offline',
    );

    const aggregatorFinalizeStatus = await executeFinalizePhase(
      jobs.maven_aggregator,
      {
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': 'maven_worker_a,maven_worker_b',
        'cache-key-prefix': CACHE_KEY_PREFIX,
      },
      artifactApi,
    );
    assert.equal(
      aggregatorFinalizeStatus.consumedDeltaCleanupResult?.deletedArtifactNames.length,
      2,
    );
    assert.equal(aggregatorFinalizeStatus.deltaArtifactResult?.status, 'not-distributed-worker');
    assert.equal(
      (await artifactApi.listArtifacts()).length,
      0,
      'Expected consumed worker artifacts to be deleted.',
    );

    if (keepStagedRoot) {
      console.log(
        `\nOK: Maven distributed reuse integration test passed. Staged root preserved at: ${stagedRoot}`,
      );
    } else {
      console.log(
        '\nOK: Maven distributed reuse integration test passed. Staged root cleaned up; set BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 to preserve it.',
      );
    }
  } catch (error) {
    keepStagedRoot = true;
    console.error(
      `\nFAIL: Maven distributed reuse integration test failed. Staged root preserved at: ${stagedRoot}`,
    );
    throw error;
  } finally {
    if (!keepStagedRoot) {
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }
}

async function stageJobs(
  stagedRoot: string,
  fixtureSourceDirectory: string,
): Promise<Record<(typeof FIXTURE_JOB_NAMES)[number], LocalMavenJobRuntime>> {
  const entries = await Promise.all(
    FIXTURE_JOB_NAMES.map(async (jobName) => [
      jobName,
      await stageJob(stagedRoot, fixtureSourceDirectory, jobName),
    ]),
  );
  return Object.fromEntries(entries) as Record<
    (typeof FIXTURE_JOB_NAMES)[number],
    LocalMavenJobRuntime
  >;
}

async function stageJob(
  stagedRoot: string,
  fixtureSourceDirectory: string,
  jobName: string,
): Promise<LocalMavenJobRuntime> {
  const jobRoot = path.join(stagedRoot, jobName);
  const projectDirectory = path.join(jobRoot, 'project');
  const mavenUserHome = path.join(jobRoot, 'm2');
  const localRepository = path.join(mavenUserHome, 'repository');
  await cp(fixtureSourceDirectory, projectDirectory, { recursive: true });
  await mkdir(localRepository, { recursive: true });

  return {
    jobName,
    jobRoot,
    projectDirectory,
    mavenUserHome,
    localRepository,
    state: new Map<string, string>(),
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'apache/buildish',
      GITHUB_WORKFLOW: INTEGRATION_WORKFLOW_NAME,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
      GITHUB_WORKSPACE: jobRoot,
      MAVEN_USER_HOME: mavenUserHome,
      RUNNER_OS: normalizeRunnerOs(process.platform),
      RUNNER_ARCH: normalizeRunnerArch(process.arch),
      BUILDISH_MAMMOTH_CACHE_GITHUB_JOB_NAME_OVERRIDE: jobName,
      BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE: 'main',
    },
  };
}

async function runWorkerJob(
  job: LocalMavenJobRuntime,
  profile: 'worker-a' | 'worker-b',
  artifactApi: WorkflowArtifactBackend,
): Promise<void> {
  const prepareStatus = await executePreparePhase(
    job,
    {
      'job-mode': 'distributed-worker',
      'cache-key-prefix': CACHE_KEY_PREFIX,
    },
    artifactApi,
  );
  printOutputs(job.jobName, createPrepareActionOutputs(prepareStatus));
  // Resolve the profile dependency online — populates the isolated local repository.
  await runMaven(job, ['-P', profile, 'dependency:resolve'], `${job.jobName}-mvn`);
  const finalizeStatus = await executeFinalizePhase(
    job,
    {
      'job-mode': 'distributed-worker',
      'cache-key-prefix': CACHE_KEY_PREFIX,
    },
    artifactApi,
  );
  assert.equal(finalizeStatus.deltaArtifactResult?.status, 'uploaded');
}

async function executePreparePhase(
  job: LocalMavenJobRuntime,
  inputs: Record<string, string>,
  artifactApi: WorkflowArtifactBackend,
) {
  return await executePrepareAction({
    env: job.env,
    artifactBackend: artifactApi,
    cacheBackend: UNAVAILABLE_CACHE_API,
    ...(await createActionDependencies(job, inputs, createSummaryWriter(job.jobName), 'prepare')),
  });
}

async function executeFinalizePhase(
  job: LocalMavenJobRuntime,
  inputs: Record<string, string>,
  artifactApi: WorkflowArtifactBackend,
) {
  return await executeFinalizeAction({
    env: job.env,
    artifactBackend: artifactApi,
    cacheBackend: UNAVAILABLE_CACHE_API,
    ...(await createActionDependencies(
      job,
      inputs,
      createSummaryWriter(`${job.jobName} finalize`),
      'finalize',
    )),
  });
}

function createInputProvider(values: Record<string, string>): { getInput(name: string): string } {
  return {
    getInput(name: string): string {
      return values[name] ?? '';
    },
  };
}

async function createActionDependencies(
  job: LocalMavenJobRuntime,
  inputs: Record<string, string>,
  summaryWriter: SummaryWriter,
  phase: 'prepare' | 'finalize',
) {
  const inputProvider = createInputProvider(inputs);
  const runtimeHost: CompositeHost = {
    getInput(name): string {
      return inputProvider.getInput(name);
    },
    getState(name): string {
      return job.state.get(name) ?? '';
    },
    saveState(name, value): void {
      job.state.set(name, value);
    },
    setOutput(): void {},
    info(message): void {
      console.log(`[${job.jobName}] ${message}`);
    },
    warning(message): void {
      console.warn(`[${job.jobName}] ${message}`);
    },
    setFailed(message): void {
      throw new Error(message);
    },
  };

  const ciProvider = createGitHubPlatform({
    env: job.env,
    eventPayload: { repository: { default_branch: 'main' } },
  });

  const directInputs = readMavenActionInputs(runtimeHost);
  const rawInputs = await resolveMavenActionInputsFromConfigFile(directInputs, {
    workspace: job.jobRoot,
  });
  const config: NormalizedMavenConfig = normalizeMavenActionConfig(rawInputs, {
    phase,
    ciContext: ciProvider.context,
    env: job.env,
  });

  return {
    runtimeHost,
    ciProvider,
    config,
    reportSink: createGitHubReportSink({ env: job.env, summaryWriter }),
    buildToolAdapterFactory: () => new MavenBuildToolAdapter(config),
  };
}

function createSummaryWriter(label: string): SummaryWriter {
  const lines: string[] = [];
  return {
    addRaw(text: string, addEol = false): SummaryWriter {
      lines.push(addEol ? `${text}${os.EOL}` : text);
      return this;
    },
    async write(): Promise<void> {
      if (lines.length === 0) return;
      console.log(`\n--- ${label} summary ---`);
      process.stdout.write(lines.join(''));
      lines.length = 0;
    },
  };
}

function printOutputs(label: string, outputs: Record<string, string>): void {
  console.log(`\n--- ${label} outputs ---`);
  for (const [name, value] of Object.entries(outputs)) {
    console.log(`${name}=${value}`);
  }
}

async function runMaven(
  job: LocalMavenJobRuntime,
  args: readonly string[],
  label: string,
): Promise<void> {
  console.log(`\n--- ${label} ---`);
  // Inject the isolated local repository path so Maven does not fall back to $HOME/.m2.
  const fullArgs = [...args, `-Dmaven.repo.local=${job.localRepository}`];
  const result = await runProcess('mvn', fullArgs, {
    cwd: job.projectDirectory,
    env: job.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Maven command '${label}' for job '${job.jobName}' failed with exit code ${result.exitCode}.`,
    );
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  const append = (chunk: Buffer | string, stream: NodeJS.WriteStream): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    output += text;
    stream.write(text);
  };

  child.stdout.on('data', (chunk) => append(chunk, process.stdout));
  child.stderr.on('data', (chunk) => append(chunk, process.stderr));

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Process '${command}' terminated by signal ${signal}.`));
        return;
      }
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

function normalizeRunnerOs(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'linux':
      return 'Linux';
    case 'darwin':
      return 'macOS';
    default:
      throw new Error(`Unsupported platform '${platform}' for this local integration test.`);
  }
}

function normalizeRunnerArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'X64';
    case 'arm64':
      return 'ARM64';
    default:
      throw new Error(`Unsupported architecture '${arch}' for this local integration test.`);
  }
}

class FakeArtifactApi implements WorkflowArtifactBackend {
  readonly capabilities = STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES;
  private nextId = 1;
  private readonly artifacts = new Map<
    number,
    { descriptor: WorkflowArtifactDescriptor; directory: string }
  >();

  constructor(private readonly storageRoot: string) {}

  async uploadArtifact(
    name: string,
    _files: readonly string[],
    rootDirectory: string,
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });
    const descriptor: WorkflowArtifactDescriptor = { id, name, size: 0, digest: null };
    this.artifacts.set(id, { descriptor, directory });
    return descriptor;
  }

  async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
    return [...this.artifacts.values()].map((a) => a.descriptor);
  }

  async getArtifact(name: string): Promise<WorkflowArtifactDescriptor> {
    const artifact = [...this.artifacts.values()].find((a) => a.descriptor.name === name);
    if (!artifact) throw new Error(`Artifact '${name}' not found.`);
    return artifact.descriptor;
  }

  async downloadArtifact(
    artifactId: number,
    options?: { readonly path?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact '${artifactId}' not found.`);
    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });
    return { downloadPath, digestMismatch: false };
  }

  async deleteArtifact(name: string): Promise<void> {
    const entry = [...this.artifacts.entries()].find(([, a]) => a.descriptor.name === name);
    if (!entry) throw new Error(`Artifact '${name}' not found.`);
    this.artifacts.delete(entry[0]);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
