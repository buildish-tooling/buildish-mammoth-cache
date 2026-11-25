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
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import regexpPlugin from 'eslint-plugin-regexp';
import { defineConfig } from 'eslint/config';
import gts from 'gts';
import tsEslintPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const gtsFiles = ['src/**/*.ts', 'test/**/*.ts'];
const classDeclaration = {
  selector:
    ':matches(ClassDeclaration, ExportNamedDeclaration[declaration.type="ClassDeclaration"], ExportDefaultDeclaration[declaration.type="ClassDeclaration"])',
};
const topLevelTypeDeclaration = {
  selector:
    'Program > :matches(TSTypeAliasDeclaration, TSInterfaceDeclaration, [declaration.type="TSTypeAliasDeclaration"], [declaration.type="TSInterfaceDeclaration"])',
};

export default defineConfig([
  {
    ignores: [
      '.agents/**',
      'build/**',
      'coverage/**',
      'dist/**',
      'docs/releases/**',
      'lib/**',
      'node_modules/**',
    ],
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
    files: gtsFiles,
    extends: [gts],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The standalone Prettier check also covers files outside the ESLint scope.
      'prettier/prettier': 'off',
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: 'method', next: '*' },
            { blankLine: 'always', prev: '*', next: 'method' },
          ],
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: classDeclaration, next: classDeclaration },
        { blankLine: 'always', prev: topLevelTypeDeclaration, next: '*' },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: gtsFiles,
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsEslintPlugin,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
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
  {
    files: ['patches/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { Buffer: 'readonly', TextDecoder: 'readonly' },
    },
  },
  eslintConfigPrettier,
  {
    files: gtsFiles,
    rules: { curly: ['error', 'all'] },
  },
]);
