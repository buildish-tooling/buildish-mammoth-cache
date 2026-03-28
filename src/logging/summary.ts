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

import type { ReportSink } from '../reporting/types';

/**
 * Appends a follow-up summary section using the active CI provider summary surface.
 */
export async function appendJobSummary(
  reportSink: Pick<ReportSink, 'publishSummary'>,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  await reportSink.publishSummary(lines);
}

/**
 * Replaces the current provider-managed job summary when supported, falling back to append mode.
 */
export async function replaceJobSummary(
  reportSink: Pick<ReportSink, 'replaceSummary'>,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  await reportSink.replaceSummary(lines);
}

/**
 * Publishes a grouped log block through the active CI adapter so main/post details stay out of the
 * provider summary surface.
 */
export async function publishJobLogGroup(
  reportSink: Pick<ReportSink, 'publishLogGroup'>,
  title: string,
  lines: readonly string[],
  writeLine: (message: string) => void,
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  reportSink.publishLogGroup(title, lines, writeLine);
}

/**
 * Wraps `bodyLines` in an HTML `<details>/<summary>` block for use inside GitHub job summaries.
 *
 * The title text is HTML-escaped automatically. Returns the complete block as an array of strings,
 * each representing one rendered line.
 */
export function createDetailsSection(
  title: string,
  bodyLines: readonly string[],
): readonly string[] {
  return [
    '<details>',
    `<summary>${escapeHtml(title)}</summary>`,
    '',
    ...bodyLines,
    '',
    '</details>',
  ];
}

/**
 * Renders an HTML `<table>` as an array of lines suitable for GitHub job summaries.
 *
 * Header cells are HTML-escaped. Cell content in `rows` is inserted verbatim so callers can
 * include pre-built HTML fragments (e.g. links from {@link createHtmlLink}).
 */
export function createHtmlTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const headerCells = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  return [
    '<table>',
    `  <thead><tr>${headerCells}</tr></thead>`,
    '  <tbody>',
    ...rows.map((row) => `    <tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`),
    '  </tbody>',
    '</table>',
  ];
}

/** Returns an HTML anchor tag with both the `href` and label HTML-escaped. */
export function createHtmlLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * Escapes special HTML characters in `value` to their entity equivalents.
 *
 * Covers `&`, `<`, `>`, `"`, and `'`. Use this for any user-supplied or dynamic content
 * inserted into raw HTML strings in job summaries.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Escapes Markdown special characters in `value` so they render as literal text.
 *
 * Useful when dynamic content (e.g. branch names, file paths) is embedded in Markdown summary
 * lines that will be interpreted by GitHub's Markdown renderer.
 */
export function escapeSummaryText(value: string): string {
  return value.replaceAll(/[\\`*_{}[\]()#+.!|-]/g, '\\$&');
}
