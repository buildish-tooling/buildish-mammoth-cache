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

import { DEFAULT_GRADLE_DEPENDENCY_CACHE_LAYER, DEFAULT_MAX_DIRECTORY_ENTRIES } from './types';

/** Build-tool action variants covered by the public contract. */
export type ActionBuildTool = 'gradle' | 'maven';

/** Raw config-reader property names shared with the external action-input contract. */
export type RawActionInputProperty =
  | 'configFile'
  | 'baseDirectory'
  | 'cacheEnabled'
  | 'overlayFs'
  | 'dependencyCacheLayer'
  | 'exportLayerEnvironment'
  | 'readOnly'
  | 'jobMode'
  | 'dependentJobs'
  | 'workerArtifactRetentionDays'
  | 'allowDuplicateDependentDeltaPaths'
  | 'allowMissingDependentJobs'
  | 'cacheKeyPrefix'
  | 'cachePartitions'
  | 'cacheMaxDirectoryEntries'
  | 'cleanupEnabled'
  | 'restoreCleanupMode'
  | 'cacheGcMode'
  | 'cacheGcOlderThanDays'
  | 'dependencyGcIntervalDays'
  | 'dependencyGcForceGraceDays'
  | 'processAllWrapperFiles'
  | 'wrapperPropertiesGlob'
  | 'wrapperPropertiesFiles'
  | 'gradleUserHome'
  | 'setupJava'
  | 'mavenUserHome';

/** Supported representations for values read from a JSON or YAML config file. */
export type ConfigFileValueKind = 'string' | 'boolean' | 'number' | 'list' | 'structured';

interface PublicActionInputContractBase {
  readonly name: string;
  readonly tools: readonly ActionBuildTool[];
  /**
   * Default applied after config-file resolution, intentionally omitted from action metadata.
   *
   * GitHub passes metadata defaults to the action as if the workflow had set them, which would
   * make them indistinguishable from direct inputs and prevent config-file values from applying.
   */
  readonly runtimeDefault?: string;
  readonly description: string;
}

/** One canonical action input declaration used by metadata, readers, config files, and docs. */
export type PublicActionInputContract = PublicActionInputContractBase &
  (
    | {
        readonly property: RawActionInputProperty;
        readonly configFile: 'allowed';
        readonly configFileValueKind: ConfigFileValueKind;
      }
    | {
        readonly property: 'configFile';
        readonly configFile: 'nested-forbidden';
      }
    | {
        readonly property: null;
        readonly configFile: 'direct-only';
      }
  );

/** Canonical input declarations that may be named by repository config files. */
export type ConfigFileActionInputContract = Extract<
  PublicActionInputContract,
  { readonly configFile: 'allowed' | 'nested-forbidden' }
>;

/** One canonical prepare output declaration shared by both action variants. */
export interface PublicActionOutputContract {
  readonly tools?: readonly ActionBuildTool[];
  readonly name: string;
  readonly description: string;
}

const BOTH = ['gradle', 'maven'] as const;
const GRADLE = ['gradle'] as const;
const MAVEN = ['maven'] as const;

