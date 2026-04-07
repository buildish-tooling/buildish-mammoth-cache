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

import { writeFile } from 'node:fs/promises';

import * as core from '@actions/core';

import type { ReportSink } from '../../host/types';
import { isAbsolutePosixOrWindowsPath } from '../../util/paths';

/**
 * Minimal interface for job summary writers.
 */
export interface SummaryWriter {
  /** Appends raw text to the job summary buffer. */
  addRaw(text: string, addEol?: boolean): SummaryWriter;
  /** Flushes the accumulated summary content to the provider. */
  write(): Promise<unknown>;
}

/** Injectable options for {@link createGitHubReportSink}. */
export interface GitHubReportSinkOptions {
  /** Environment variable map used to locate `GITHUB_STEP_SUMMARY`; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Summary writer implementation; defaults to `@actions/core` summary. */
  readonly summaryWriter?: SummaryWriter;
}

/**
 * Creates a {@link ReportSink} backed by `@actions/core` grouped log output and the GitHub
 * Actions step summary API.
 *
 * Log groups use `::group::` / `::endgroup::` annotations. Summary lines are appended to the
 * step summary file via the `@actions/core` summary writer.
 */
export function createGitHubReportSink(options: GitHubReportSinkOptions = {}): ReportSink {
  const env = options.env ?? process.env;
  const summaryWriter = options.summaryWriter ?? core.summary;

  const reportSink: ReportSink = {
    publishLogGroup(title: string, lines: readonly string[], writeLine: (message: string) => void) {
      writeLine(`::group::${title}`);
      for (const line of lines) {
        writeLine(line);
      }
      writeLine('::endgroup::');
    },
    async publishSummary(lines: readonly string[]): Promise<void> {
      for (const line of lines) {
        summaryWriter.addRaw(line, true);
      }
      await summaryWriter.write();
    },
    async replaceSummary(lines: readonly string[]): Promise<void> {
      const summaryPath = env.GITHUB_STEP_SUMMARY?.trim() ?? '';
      // Only write directly to the path when it is absolute. A compromised step earlier in
      // the same workflow job could redirect GITHUB_STEP_SUMMARY to an arbitrary path via
      // $GITHUB_ENV; requiring an absolute path prevents writes to relative or traversal paths
      // while still rejecting a missing or empty variable.
      if (summaryPath && isAbsolutePosixOrWindowsPath(summaryPath)) {
        await writeFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
        return;
      }

      await reportSink.publishSummary(lines);
    },
  };

  return reportSink;
}
