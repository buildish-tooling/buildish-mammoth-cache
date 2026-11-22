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

import { decodeInvocationAnchor, OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
const anchor = decodeInvocationAnchor(process.argv[2]);
if (anchor[0] !== 'streaming-lifecycle') throw new Error('Expected live anchor');
const budget = new WorkingBudget(),
  opened = await OpenedInvocation.open(anchor, budget);
process.stdout.write(
  JSON.stringify({
    id: opened.store.codec.options.model.id,
    phase: opened.state[4],
    retained: budget.retained,
  }),
);