export const PUBLIC_ACTION_INPUTS = [
  {
    name: 'config-file',
    property: 'configFile',
    tools: BOTH,
    configFile: 'nested-forbidden',
    description:
      'Optional workspace-relative JSON or YAML configuration file. Direct action inputs override file values; secrets and GitHub context inputs are direct-only.',
  },
  {
    name: 'base-directory',
    property: 'baseDirectory',
    tools: BOTH,
    runtimeDefault: '.',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description:
      'Repository-relative project base directory. Rooted paths and paths that escape the workspace are rejected.',
  },
  {
    name: 'cache-enabled',
    property: 'cacheEnabled',
    tools: BOTH,
    runtimeDefault: 'true',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description: 'Enables cache orchestration. Accepted values: true or false.',
  },
  {
    name: 'overlay-fs',
    property: 'overlayFs',
    tools: BOTH,
    runtimeDefault: 'true',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Allows OverlayFS for eligible cache operations. Set to false to use the ordinary cache path.',
  },
  {
    name: 'dependency-cache-layer',
    property: 'dependencyCacheLayer',
    tools: GRADLE,
    runtimeDefault: DEFAULT_GRADLE_DEPENDENCY_CACHE_LAYER,
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Enables eligible Gradle wrapper workers to use a dependency seed and selects a family whose publishers retain eligible partitions. All cooperating jobs use the same value.',
  },
  {
    name: 'export-layer-environment',
    property: 'exportLayerEnvironment',
    tools: GRADLE,
    runtimeDefault: 'true',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Exports the activated Gradle dependency seed as GRADLE_RO_DEP_CACHE for later steps. False emits only the seed-path output; the workflow configures every consumer.',
  },
  {
    name: 'read-only',
    property: 'readOnly',
    tools: BOTH,
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Disables cache and delta writes. Pull-request events default to true; repository config may make the policy stricter, but only a direct workflow input may lower that floor.',
  },
  {
    name: 'job-mode',
    property: 'jobMode',
    tools: BOTH,
    runtimeDefault: 'standalone',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description:
      'Cache coordination mode: standalone, distributed-worker, distributed-aggregator, or prepare-only.',
  },
  {
    name: 'dependent-jobs',
    property: 'dependentJobs',
    tools: BOTH,
    configFile: 'allowed',
    configFileValueKind: 'list',
    description:
      'Comma- or newline-separated worker job names consumed by a distributed aggregator.',
  },
  {
    name: 'worker-artifact-retention-days',
    property: 'workerArtifactRetentionDays',
    tools: BOTH,
    runtimeDefault: '7',
    configFile: 'allowed',
    configFileValueKind: 'number',
    description:
      'Requested worker artifact retention in whole days (1–400). Backend limits may shorten it; shorter retention narrows the retry window.',
  },
  {
    name: 'allow-duplicate-dependent-delta-paths',
    property: 'allowDuplicateDependentDeltaPaths',
    tools: BOTH,
    runtimeDefault: 'false',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Allows a distributed aggregator to resolve non-identical overlapping worker paths by newest modification time. Exact same-content overlaps remain safe without this option.',
  },
  {
    name: 'allow-missing-dependent-jobs',
    property: 'allowMissingDependentJobs',
    tools: BOTH,
    runtimeDefault: 'true',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Lets a distributed aggregator merge the available workers when a dependent job uploaded no artifact, for example because it was skipped. A missing job prevents full sweep coverage. Set to false to fail aggregation instead.',
  },
  {
    name: 'cache-key-prefix',
    property: 'cacheKeyPrefix',
    tools: BOTH,
    runtimeDefault: 'buildish-mammoth-cache-',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description:
      'Namespace prefix for action-owned cache families; build, partition, ref-lineage, and generation identity are appended automatically.',
  },
  {
    name: 'cache-partitions',
    property: 'cachePartitions',
    tools: BOTH,
    configFile: 'allowed',
    configFileValueKind: 'structured',
    description:
      'JSON array of cache partition overrides and custom partitions. Hard safety exclusions remain non-overridable.',
  },
  {
    name: 'cache-max-directory-entries',
    property: 'cacheMaxDirectoryEntries',
    tools: BOTH,
    runtimeDefault: String(DEFAULT_MAX_DIRECTORY_ENTRIES),
    configFile: 'allowed',
    configFileValueKind: 'number',
    description: 'Maximum direct entries per managed directory. Must be a positive safe integer.',
  },
  {
    name: 'cleanup-enabled',
    property: 'cleanupEnabled',
    tools: BOTH,
    runtimeDefault: 'true',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description: 'Enables restore cleanup and timestamp garbage collection.',
  },
  {
    name: 'restore-cleanup-mode',
    property: 'restoreCleanupMode',
    tools: BOTH,
    runtimeDefault: 'none',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description: 'Restore-time cleanup mode: none or prune-managed.',
  },
  {
    name: 'cache-gc-mode',
    property: 'cacheGcMode',
    tools: BOTH,
    runtimeDefault: 'timestamp',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description:
      'Managed-cache GC: timestamp uses file age and current-build activity; off disables deletion only.',
  },
  {
    name: 'cache-gc-older-than-days',
    property: 'cacheGcOlderThanDays',
    tools: BOTH,
    runtimeDefault: '14',
    configFile: 'allowed',
    configFileValueKind: 'number',
    description:
      'File-mtime age threshold for timestamp GC, not historical inactivity. Must be at least 2 days.',
  },
  {
    name: 'dependency-gc-interval-days',
    property: 'dependencyGcIntervalDays',
    tools: BOTH,
    runtimeDefault: '3',
    configFile: 'allowed',
    configFileValueKind: 'number',
    description: 'Days between completed periodic GC sweeps.',
  },
  {
    name: 'dependency-gc-force-grace-days',
    property: 'dependencyGcForceGraceDays',
    tools: BOTH,
    runtimeDefault: '1',
    configFile: 'allowed',
    configFileValueKind: 'number',
    description:
      'Additional days before an aggregator can sweep with incomplete worker coverage. Use off to disable forcing.',
  },
  {
    name: 'github-token',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description:
      'Optional GitHub token for authenticated API requests. Pass secrets directly, never through repository config.',
  },
  {
    name: 'github-job-check-run-id',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description: 'Optional check-run ID used to create a direct current-job link.',
  },
  {
    name: 'github-event-name',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description:
      'Optional triggering-event override for reusable workflows. Pass the trusted caller event.',
  },
  {
    name: 'github-job-name',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description: 'Optional stable job-name override used for distributed artifact coordination.',
  },
  {
    name: 'github-ref-name',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description: 'Optional resolved-ref override for reusable workflows.',
  },
  {
    name: 'github-default-branch',
    property: null,
    tools: BOTH,
    configFile: 'direct-only',
    description: 'Optional repository default-branch override for reusable workflows.',
  },
  {
    name: 'process-all-wrapper-files',
    property: 'processAllWrapperFiles',
    tools: GRADLE,
    runtimeDefault: 'false',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Processes every matching Gradle wrapper properties file. Cannot be combined with wrapper-properties-files.',
  },
  {
    name: 'wrapper-properties-glob',
    property: 'wrapperPropertiesGlob',
    tools: GRADLE,
    runtimeDefault: '**/gradle/wrapper/gradle-wrapper.properties',
    configFile: 'allowed',
    configFileValueKind: 'string',
    description: 'Repository-relative Gradle wrapper properties discovery glob.',
  },
  {
    name: 'wrapper-properties-files',
    property: 'wrapperPropertiesFiles',
    tools: GRADLE,
    configFile: 'allowed',
    configFileValueKind: 'list',
    description:
      'Comma- or newline-separated explicit Gradle wrapper properties files relative to base-directory.',
  },
  {
    name: 'gradle-user-home',
    property: 'gradleUserHome',
    tools: GRADLE,
    configFile: 'allowed',
    configFileValueKind: 'string',
    description: 'Gradle user home to manage. The current version accepts only the runner default.',
  },
  {
    name: 'setup-java',
    property: 'setupJava',
    tools: GRADLE,
    runtimeDefault: 'false',
    configFile: 'allowed',
    configFileValueKind: 'boolean',
    description:
      'Reserved compatibility flag. The current version rejects true; run actions/setup-java first.',
  },
  {
    name: 'maven-user-home',
    property: 'mavenUserHome',
    tools: MAVEN,
    configFile: 'allowed',
    configFileValueKind: 'string',
    description:
      'Absolute or working-directory-relative Maven user home to manage, including repository/ and wrapper/dists/; defaults to MAVEN_USER_HOME or ~/.m2.',
  },
] as const satisfies readonly PublicActionInputContract[];

