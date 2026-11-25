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

import { z } from 'zod';
import { NativeRoot, sameObject } from './native';
import { OwnedStore, locatorSchema, readFixedMetadata as fixed } from './owned-store';
import {
  LocalCodec,
  nativePathSchema,
  nativeIdentitySchema,
  ownedReferenceSchema,
  policySchema,
} from './local-schema';
import {
  contextSchema,
  nonceSchema,
  shaSchema,
  positiveSchema,
  textSchema,
  type Context,
} from './schema';
import { invocationId } from './model';
import { streamingFamilyId } from './profiles';
import { H, tuple, decodeRecord, encodeRecord, equal, rawSha } from './encoding';
import { readModelStream } from './local-stream';
import type { WorkingBudget } from './tree-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#ci-invocation-anchor-and-cold-reopening.
const anchorSchema = z.tuple([
  z.literal('streaming-lifecycle'),
  z.literal(1),
  nativePathSchema,
  nativeIdentitySchema.refine((n) => n[2] === 'directory'),
  contextSchema,
  nonceSchema,
]);
export type InvocationAnchor = z.infer<typeof anchorSchema>;

const disabledAnchorSchema = z.tuple([
  z.literal('streaming-disabled'),
  z.literal(1),
  contextSchema,
  nativePathSchema,
  nativePathSchema.nullable(),
]);
const lifecycleAnchorSchema = z.union([anchorSchema, disabledAnchorSchema]);
export const disabledInvocationAnchor = (
  context: Context,
  hookRoot: string,
  captureTempDirectory: string | null = null,
) => disabledAnchorSchema.parse(['streaming-disabled', 1, context, hookRoot, captureTempDirectory]);
export function invocationAnchor(
  root: NativeRoot,
  context: Context,
  nonce: string,
): InvocationAnchor {
  return anchorSchema.parse(['streaming-lifecycle', 1, root.path, root.binding, context, nonce]);
}
export const encodeInvocationAnchor = (anchor: z.infer<typeof lifecycleAnchorSchema>): string =>
  encodeRecord(lifecycleAnchorSchema.parse(anchor)).toString('utf8');
export const decodeInvocationAnchor = (raw: string): z.infer<typeof lifecycleAnchorSchema> =>
  lifecycleAnchorSchema.parse(decodeRecord(Buffer.from(raw)));

const opened = new WeakSet<object>();
export class OpenedInvocation {
  private constructor(
    readonly store: OwnedStore,
    readonly anchor: InvocationAnchor,
    readonly state: ReturnType<LocalCodec['schemas']['documents']['local-state']['parse']>,
    readonly bindings: ReturnType<LocalCodec['schemas']['documents']['bindings']['parse']>,
  ) {
    opened.add(this);
    Object.freeze(this);
  }

  static assert(value: OpenedInvocation) {
    if (!opened.has(value)) {
      throw new Error('Unbound reopened invocation.');
    }
  }

  static async open(
    anchor: InvocationAnchor,
    budget: WorkingBudget,
    signal = new AbortController().signal,
  ) {
    anchor = anchorSchema.parse(anchor);
    const root = await NativeRoot.bind(anchor[2]);
    if (
      root.path !== anchor[2] ||
      !sameObject(root.binding, anchor[3]) ||
      root.binding[6] !== anchor[3][6]
    ) {
      throw new Error('Lifecycle root binding changed.');
    }
    const result = await OpenedInvocation.current(root.path, budget, signal);
    if (!result) {
      throw new Error('Prepare did not publish an invocation.');
    }
    equal([result.anchor[4], result.anchor[5]], [anchor[4], anchor[5]], 'CI invocation anchor');
    if (!sameObject(result.anchor[3], anchor[3]) || result.anchor[3][6] !== anchor[3][6]) {
      throw new Error('Lifecycle root changed while reopening.');
    }
    return result;
  }

  static async current(
    path: string,
    budget: WorkingBudget,
    signal = new AbortController().signal,
  ): Promise<OpenedInvocation | null> {
    signal.throwIfAborted();
    const root = await NativeRoot.bind(path),
      locator = await fixed(root, '.mammoth/v1/current.json');
    signal.throwIfAborted();
    if (locator === null) {
      return null;
    }
    const current = locatorSchema.parse(locator),
      id = current[2],
      rawState = tuple((await fixed(root, current[3]))!, 'local-state', 8);
    equal([rawState[1], rawState[2]], [2, id], 'current v2 invocation');
    const bindingRef = ownedReferenceSchema(id, 'bindings').parse(rawState[5]);
    const rawBindings = await fixed(root, bindingRef[2]);
    if (rawBindings === null) {
      throw new Error('Missing lifecycle bindings.');
    }
    const encoded = encodeRecord(rawBindings);
    equal(
      [encoded.length, rawSha(encoded)],
      [bindingRef[3], bindingRef[4]],
      'lifecycle bindings reference',
    );
    // These facts are provisional extraction, not an alternate acceptance schema.
    // The normal codec validates the complete documents after model reconstruction.
    const b = tuple(rawBindings, 'bindings', 9),
      context = contextSchema.parse(b[3]),
      nonce = nonceSchema.parse(b[4]);
    equal(b[1], 2, 'v2 lifecycle bindings');
    equal([b[2], invocationId(context, nonce)], [id, id], 'bootstrap invocation');
    const projection = tuple(b[7], 'family', 12),
      prefix = textSchema.parse(projection[2]),
      version = positiveSchema.parse(projection[3]),
      modelId = shaSchema.parse(projection[4]),
      modelRef = ownedReferenceSchema(id, 'model').parse(b[6]),
      policy = policySchema.parse(b[8]);
    const model = await readModelStream(
        root.read(modelRef[2]),
        modelRef,
        {
          invocation: id,
          model: modelId,
          family: streamingFamilyId(context[7], H('family', projection)),
          prefix,
          version,
        },
        budget,
        signal,
      ),
      codec = new LocalCodec({
        model,
        context,
        invocation: id,
        role: policy[2],
        access: policy[3],
      }),
      state = codec.schemas.documents['local-state'].parse(rawState),
      bindings = codec.schemas.documents.bindings.parse(rawBindings);
    codec.checkStateBindings(state, bindings);
    if (
      bindings[5][0] !== root.path ||
      !sameObject(bindings[5][1], root.binding) ||
      bindings[5][1][6] !== root.binding[6]
    ) {
      throw new Error('Reopened root binding changed.');
    }
    const store = await OwnedStore.bind(root.path, codec);
    equal(await store.state(), state, 'stable reopened state');
    await root.verifyRoot();
    signal.throwIfAborted();
    return new OpenedInvocation(store, invocationAnchor(root, context, nonce), state, bindings);
  }
}
