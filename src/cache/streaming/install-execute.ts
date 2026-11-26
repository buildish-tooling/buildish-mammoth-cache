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

import { rename, opendir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, type Value } from './encoding';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { InstallAdmission } from './install-admission';
import type { FrozenInstall } from './install-plan';
import { InstallProgram, InstallReaders, type InstallBatch } from './install-program';
import { InstallParentPhase } from './install-parent-phase';
import { InstallScratch } from './install-scratch';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { retireOwnedDirectory } from './owned-retirement';
import { retireBackup } from './install-retire';

type InstallRow = ReturnType<OwnedStore['codec']['schemas']['rows']['install']['parse']>;

type ParentRow = ReturnType<OwnedStore['codec']['schemas']['rows']['installParent']['parse']>;

const signalDefault = () => new AbortController().signal;

async function emptyParent(store: OwnedStore, row: ParentRow) {
  const source = await store.root.stat(row[3]);
  if (!source || !sameNative(source, row[4], true) || source[3] !== store.root.binding[3]) {
    throw new Error('Changed parent creation source.');
  }
  const directory = await opendir(store.root.resolve(row[3]));
  try {
    if (await directory.read()) {
      throw new Error('Parent source is not empty.');
    }
  } finally {
    await directory.close();
  }
  const after = await store.root.stat(row[3]);
  if (!after || !sameNative(source, after, true)) {
    throw new Error('Parent source changed during check.');
  }
  const relative = row[3].slice(store.prefix.length),
    parts = relative.split('/');
  if (
    !row[3].startsWith(store.prefix) ||
    parts.length !== 4 ||
    parts[0] !== 'parents' ||
    !/^[a-f0-9-]{36}$/.test(parts[1]) ||
    parts[2] !== 'objects' ||
    parts[3] !== createHash('sha256').update(row[2]).digest('hex')
  ) {
    throw new Error('Unbound parent source namespace.');
  }
  return source;
}

/** Process-local native execution; no serialized row is sufficient to call this. */
class Mutations {
  private pending: {
    source: string;
    target: string;
    before: NativeIdentity;
    from: InstallParentPhase;
    to: InstallParentPhase;
  } | null = null;
  retiringBackups = false;
  private activeBackup: {
    row: InstallRow;
    before: NativeIdentity;
    after?: NativeIdentity;
    incoming?: NativeIdentity;
  } | null = null;
  private readonly phases: InstallParentPhase[] = [];
  private readonly source = new Map<string, InstallParentPhase>();
  backups!: InstallScratch;
  backupCursor = 0;
  private mutablePrefix: string | null = null;
  private mutableNative: NativeIdentity | null = null;
  private ownsBackups = false;
  live!: InstallParentPhase;
  owned!: InstallParentPhase;

  private constructor(
    readonly program: InstallProgram,
    private readonly inherited?: { scratch: InstallScratch; partitions: ReadonlySet<string> },
  ) {}

  static async create(
    program: InstallProgram,
    admission: InstallAdmission,
    _signal: AbortSignal,
    inherited?: InstallScratch,
  ) {
    const store = program.store,
      budget = program.readers.budget;
    const partitions =
      inherited &&
      new Set(
        store.codec.options.model.partitions
          .filter(
            (p) =>
              p[3] === 'aggregate' &&
              admission.frozen.metadata.source(p[0])?.upstream.kind === 'native-metadata',
          )
          .map((p) => p[0]),
      );
    const self = new Mutations(
      program,
      inherited && partitions ? { scratch: inherited, partitions } : undefined,
    );
    try {
      const prefix = store.prefix + 'mutation/' + randomUUID() + '/';
      await store.makeParents(prefix + 'pending');
      self.mutablePrefix = prefix.slice(0, -1);
      self.mutableNative = await store.root.stat(self.mutablePrefix);
      self.backups = await InstallScratch.create(store, budget);
      self.ownsBackups = true;
      async function phase(
        anchor: string,
        expected: (path: string) => Promise<NativeIdentity | null>,
      ) {
        const ledger = prefix + String(self.phases.length) + '/';
        await store.makeParents(ledger + 'pending');
        const p = new InstallParentPhase(store, anchor, ledger, budget, expected);
        self.phases.push(p);
        return p;
      }
      self.live = await phase('', (path) => admission.currentDirectory(path));
      self.owned = await phase(store.prefix.slice(0, -1), (path) => store.root.stat(path));
      for (const input of admission.frozen.inputs) {
        const partition = input.partition,
          anchor = input.nativeRoot,
          ordinal = store.codec.options.model.partitions.findIndex((p) => p[0] === partition),
          directory = admission.sourceDirectories[ordinal];
        if (!directory) {
          throw new Error('Missing original admitted source hierarchy.');
        }
        self.source.set(
          partition,
          await phase(anchor, async (path) => {
            const logical = path === anchor ? '' : path.slice(anchor.length + 1),
              node = await directory.directory(logical);
            return node ? (node[3] as NativeIdentity) : null;
          }),
        );
      }
      return self;
    } catch (error) {
      await self.close();
      throw error;
    }
  }

