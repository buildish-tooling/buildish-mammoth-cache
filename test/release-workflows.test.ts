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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string[] | string;
  if?: string;
  permissions?: Record<string, string>;
  environment?: string;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { inputs: Record<string, { required: boolean }> }>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}
const load = (name: string): Workflow =>
  parse(readFileSync(`.github/workflows/release-${name}.yml`, 'utf8')) as Workflow;
const candidate = load('candidate');
const promotion = load('promote');
const script = (job: Job): string => job.steps.map((step) => step.run ?? '').join('\n');

// These are credential/state boundary invariants, not a snapshot of workflow formatting.
describe('release workflow policy', () => {
  it('uses explicit dispatch with shared non-cancelling serialization and no legacy entry points', () => {
    for (const workflow of [candidate, promotion]) {
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
      expect(workflow.permissions).toEqual({ contents: 'read' });
      expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    }
    expect(candidate.concurrency.group).toBe(promotion.concurrency.group);
    expect(candidate.concurrency.group).toContain('inputs.version');
    for (const field of [
      'version',
      'candidate_tag',
      'candidate_manifest_digest',
      'approval_reference',
    ]) {
      expect(promotion.on.workflow_dispatch.inputs[field].required).toBe(true);
    }
    for (const file of [
      '10-create-release-branch',
      '20-prepare-rc',
      '30-release-version',
      '40-verify-rc',
    ]) {
      expect(existsSync(`.github/workflows/releasey-${file}.yml`)).toBe(false);
    }
  });

  it('pins every external action and keeps checkouts credential-free and trusted', () => {
    for (const workflow of [candidate, promotion]) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses && !step.uses.startsWith('$/')) {
            expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
          }
          if (step.uses?.startsWith('actions/upload-artifact@')) {
            expect(step.with?.overwrite).toBe(true); // Same-run transport can converge on a rerun.
            expect(step.with?.['if-no-files-found']).toBe('error');
          }
          if (step.uses?.startsWith('actions/checkout@')) {
            expect(step.with?.['persist-credentials']).toBe(false);
            if (step.with?.path === 'source') {
              expect(id).toBe('build');
              expect(step.with.ref).toBe('${{ needs.resolve.outputs.source_commit }}');
            } else {
              expect(step.with?.ref).toBe('${{ github.workflow_sha }}');
            }
          }
          expect(step.run ?? '').not.toContain('${{ inputs.');
        }
      }
    }
  });

  it('never builds or executes selected payloads in write or signing jobs', () => {
    for (const workflow of [candidate, promotion]) {
      for (const job of Object.values(workflow.jobs)) {
        const privileged =
          job.permissions?.contents === 'write' ||
          job.steps.some((step) => JSON.stringify(step.env ?? {}).includes('secrets.'));
        if (privileged) {
          expect(job.environment).toBe('release-candidate');
          expect(script(job)).not.toMatch(
            /npm (?:ci|install)|make .*check|node scripts\/smoke|worktree add/,
          );
          expect(job.steps.some((step) => step.with?.path === 'source')).toBe(false);
        }
      }
    }
    for (const job of [candidate.jobs.build, promotion.jobs['consume-final']]) {
      expect(job.permissions?.contents ?? 'read').toBe('read');
      expect(job.environment).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain('secrets.');
      expect(JSON.stringify(job)).not.toContain('github.token');
      expect(script(job)).toContain('node scripts/smoke-test.mjs');
    }
  });

  it('requires trusted source CI and independently bound state and asset handoffs', () => {
    expect(script(candidate.jobs.resolve)).toContain('verify-source-ref-checks');
    for (const job of [candidate.jobs.sign, candidate.jobs.publish]) {
      const text = script(job);
      expect(text).toContain('workflow.py digest');
      expect(text).toContain('workflow.py verify');
      expect(text).toContain('--source-state');
      expect(text).toContain('--bundle-sha256 "$EXPECTED_GIT_BUNDLE_DIGEST"');
    }
    expect(script(candidate.jobs.sign)).toContain('prepare-release-assets');
    expect(JSON.stringify(candidate)).not.toContain('BUILDISH_RELEASE_GPG_SIGNING_FINGERPRINT');
    expect(script(candidate.jobs.sign)).not.toContain('--expected-signing-fingerprint');
    expect(JSON.stringify(promotion)).not.toContain('BUILDISH_RELEASE_APPROVERS');
    const config = parse(readFileSync('buildish-release-tooling/release-config.yaml', 'utf8')) as {
      artifacts: { signing: { expected_fingerprint: string } };
    };
    expect(config.artifacts.signing.expected_fingerprint).toMatch(/^[A-F0-9]{40}$/);
    expect(script(promotion.jobs.stage)).not.toContain('--source-state');
    expect(script(promotion.jobs.stage)).toContain('--promotion-state');
    expect(script(promotion.jobs.stage)).not.toContain('prepare-release-assets');
  });

  it('requires consumer success, verifies all producers, seals and publishes last', () => {
    const publish = promotion.jobs.publish;
    for (const dependency of ['resolve', 'stage', 'consume-final']) {
      expect(publish.needs).toContain(dependency);
      expect(publish.if).toContain(`needs.${dependency}.result == 'success'`);
    }
    const text = script(publish);
    for (const name of ['INPUT', 'STAGE', 'CONSUMER']) {
      expect(text).toContain(`"$EXPECTED_${name}_DIGEST"`);
    }
    expect(text.indexOf('workflow.py evidence')).toBeLessThan(
      text.indexOf('create-release-manifest'),
    );
    expect(text.indexOf('attach-github-release-manifest')).toBeLessThan(
      text.indexOf('publish-github-final-release'),
    );
    expect(text).toContain('--require-manifest-digest "$sealed_digest"');
    expect(text.indexOf('publish-github-final-release')).toBeLessThan(
      text.lastIndexOf('verify-github-final-release'),
    );
    expect(text).not.toContain('upload-release');
  });

  it('requires explicit wheel digest validation before installation', () => {
    const action = parse(
      readFileSync('.github/actions/setup-release-tooling/action.yml', 'utf8'),
    ) as { runs: { steps: Step[] } };
    const text = action.runs.steps.map((step) => step.run).join('\n');
    expect(text.indexOf('sha256sum --check')).toBeLessThan(
      text.indexOf('-m pip --isolated install'),
    );
    expect(text).toContain('--no-deps --only-binary=:all:');
    expect(text).toContain('--package-info');
    expect(text).not.toContain('GITHUB_ENV');
  });

  it('all authored workflow shell blocks parse under bash', () => {
    for (const workflow of [candidate, promotion]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.run)
            expect(() => execFileSync('bash', ['-n'], { input: step.run })).not.toThrow();
        }
      }
    }
  });
});
