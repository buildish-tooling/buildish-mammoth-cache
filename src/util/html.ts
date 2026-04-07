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
 * Opaque branded type for content that has already been HTML-sanitised and is safe to embed
 * verbatim in HTML output.
 *
 * Obtain a value of this type by calling {@link escapeHtml}, {@link createHtmlLink}, or — when
 * you are certain the string is already safe — the explicit opt-in constructor {@link safeHtml}.
 * Compile-time branding ensures raw strings cannot be passed where safe content is required
 * without a deliberate acknowledgement at the call site.
 */

export type SafeHtml = string & { readonly __safeHtmlBrand: unique symbol };

/**
 * Asserts that `value` is already properly HTML-escaped or is a trusted constant, and returns it
 * as a {@link SafeHtml}.
 *
 * **The caller accepts full responsibility for ensuring the value is safe to embed verbatim in
 * HTML.** Prefer {@link escapeHtml} for user-supplied strings and {@link createHtmlLink} for
 * hyperlinks; use this constructor only for known-safe literals or pre-sanitised fragments.
 */
export function safeHtml(value: string): SafeHtml {
  return value as SafeHtml;
}

/**
 * Wraps `bodyLines` in an HTML `<details>/<summary>` block for use inside GitHub job summaries.
 *
 * The `title` is HTML-escaped automatically and rendered as the `<summary>` label.
 *
 * `bodyLines` are embedded verbatim inside the `<details>` element. GitHub's job-summary renderer
 * treats this content as **Markdown**, not as HTML, so callers must sanitize any user-supplied
 * values with {@link escapeSummaryText} before including them in `bodyLines`. Do **not** pass raw
 * HTML strings here — unlike {@link createHtmlTable}, which enforces {@link SafeHtml} for every
 * cell at compile time, this function cannot enforce that constraint because the body is Markdown.
 *
 * Returns the complete block as an array of strings, each representing one rendered line.
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
 * Header cells are HTML-escaped automatically. Each cell in `rows` must be a {@link SafeHtml}
 * value, which requires callers to explicitly acknowledge they have sanitised the content —
 * either by calling {@link escapeHtml}, by calling {@link createHtmlLink}, or by using the
 * {@link safeHtml} opt-in constructor for trusted literals. This is a compile-time check; there
 * is no runtime overhead.
 */
export function createHtmlTable(
  headers: readonly string[],
  rows: readonly (readonly SafeHtml[])[],
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

/**
 * Returns an HTML anchor tag as a {@link SafeHtml} value.
 *
 * Both the `href` attribute and the visible label are HTML-escaped, so the result is safe to
 * embed verbatim in HTML output or pass directly to {@link createHtmlTable}.
 */
export function createHtmlLink(url: string, label: string): SafeHtml {
  return safeHtml(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
}

/**
 * Escapes special HTML characters in `value` to their entity equivalents and returns a
 * {@link SafeHtml} value that can be embedded verbatim in HTML output.
 *
 * Covers `&`, `<`, `>`, `"`, and `'`.
 */
export function escapeHtml(value: string): SafeHtml {
  return safeHtml(
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
  );
}

/**
 * Escapes Markdown special characters in `value` so they render as literal text.
 *
 * Useful when dynamic content (e.g. branch names, file paths) is embedded in Markdown summary
 * lines that will be interpreted by GitHub's Markdown renderer.
 */
export function escapeSummaryText(value: string): string {
  return value.replaceAll(/[\\`*_{}[\]()#+.!<>|-]/g, '\\$&');
}
