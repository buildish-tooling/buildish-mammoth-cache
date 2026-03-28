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

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import regexpPlugin from 'eslint-plugin-regexp';
import tsEslintPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['build/**', 'coverage/**', 'dist/**', 'lib/**', 'node_modules/**'],
  },
  js.configs.recommended,
  regexpPlugin.configs['flat/recommended'],
  {
    // Disable regexp style rules that conflict with this codebase's conventions.
    // Explicit character classes ([A-Za-z0-9] rather than \w, [0-9] rather than
    // \d) are preferred for clarity and to prevent unintentional widening of
    // matches — \w includes locale-dependent characters in some engines and \d
    // matches non-ASCII digits with the u flag. The use-ignore-case rule is
    // disabled because adding an i flag changes the entire pattern's behaviour
    // and requires careful per-pattern review rather than mechanical auto-fixing.
    rules: {
      'regexp/prefer-d': 'off',
      'regexp/prefer-w': 'off',
      'regexp/use-ignore-case': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsEslintPlugin,
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
];
