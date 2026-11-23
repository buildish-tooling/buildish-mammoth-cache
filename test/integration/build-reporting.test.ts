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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { test } from 'vitest';
import { gradleExecutable } from '../support/gradle-executable';

import { loadGradleBuildReport } from '../../src/build-tool/gradle/build-results';
import { streamingIntegrationJob } from '../support/streaming-integration';

const RUN_ID = '92002';
const RUN_ATTEMPT = '1';
const WORKFLOW_NAME = 'Local Build Reporting Integration Test';
const SUMMARY_FILE_NAME = 'build-reporting-summary.md';

interface GradleInvocation {
  readonly args: readonly string[];
  readonly expectedExitCode?: number;
  readonly label: string;
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'The local build-reporting integration test currently requires a POSIX shell because the fixture only ships gradlew.',
    );
  }

  const repoRoot = process.cwd();
  const fixtureSourceDirectory = path.join(
    repoRoot,
    'test',
    'fixtures',
    'integration',
    'gradle-project',
  );
  const buildRoot = path.join(repoRoot, 'build');
  await mkdir(buildRoot, { recursive: true });

  const stagedRoot = await mkdtemp(path.join(buildRoot, 'integration-build-reporting-'));
  let keepStagedRoot = process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT === '1';
  const summaryPath = path.join(stagedRoot, SUMMARY_FILE_NAME);

  try {
    const runtime = await stageProject(stagedRoot, fixtureSourceDirectory);
    const job = await streamingIntegrationJob({
      root: stagedRoot,
      home: runtime.gradleUserHome,
      tool: 'gradle',
      installedGradle: process.env.BUILDISH_TEST_GRADLE_EXECUTABLE,
      name: 'build-reporting',
      inputs: { 'cache-enabled': 'false', 'read-only': 'true' },
    });
    const gradleInvocations: readonly GradleInvocation[] = [
      { args: ['help', 'publishFakeBuildScan'], label: 'Help and publish fake Build Scan' },
      { args: ['publishFakeBuildScanFailure'], label: 'Fail fake Build Scan publication' },
    ];

    assert.deepEqual(await job.prepare(), { outcome: 'disabled' });

    for (const invocation of gradleInvocations) {
      await runGradle(runtime, invocation.args, invocation.label, invocation.expectedExitCode ?? 0);
    }

    const testArgs = [
      ':tests:test',
      '--configuration-cache',
      '--configuration-cache-problems=fail',
      '-Dorg.gradle.isolated-projects=true',
    ];
    const firstTestOutput = await runGradle(runtime, testArgs, 'Store isolated test configuration');
    assert.match(firstTestOutput, /Configuration cache entry stored/u);
    const secondTestOutput = await runGradle(
      runtime,
      testArgs,
      'Reuse isolated test configuration',
    );
    assert.match(secondTestOutput, /Reusing configuration cache/u);
    // Both executions must actually run the Test task, rather than skip it as up-to-date.
    for (const output of [firstTestOutput, secondTestOutput]) {
      assert.match(output, /expected TestKit failures were asserted/u);
    }
    const successfulReport = await loadGradleBuildReport({
      tempDirectory: runtime.env.RUNNER_TEMP!,
    });
    assert.deepEqual(successfulReport.warnings, []);
    assert.ok(successfulReport.builds.some((build) => build.requestedTasks === ':tests:test'));
    assert.ok(
      successfulReport.builds.every((build) => build.rootProjectName === 'mammoth-cache-gradle-it'),
    );
    assert.ok(successfulReport.builds.every((build) => !build.buildFailed));

    await runGradle(
      runtime,
      [...testArgs, '-PbreakFixtureAssertion=true'],
      'Report an unexpected test failure',
      1,
    );
    await runGradle(runtime, ['failingVerification'], 'Fail verification task', 1);

    const report = await loadGradleBuildReport({ tempDirectory: job.env.RUNNER_TEMP });
    assert.equal((await job.post()).outcome, 'disabled');
    await writeFile(summaryPath, job.summaries.join('\n') + '\n', 'utf8');

    assert.equal(report.builds.length, successfulReport.builds.length + 2);
    assert.equal(
      report.builds.filter((build) => !build.buildFailed).length,
      successfulReport.builds.length,
    );
    assert.equal(report.builds.filter((build) => build.buildFailed).length, 2);
    assert.ok(
      report.builds.some((build) => build.buildFailed && build.requestedTasks === ':tests:test'),
    );
    assert.ok(
      report.builds.some(
        (build) => build.buildScanUri === 'https://scans.gradle.com/s/fake-published-scan',
      ),
    );
    assert.ok(report.builds.some((build) => build.buildScanFailed));
    assert.ok(report.builds.some((build) => build.requestedTasks === 'failingVerification'));
    assert.ok(report.builds.some((build) => build.requestedTasks === 'help publishFakeBuildScan'));

    const summaryText = await readFile(summaryPath, 'utf8');
    assert.match(summaryText, /## Mammoth cache post/u);
    assert.match(summaryText, /- Build outcomes: \d+ succeeded, 2 failed/u);
    // createGradleBuildSummaryLines renders a markdown list, not an HTML table.
    assert.match(summaryText, /### Performed Gradle builds/u);
    // escapeSummaryText escapes hyphens as \- in Markdown, so project names appear with
    // literal backslashes in the summary file (GitHub's renderer strips them on display).
    assert.match(summaryText, /mammoth\\-cache\\-gradle\\-it — help publishFakeBuildScan/u);
    // The build-scan link text is "published" (not an emoji icon).
    assert.match(
      summaryText,
      /<a href="https:\/\/scans\.gradle\.com\/s\/fake-published-scan">published<\/a>/u,
    );
    // Failed builds are represented as a markdown list item, not an HTML table cell.
    assert.match(summaryText, /- Outcome: failed/u);
    assert.match(summaryText, /mammoth\\-cache\\-gradle\\-it — failingVerification/u);

    const initScriptPath = path.join(
      runtime.gradleUserHome,
      'init.d',
      'buildish-mammoth-cache.build-result-capture.init.gradle',
    );
    await assert.rejects(readFile(initScriptPath, 'utf8'));

    if (keepStagedRoot) {
      console.log(
        `\nOK: build-reporting integration test passed. Staged root preserved at: ${stagedRoot}\nSummary report: ${summaryPath}`,
      );
    } else {
      console.log(
        '\nOK: build-reporting integration test passed. Staged root cleaned up; set BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 to preserve it.',
      );
    }
  } catch (error) {
    keepStagedRoot = true;
    console.error(
      `\nFAIL: build-reporting integration test failed. Staged root preserved at: ${stagedRoot}\nSummary report: ${summaryPath}`,
    );
    throw error;
  } finally {
    if (!keepStagedRoot) {
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }
}

interface LocalRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly gradleUserHome: string;
  readonly projectDirectory: string;
}

async function stageProject(
  stagedRoot: string,
  fixtureSourceDirectory: string,
): Promise<LocalRuntime> {
  const projectDirectory = path.join(stagedRoot, 'project');
  const gradleUserHome = path.join(stagedRoot, 'gradle-home');
  await cp(fixtureSourceDirectory, projectDirectory, { recursive: true });
  await chmod(path.join(projectDirectory, 'gradlew'), 0o755);
  await writeFixtureProject(projectDirectory);

  return {
    projectDirectory,
    gradleUserHome,
    env: {
      ...process.env,
      GITHUB_ACTION: '__run',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'buildish-tooling/buildish',
      GITHUB_WORKFLOW: WORKFLOW_NAME,
      GITHUB_JOB: 'build-reporting',
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
      GITHUB_WORKSPACE: stagedRoot,
      GRADLE_USER_HOME: gradleUserHome,
      HOME: stagedRoot,
      RUNNER_OS: normalizeRunnerOs(process.platform),
      RUNNER_ARCH: normalizeRunnerArch(process.arch),
      RUNNER_TEMP: path.join(stagedRoot, 'temp'),
    },
  };
}

async function writeFixtureProject(projectDirectory: string): Promise<void> {
  await writeFile(
    path.join(projectDirectory, 'settings.gradle'),
    `rootProject.name = 'mammoth-cache-gradle-it'\ninclude 'tests'\n`,
    'utf8',
  );
  await writeFile(
    path.join(projectDirectory, 'build.gradle'),
    `plugins {\n  id 'com.gradle.build-scan'\n}\n`,
    'utf8',
  );

  const buildSrcDirectory = path.join(projectDirectory, 'buildSrc');
  await mkdir(path.join(buildSrcDirectory, 'src', 'main', 'groovy', 'fixture'), {
    recursive: true,
  });
  await mkdir(
    path.join(buildSrcDirectory, 'src', 'main', 'resources', 'META-INF', 'gradle-plugins'),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(buildSrcDirectory, 'build.gradle'),
    `plugins {\n  id 'groovy-gradle-plugin'\n}\n`,
    'utf8',
  );
  await writeFile(
    path.join(
      buildSrcDirectory,
      'src',
      'main',
      'resources',
      'META-INF',
      'gradle-plugins',
      'com.gradle.build-scan.properties',
    ),
    `implementation-class=fixture.FakeBuildScanPlugin\n`,
    'utf8',
  );
  await writeFile(
    path.join(buildSrcDirectory, 'src', 'main', 'groovy', 'fixture', 'FakeBuildScanPlugin.groovy'),
    `package fixture\n\nimport org.gradle.api.GradleException\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\n\nclass FakeBuildScanPlugin implements Plugin<Project> {\n    @Override\n    void apply(Project project) {\n        def extension = project.extensions.create('buildScan', FakeBuildScanExtension)\n        project.tasks.register('publishFakeBuildScan') {\n            doLast {\n                extension.publish('https://scans.gradle.com/s/fake-published-scan')\n            }\n        }\n        project.tasks.register('publishFakeBuildScanFailure') {\n            doLast {\n                extension.fail(new RuntimeException('simulated Build Scan publication failure'))\n            }\n        }\n        project.tasks.register('failingVerification') {\n            doLast {\n                throw new GradleException('simulated task failure')\n            }\n        }\n    }\n}\n\nclass FakeBuildScanExtension {\n    private Closure<?> publishedCallback\n    private Closure<?> errorCallback\n\n    void buildScanPublished(Closure<?> callback) {\n        publishedCallback = callback\n    }\n\n    void onError(Closure<?> callback) {\n        errorCallback = callback\n    }\n\n    void publish(String uri) {\n        publishedCallback?.call(new FakePublishedBuildScan(uri))\n    }\n\n    void fail(Throwable error) {\n        errorCallback?.call(error)\n    }\n}\n\nclass FakePublishedBuildScan {\n    final URI buildScanUri\n\n    FakePublishedBuildScan(String uri) {\n        this.buildScanUri = new URI(uri)\n    }\n}\n`,
    'utf8',
  );
  await writeTestKitFixture(projectDirectory);
}

async function writeTestKitFixture(projectDirectory: string): Promise<void> {
  const testProjectDirectory = path.join(projectDirectory, 'tests');
  const sources = path.join(testProjectDirectory, 'src', 'test', 'java');
  await mkdir(sources, { recursive: true });
  await writeFile(
    path.join(testProjectDirectory, 'build.gradle'),
    `plugins { id 'java' }
repositories { mavenCentral() }
dependencies {
    testImplementation gradleTestKit()
    testImplementation 'junit:junit:4.13.2'
}
tasks.named('test', Test) {
    systemProperty 'fixture.gradle.home', gradle.gradleHomeDir.absolutePath
    systemProperty 'fixture.gradle.user.home', gradle.gradleUserHomeDir.absolutePath
    systemProperty 'fixture.directory', layout.buildDirectory.dir('fixtures').get().asFile.absolutePath
    systemProperty 'fixture.breakAssertion', providers.gradleProperty('breakFixtureAssertion').getOrElse('false')
    outputs.upToDateWhen { false }
    testLogging.showStandardStreams = true
}
`,
    'utf8',
  );
  await writeFile(
    path.join(sources, 'BuildReportingTest.java'),
    `import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import org.gradle.testkit.runner.GradleRunner;
import org.junit.Test;
import static org.junit.Assert.*;

public class BuildReportingTest {
  @Test
  public void expectedFailuresDoNotBecomeJobFailures() throws Exception {
    assertFalse("unexpected test failure", Boolean.getBoolean("fixture.breakAssertion"));
    assertEquals("true", System.getenv("BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE"));
    Path fixtures = new File(System.getProperty("fixture.directory")).toPath();
    Files.createDirectories(fixtures);
    Path fixture = Files.createTempDirectory(fixtures, "negative-");
    Files.writeString(fixture.resolve("settings.gradle"), "rootProject.name = 'negative-test-fixture'\\n");
    Files.writeString(fixture.resolve("build.gradle"),
      "tasks.register('expectedFailure') { doLast { throw new GradleException('expected fixture failure') } }\\n");
    GradleRunner runner = GradleRunner.create()
      .withProjectDir(fixture.toFile())
      .withGradleInstallation(new File(System.getProperty("fixture.gradle.home")))
      .withTestKitDir(fixtures.resolve("test-kit").toFile())
      .withArguments("expectedFailure", "--gradle-user-home", System.getProperty("fixture.gradle.user.home"),
      "--configuration-cache", "--configuration-cache-problems=fail", "-Dorg.gradle.isolated-projects=true");
    assertTrue(runner.buildAndFail().getOutput().contains("expected fixture failure"));
    String reused = runner.buildAndFail().getOutput();
    assertTrue(reused.contains("expected fixture failure"));
    assertTrue(reused.contains("Reusing configuration cache"));
    System.out.println("expected TestKit failures were asserted");
  }
}
`,
    'utf8',
  );
}

async function runGradle(
  runtime: LocalRuntime,
  args: readonly string[],
  label: string,
  expectedExitCode = 0,
): Promise<string> {
  console.log(`\n--- ${label} ---`);
  const executable = gradleExecutable();
  console.log(`Gradle executable: ${executable}`);
  const result = await runProcess(executable, ['--no-daemon', ...args], {
    cwd: runtime.projectDirectory,
    env: runtime.env,
  });
  assert.equal(
    result.exitCode,
    expectedExitCode,
    `Gradle command '${label}' exited with ${result.exitCode}. Output:\n${result.output}`,
  );
  return result.output;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
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
    child.on('close', (code) => resolve({ exitCode: code, output }));
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

/**
 * Vitest entry point for the build-reporting integration test.
 *
 * Runs the full Gradle build-reporting flow end-to-end, including prepare, four Gradle
 * invocations, and finalize. Requires Java 21+ on PATH (Gradle is downloaded automatically via
 * the wrapper). The test timeout is set to 10 minutes to accommodate Gradle's initial download
 * and compilation of the buildSrc fixture.
 *
 * Set BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 to preserve the staged workspace on disk after
 * the test (useful for debugging). The staged root path is printed at the end of the test.
 */
test('build reporting integration', main, 600_000);