export const PUBLIC_ACTION_OUTPUTS = [
  {
    name: 'gradle-ro-dep-cache',
    tools: GRADLE,
    description:
      'Invocation-owned Gradle read-only dependency cache path, or empty when layered restore is inactive.',
  },
  {
    name: 'cache-family-key',
    description: 'Stable compatibility family shared by structurally compatible generations.',
  },
  {
    name: 'cache-lineage-prefix',
    description: 'Current-ref prefix used to restore the newest immutable generation.',
  },
  {
    name: 'base-cache-restore-status',
    description: 'Classified base-cache restore outcome for prepare.',
  },
  {
    name: 'dependency-gc-due',
    description:
      'Whether periodic GC is due for the selected generation. Values are true, false, or unknown.',
  },
  {
    name: 'restored-cache-key',
    description: 'Exact immutable generation restored during prepare, when any.',
  },
  {
    name: 'read-only',
    description: 'Whether cache and delta writes are disabled.',
  },
  {
    name: 'job-mode',
    description: 'Effective standalone or distributed job mode.',
  },
  {
    name: 'dependent-delta-status',
    description: 'Dependent-delta outcome: not-configured, applied, or skipped-read-only.',
  },
  {
    name: 'dependent-delta-artifact-count',
    description: 'Number of dependent worker artifacts applied during prepare.',
  },
] as const satisfies readonly PublicActionOutputContract[];

