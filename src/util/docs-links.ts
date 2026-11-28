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

import { version } from '../../package.json';

const RELEASED_DOCS_ROOT = 'https://buildish.org/components/mammoth-cache/releases/';

/**
 * Public URL of a page in the released docs for this Action version.
 *
 * The version is bundled from `package.json`, which release preparation sets to the released
 * version. Builds from an unreleased commit therefore link to the previous release's docs.
 *
 * @param page - Route below the version's docs root, for example `user/distributed-jobs/#matrix-jobs`.
 */
export function releasedDocsUrl(page: string): string {
  return RELEASED_DOCS_ROOT + version + '/' + page;
}

/** Released docs for distributed matrix jobs, which need distinct producer names. */
export const MATRIX_JOBS_DOCS_URL = releasedDocsUrl('user/distributed-jobs/#matrix-jobs');