  private async move(
    source: string,
    target: string,
    expected: NativeIdentity,
    from: InstallParentPhase,
    to: InstallParentPhase,
    signal: AbortSignal,
  ) {
    await from.parents(source);
    await to.parents(target);
    const before = await from.stat(source);
    if (!before || !sameNative(before, expected, true) || (await to.stat(target))) {
      throw new Error('Unexpected native rename endpoints.');
    }
    signal.throwIfAborted();
    this.pending = { source, target, before, from, to };
    await rename(this.program.store.root.resolve(source), this.program.store.root.resolve(target));
    this.program.store.root.work.renames++;
    await this.program.store.fail('install-rename-before-stat');
    const after = await to.stat(target);
    if (!after || !sameRename(before, after)) {
      throw new Error('Native rename identity changed.');
    }
    await from.changed(source);
    await to.changed(target);
    this.pending = null;
    return after;
  }

  async parent(row: ParentRow, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.live.parents(row[2]);
    const source = await emptyParent(this.program.store, row);
    const observed = await this.move(row[3], row[2], source, this.owned, this.live, signal);
    await this.live.created(row[2], observed);
    await this.program.store.fail('install-parent-renamed');
  }

  async apply(
    row: InstallRow,
    signal: AbortSignal,
    admittedSource: NativeIdentity | null,
    admittedOld: NativeIdentity | null,
  ) {
    if (row[5]) {
      await this.live.parents(row[2]);
      await this.owned.parents(row[7]!);
      const old = admittedOld;
      if (!old) {
        throw new Error('Missing admitted preimage.');
      }
      this.activeBackup = { row, before: old };
      const observed = await this.move(row[2], row[7]!, old, this.live, this.owned, signal);
      this.activeBackup.after = observed;
      await this.program.store.fail(
        row[6] === 'delete' ? 'install-delete-backed-up' : 'install-old-backed-up',
      );
    }
    if (row[3] === null) {
      if (this.activeBackup) {
        await this.backups.append(['backup', row, this.activeBackup.after!]);
        this.activeBackup = null;
      }
      return;
    }
    const reader = await this.program.readers.reader(row[4]!, signal),
      source = this.source.get(reader.partition);
    if (!source) {
      throw new Error('Missing source parent phase.');
    }
    await source.parents(row[3]);
    await this.live.parents(row[2]);
    const native = admittedSource;
    if (!native) {
      throw new Error('Missing admitted source.');
    }
    if (this.activeBackup) {
      this.activeBackup.incoming = native;
    }
    const placed = await this.move(row[3], row[2], native, source, this.live, signal);
    await this.program.store.fail('install-source-renamed');
    if (this.inherited?.partitions.has(reader.partition)) {
      if (placed[2] === 'file') {
        await this.inherited.scratch.append(['inherited', row[2], placed]);
      } else {
        await reader.recordInheritedFiles(row[4]!, this.inherited.scratch, signal);
      }
    }
    if (this.activeBackup) {
      await this.backups.append(['backup', row, this.activeBackup.after!]);
      this.activeBackup = null;
    }
  }

  async barrier() {
    for (const p of this.phases) {
      await p.barrier();
    }
  }

  /** Called while original readers and parent scopes still exist, never from persisted state. */
  async cleanupFailed(): Promise<void> {
    const signal = signalDefault(),
      store = this.program.store;
    if (this.pending) {
      const move = this.pending,
        source = await store.root.stat(move.source),
        target = await store.root.stat(move.target);
      if (source && sameNative(move.before, source, true) && !target) {
        this.pending = null;
      } else if (!source && target && sameRename(move.before, target)) {
        await move.from.changed(move.source);
        await move.to.changed(move.target);
        this.pending = null;
      } else {
        throw new Error(
          'Install cleanup endpoints ambiguous; retained at ' + move.source + ' and ' + move.target,
        );
      }
    }
    const active = this.activeBackup;
    if (active) {
      const row = active.row,
        backup = await store.root.stat(row[7]!),
        live = await store.root.stat(row[2]);
      if (!backup && live && sameNative(active.before, live, true)) {
        this.activeBackup = null;
      } else {
        if (
          !backup ||
          !(active.after
            ? sameNative(active.after, backup, true)
            : sameRename(active.before, backup))
        ) {
          throw new Error('Install backup cleanup blocked; retained at ' + row[7]);
        }
        if (row[6] !== 'delete' && !live) {
          await this.move(row[7]!, row[2], backup, this.owned, this.live, signal);
        } else if (
          (row[6] === 'delete' && !live) ||
          (live && active.incoming && sameRename(active.incoming, live))
        ) {
          await retireBackup(
            this.program.readers,
            row[5]!,
            row[2],
            row[7]!,
            backup,
            this.owned,
            signal,
          );
        } else {
          throw new Error(
            'Install return destination occupied; retained at ' + row[7] + ' and ' + row[2],
          );
        }
        this.activeBackup = null;
      }
    }
    if (!this.retiringBackups) {
      await retireInstallBackups(this.program, this, signal);
    }
  }