/** Exact public prepare-output name union derived from the canonical contract. */
export type PublicActionOutputName = (typeof PUBLIC_ACTION_OUTPUTS)[number]['name'];

/**
 * Returns the input description published in action metadata.
 *
 * Action metadata cannot declare defaults without masking config-file values, so the runtime default
 * is stated in the description instead.
 */
export function getActionMetadataDescription(input: PublicActionInputContract): string {
  return input.runtimeDefault === undefined
    ? input.description
    : `${input.description} Defaults to \`${input.runtimeDefault}\`.`;
}

/** Returns the complete ordered input contract for one action variant. */
export function getPublicActionInputs(
  buildTool: ActionBuildTool,
): readonly PublicActionInputContract[] {
  const inputs: readonly PublicActionInputContract[] = PUBLIC_ACTION_INPUTS;
  return inputs.filter((input) => input.tools.includes(buildTool));
}

/** Resolves one raw input property to its canonical external input name. */
export function getPublicActionInputName(
  buildTool: ActionBuildTool,
  property: RawActionInputProperty,
): string {
  const input = getPublicActionInputs(buildTool).find(
    (candidate) => candidate.property === property,
  );
  if (!input) {
    throw new Error(`No ${buildTool} action input contract exists for raw property '${property}'.`);
  }
  return input.name;
}

/** Resolves one canonical external input declaration by name. */
export function getPublicActionInput(
  buildTool: ActionBuildTool,
  name: string,
): PublicActionInputContract {
  const input = getPublicActionInputs(buildTool).find((candidate) => candidate.name === name);
  if (!input) {
    throw new Error(`No ${buildTool} action input contract exists for '${name}'.`);
  }
  return input;
}

/** Resolves and validates an external config-file key against the canonical contract. */
export function getConfigFileInput(
  buildTool: ActionBuildTool,
  name: string,
): ConfigFileActionInputContract {
  const input = getPublicActionInputs(buildTool).find((candidate) => candidate.name === name);
  if (!input || input.configFile === 'direct-only') {
    if (name === 'github-token') {
      throw new Error(
        `config-file must not contain github-token. Pass it directly as a ${buildTool} action input or environment secret instead.`,
      );
    }
    throw new Error(`config-file contains unsupported key '${name}' for the ${buildTool} action.`);
  }
  return input;
}

/** Renders the contract-backed reference tables embedded in user documentation. */
export function renderPublicActionContractReference(): string {
  const inputs: readonly PublicActionInputContract[] = PUBLIC_ACTION_INPUTS;
  const inputRows = inputs.map((input) => {
    const variants = input.tools.map(capitalize).join(', ');
    const defaultValue = input.runtimeDefault ?? 'event-dependent or unset';
    const configFile = input.configFile === 'allowed' ? 'yes' : 'no';
    return `| \`${input.name}\` | ${variants} | \`${defaultValue}\` | ${configFile} | ${input.description} |`;
  });
  const outputRows = PUBLIC_ACTION_OUTPUTS.map(
    (output) => `| \`${output.name}\` | ${output.description} |`,
  );

  return [
    '<!-- BEGIN GENERATED PUBLIC ACTION CONTRACT -->',
    '',
    '### Canonical input matrix',
    '',
    '| Input | Action | Default | Config file | Meaning |',
    '| --- | --- | --- | --- | --- |',
    ...inputRows,
    '',
    '### Canonical output matrix',
    '',
    '| Output | Meaning |',
    '| --- | --- |',
    ...outputRows,
    '',
    '<!-- END GENERATED PUBLIC ACTION CONTRACT -->',
  ].join('\n');
}

function capitalize(value: ActionBuildTool): string {
  return value === 'gradle' ? 'Gradle' : 'Maven';
}

/** Outputs exposed by one build-tool Action. */
export function getPublicActionOutputs(
  buildTool: ActionBuildTool,
): readonly PublicActionOutputContract[] {
  const outputs: readonly PublicActionOutputContract[] = PUBLIC_ACTION_OUTPUTS;
  return outputs.filter((output) => !output.tools || output.tools.includes(buildTool));
}