  async close() {
    for (const p of this.phases) {
      p.release();
    }
    await closeInstallResources([
      this.ownsBackups ? this.backups?.close() : undefined,
      this.mutablePrefix && this.mutableNative
        ? retireOwnedDirectory(
            this.program.store,
            this.mutablePrefix,
            this.mutableNative,
            this.program.readers.budget,
          )
        : undefined,
    ]);
  }
}

async function runRows(
  program: InstallProgram,
  batch: InstallBatch,
  mutations: Mutations,
  signal: AbortSignal,
) {
  for await (const value of program.batchRows(batch)) {
    signal.throwIfAborted();
    const accepted = value as readonly Value[],
      row = accepted[1] as readonly Value[];
    if (row[0] === 'install-parent') {
      await mutations.parent(program.store.codec.schemas.rows.installParent.parse(row), signal);
    } else if (row[0] === 'install') {
      await mutations.apply(
        program.store.codec.schemas.rows.install.parse(row),
        signal,
        accepted[2] as NativeIdentity | null,
        accepted[3] as NativeIdentity | null,
      );
    }
  }
  await mutations.barrier();
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
export async function executeInstall(
  store: OwnedStore,
  frozen: FrozenInstall,
  budget: WorkingBudget,
  options: Parameters<typeof executeInstallAttempt>[3] = {},
) {
  let failure: unknown, result: Awaited<ReturnType<typeof executeInstallAttempt>> | undefined;
  try {
    result = await executeInstallAttempt(store, frozen, budget, options);
  } catch (error) {
    failure = error;
  }
  try {
    await frozen.metadata?.dispose();
  } catch (cleanup) {
    failure =
      failure === undefined
        ? cleanup
        : new AggregateError(
            [failure, cleanup],
            'Install/context cleanup failed; owned locations retained under ' +
              store.root.resolve(store.prefix.slice(0, -1)),
          );
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result!;
}
async function executeInstallAttempt(
  store: OwnedStore,
  frozen: FrozenInstall,
  budget: WorkingBudget,
  options: {
    signal?: AbortSignal;
    batchOperations?: number;
    batchBytes?: number;
    inherited?: InstallScratch;
  } = {},
) {
  const signal = options.signal ?? signalDefault(),
    admission = await InstallAdmission.create(store, frozen, budget, signal);
  const readers = new InstallReaders(store, budget, frozen.maxDirectoryEntries, admission);
  let program: InstallProgram | undefined, mutations: Mutations | undefined;
  let failure: unknown;
  try {
    program = await InstallProgram.create(
      store,
      frozen.plan,
      readers,
      signal,
      {
        operations: options.batchOperations ?? 16384,
        bytes: options.batchBytes ?? 8 * 1024 * 1024,
      },
      admission,
    );
    if (!canonical((await store.state())!).equals(canonical(admission.initialState))) {
      throw new Error('Install state changed.');
    }
    mutations = await Mutations.create(program, admission, signal, options.inherited);
    for await (const value of program.batches.rows(0, program.batches.position)) {
      signal.throwIfAborted();
      if ((value as readonly Value[])[0] !== 'batch') {
        continue;
      }
      const batch = value as InstallBatch;
      await runRows(program, batch, mutations, signal);
      await retireInstallBackups(program, mutations, signal);
    }
  } catch (error) {
    failure = error;
    try {
      await mutations?.cleanupFailed();
    } catch (cleanup) {
      failure = new AggregateError(
        [error, cleanup],
        'Install failed and owned cleanup is blocked; retained backup roots under ' +
          store.root.resolve(store.prefix + 'backups') +
          '.',
        { cause: cleanup },
      );
    }
  } finally {
    try {
      await closeInstallResources([
        mutations?.close(),
        program?.close(),
        readers.close(),
        admission.close(),
      ]);
    } catch (cleanup) {
      failure =
        failure === undefined
          ? cleanup
          : new AggregateError(
              [failure, cleanup],
              'Install failure and resource close failed; retained payload under ' +
                store.root.resolve(store.prefix) +
                '.',
              { cause: cleanup },
            );
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  await store.retireInstallMetadata(frozen.plan);
}

async function closeInstallResources(resources: (Promise<unknown> | undefined)[]) {
  const results = await Promise.allSettled(resources);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) {
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Install resource cleanup failed.',
    );
  }
}

async function retireInstallBackups(
  program: InstallProgram,
  mutations: Mutations,
  signal: AbortSignal,
) {
  mutations.retiringBackups = true;
  for await (const value of mutations.backups.rows(
    mutations.backupCursor,
    mutations.backups.position,
  )) {
    const row = value as readonly Value[],
      op = program.store.codec.schemas.rows.install.parse(row[1]);
    await retireBackup(
      program.readers,
      op[5]!,
      op[2],
      op[7]!,
      row[2] as NativeIdentity,
      mutations.owned,
      signal,
    );
  }
  await mutations.barrier();
  mutations.backupCursor = mutations.backups.position;
  mutations.retiringBackups = false;
  await program.store.fail('install-backups-retired');
}
