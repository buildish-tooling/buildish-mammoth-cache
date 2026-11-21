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
import { equal, canonical, type Value } from './encoding';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { InstallAdmission } from './install-admission';
import type { FrozenInstall } from './install-plan';
import { InstallProgram, InstallReaders, type InstallBatch } from './install-program';
import { InstallParentPhase } from './install-parent-phase';
import { checkInstallMember } from './install-member';
import { InstallScratch } from './install-scratch';
import { buildChangeIndex } from './install-changes';
import { checkInstallProjection, type ChangeOutcome } from './install-projection';
import { buildInstallIndex, IndexDirectories, type IndexedNode } from './install-index';
import { installCurrentRows } from './install-current';
import { walkNative } from './native-walk';
import type { LocalRow } from './local-stream';
import type { InstallCursor } from './install-batches';
import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { retireOwnedDirectory } from './owned-retirement';
import { retireBackup } from './install-retire';

type InstallRow = ReturnType<OwnedStore['codec']['schemas']['rows']['install']['parse']>;
type ParentRow = ReturnType<OwnedStore['codec']['schemas']['rows']['installParent']['parse']>;
const signalDefault = () => new AbortController().signal;

async function progress(store: OwnedStore, plan: Reference, cursor: InstallCursor) {
  const ref = await store.writeDocument([
    'install-progress',
    1,
    store.codec.options.invocation,
    plan,
    cursor,
    null,
  ]);
  await store.fail('install-progress-candidate');
  const state = store.codec.schemas.documents['local-state'].parse(await store.state());
  if (state[4] !== 'prepare-pending') throw new Error('Install phase changed during execution.');
  const old = state[11];
  state[3]++;
  state[11] = store.codec.schemas.ref('install-progress').parse(ref);
  await store.updateState(state);
  await store.fail('install-progress-pointer');
  if (old) await store.retireReplacedDocument(old);
}
async function finish(store: OwnedStore) {
  const state = store.codec.schemas.documents['local-state'].parse(await store.state());
  const old = state[11];
  state[3]++;
  state[11] = null;
  await store.updateState(state);
  await store.fail('install-finished');
  if (old) await store.retireReplacedDocument(old);
}
async function emptyParent(store: OwnedStore, row: ParentRow) {
  const source = await store.root.stat(row[3]);
  if (!source || !sameNative(source, row[4], true) || source[3] !== store.root.binding[3])
    throw new Error('Changed parent creation source.');
  const directory = await opendir(store.root.resolve(row[3]));
  try {
    if (await directory.read()) throw new Error('Parent source is not empty.');
  } finally {
    await directory.close();
  }
  const after = await store.root.stat(row[3]);
  if (!after || !sameNative(source, after, true))
    throw new Error('Parent source changed during check.');
  const relative = row[3].slice(store.prefix.length),
    parts = relative.split('/');
  if (
    !row[3].startsWith(store.prefix) ||
    parts.length !== 4 ||
    parts[0] !== 'parents' ||
    !/^[a-f0-9-]{36}$/.test(parts[1]) ||
    parts[2] !== 'objects' ||
    parts[3] !== createHash('sha256').update(row[2]).digest('hex')
  )
    throw new Error('Unbound parent source namespace.');
  return source;
}

/** Process-local native execution; no serialized row is sufficient to call this. */
class Mutations {
  private readonly phases: InstallParentPhase[] = [];
  private readonly source = new Map<string, InstallParentPhase>();
  private readonly directories: IndexDirectories[] = [];
  private scratch: InstallScratch | null = null;
  backups!: InstallScratch;
  backupCursor = 0;
  private mutablePrefix: string | null = null;
  private mutableNative: NativeIdentity | null = null;
  private ownsBackups = false;
  live!: InstallParentPhase;
  owned!: InstallParentPhase;
  private constructor(readonly program: InstallProgram) {}
  static async create(
    program: InstallProgram,
    admission: InstallAdmission | null,
    signal: AbortSignal,
    current?: IndexDirectories,
    backups?: InstallScratch,
  ) {
    const self = new Mutations(program),
      store = program.store,
      budget = program.readers.budget;
    try {
      const prefix = store.prefix + 'mutation/' + randomUUID() + '/';
      await store.makeParents(prefix + 'pending');
      self.mutablePrefix = prefix.slice(0, -1);
      self.mutableNative = await store.root.stat(self.mutablePrefix);
      self.scratch = await InstallScratch.create(store, budget);
      self.backups = backups ?? (await InstallScratch.create(store, budget));
      self.ownsBackups = !backups;
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
      if (current)
        self.live = await phase('', async (p) => {
          const n = await current.directory(p);
          return n ? (n[3] as NativeIdentity) : null;
        });
      else if (admission) self.live = await phase('', (p) => admission.currentDirectory(p));
      else {
        const index = await buildInstallIndex(
          self.scratch,
          self.currentRows(signal),
          store.codec.options.model,
          null,
          signal,
        );
        const dirs = new IndexDirectories(self.scratch, index);
        self.directories.push(dirs);
        self.live = await phase('', async (p) => {
          const n = await dirs.directory(p);
          return n ? (n[3] as NativeIdentity) : null;
        });
      }
      self.owned = await phase(store.prefix.slice(0, -1), (p) => store.root.stat(p));
      for (let i = 0; i < store.codec.options.model.partitions.length; i++) {
        const partition = store.codec.options.model.partitions[i][0],
          anchor = store.prefix + 'install/' + partition;
        if (!(await store.root.stat(anchor))) continue;
        let dirs = admission?.sourceDirectories[i] ?? null;
        if (!dirs) {
          let record = 0;
          async function* rows(): AsyncGenerator<LocalRow> {
            for await (const event of walkNative(store.root, anchor, {
              budget,
              logicalRoot: '',
              metadata: 'reject',
              signal,
              maxDirectoryEntries: program.readers.maxDirectoryEntries,
            })) {
              if (event.tag === 'directory-close') continue;
              if (event.tag === 'protected-child')
                throw new Error('Unsupported source directory child.');
              const value: Value =
                event.tag === 'file'
                  ? ['file', event.path, event.identity, '0'.repeat(64)]
                  : ['directory', event.path, event.identity];
              yield { value, start: record, end: ++record, record };
            }
            yield { value: ['local-end'], start: record, end: record, record };
          }
          const index = await buildInstallIndex(
            self.scratch,
            rows(),
            store.codec.options.model,
            partition,
            signal,
          );
          dirs = new IndexDirectories(self.scratch, index);
          self.directories.push(dirs);
        }
        const directory = dirs;
        self.source.set(
          partition,
          await phase(anchor, async (p) => {
            const logical = p === anchor ? '' : p.slice(anchor.length + 1),
              n = await directory.directory(logical);
            return n ? (n[3] as NativeIdentity) : null;
          }),
        );
      }
      return self;
    } catch (error) {
      await self.close();
      throw error;
    }
  }
  private async *currentRows(signal: AbortSignal): AsyncGenerator<LocalRow> {
    let record = 0;
    for await (const value of installCurrentRows(this.program.store, {
      budget: this.program.readers.budget,
      signal,
      maxDirectoryEntries: this.program.readers.maxDirectoryEntries,
    }))
      yield { value, start: record, end: ++record, record };
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
    if (!before || !sameNative(before, expected, true) || (await to.stat(target)))
      throw new Error('Unexpected native rename endpoints.');
    signal.throwIfAborted();
    await rename(this.program.store.root.resolve(source), this.program.store.root.resolve(target));
    this.program.store.root.work.renames++;
    const after = await to.stat(target);
    if (!after || !sameRename(before, after)) throw new Error('Native rename identity changed.');
    await from.changed(source);
    await to.changed(target);
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
  async apply(row: InstallRow, signal: AbortSignal, parked = false) {
    if (row[5] && !parked) {
      await this.live.parents(row[2]);
      await this.owned.parents(row[7]!);
      const old = await checkInstallMember(
        this.program.readers,
        row[5],
        row[2],
        row[2],
        {
          renamed: false,
          hash: false,
          stat: (p) => this.live.stat(p),
        },
        signal,
      );
      const observed = await this.move(row[2], row[7]!, old, this.live, this.owned, signal);
      await this.backups.append(['backup', row, observed]);
      await this.program.store.fail(
        row[6] === 'delete' ? 'install-delete-backed-up' : 'install-old-backed-up',
      );
    } else if (parked) await this.reconciledOld(row);
    if (row[3] === null) return;
    const reader = await this.program.readers.reader(row[4]!, signal),
      source = this.source.get(reader.partition);
    if (!source) throw new Error('Missing source parent phase.');
    await source.parents(row[3]);
    await this.live.parents(row[2]);
    const native = await checkInstallMember(
      this.program.readers,
      row[4]!,
      row[2],
      row[3],
      {
        renamed: false,
        hash: false,
        stat: (p) => source.stat(p),
      },
      signal,
    );
    await this.move(row[3], row[2], native, source, this.live, signal);
    await this.program.store.fail('install-source-renamed');
  }
  private async reconciledOld(row: InstallRow) {
    await this.owned.parents(row[7]!);
    await this.live.parents(row[2]);
    await this.owned.changed(row[7]!);
    await this.live.changed(row[2]);
  }
  async reconciled(value: Value, signal: AbortSignal) {
    const row = value as readonly Value[];
    if (row[0] === 'install' && row[5] !== null)
      await this.reconciledOld(this.program.store.codec.schemas.rows.install.parse(row));
    if (row[3] === null) return;
    const sourcePath = String(row[3]),
      target = String(row[2]);
    const source =
      row[0] === 'install-parent'
        ? this.owned
        : this.source.get((await this.program.readers.reader(row[4], signal)).partition);
    if (!source) throw new Error('Missing reconciled source phase.');
    await source.parents(sourcePath);
    await this.live.parents(target);
    await source.changed(sourcePath);
    await this.live.changed(target);
  }
  async barrier() {
    for (const p of this.phases) await p.barrier();
  }
  async close() {
    for (const p of this.phases) p.release();
    for (const d of this.directories) d.close();
    await closeInstallResources([
      this.scratch?.close(),
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

async function evidence(program: InstallProgram, batch: InstallBatch, signal: AbortSignal) {
  async function* rows() {
    for await (const row of program.batchRows(batch)) {
      await program.readers.before(row, signal);
      yield row;
    }
  }
  const ref = await program.store.writeStream(
    'install-evidence',
    {
      budget: program.readers.budget,
      partition: null,
      maxDirectoryEntries: program.readers.maxDirectoryEntries,
      installKind: () => program.readers.kind,
    },
    rows(),
    signal,
  );
  await program.store.fail('install-evidence-published');
  return ref;
}
async function runRows(
  program: InstallProgram,
  batch: InstallBatch,
  mutations: Mutations,
  signal: AbortSignal,
  completed?: (row: Value) => Promise<boolean | 'parked'>,
) {
  for await (const value of program.batchRows(batch)) {
    signal.throwIfAborted();
    const row = value as readonly Value[];
    if (row[0] !== 'install' && row[0] !== 'install-parent') continue;
    const state = completed ? await completed(value) : false;
    if (state === true) {
      await mutations.reconciled(value, signal);
      continue;
    }
    if (row[0] === 'install-parent')
      await mutations.parent(program.store.codec.schemas.rows.installParent.parse(value), signal);
    else
      await mutations.apply(
        program.store.codec.schemas.rows.install.parse(value),
        signal,
        state === 'parked',
      );
  }
  await mutations.barrier();
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
export async function executeInstall(
  store: OwnedStore,
  frozen: FrozenInstall,
  budget: WorkingBudget,
  options: { signal?: AbortSignal; batchOperations?: number; batchBytes?: number } = {},
) {
  const signal = options.signal ?? signalDefault(),
    admission = await InstallAdmission.create(store, frozen, budget, signal);
  const readers = new InstallReaders(store, budget, frozen.maxDirectoryEntries, admission, true);
  let program: InstallProgram | undefined, mutations: Mutations | undefined;
  try {
    program = await InstallProgram.create(store, frozen.plan, readers, signal, {
      operations: options.batchOperations ?? 16384,
      bytes: options.batchBytes ?? 8 * 1024 * 1024,
    });
    if (!canonical((await store.state())!).equals(canonical(admission.initialState)))
      throw new Error('Install state changed.');
    mutations = await Mutations.create(program, admission, signal);
    await progress(store, program.plan, program.initial);
    for await (const value of program.batches.rows(0, program.batches.position)) {
      signal.throwIfAborted();
      if ((value as readonly Value[])[0] !== 'batch') continue;
      const batch = value as InstallBatch;
      const ref = await evidence(program, batch, signal);
      const intent: Value = [
        'install-intent',
        1,
        store.codec.options.invocation,
        program.plan,
        batch[1],
        batch[2],
        ref,
      ];
      await store.publishIntent(intent);
      await store.fail('install-intent-published');
      await runRows(program, batch, mutations, signal);
      await progress(store, program.plan, batch[2]);
      await retireInstallBackups(program, mutations, signal);
      await store.clearIntent(intent);
      await store.fail('install-intent-retired');
      await store.retireInstallMetadata(ref);
    }
    await finish(store);
  } finally {
    await closeInstallResources([
      mutations?.close(),
      program?.close(),
      readers.close(),
      admission.close(),
    ]);
  }
  for (const q of [frozen.plan, frozen.current, ...frozen.preimages])
    if (q) await store.retireInstallMetadata(q);
}

async function verifyBatchEvidence(
  program: InstallProgram,
  batch: InstallBatch,
  reference: Value,
  signal: AbortSignal,
) {
  const expected = program.batchRows(batch);
  try {
    for await (const record of program.store.rows(
      reference,
      'install-evidence',
      {
        budget: program.readers.budget,
        partition: null,
        maxDirectoryEntries: program.readers.maxDirectoryEntries,
        installKind: () => program.readers.kind,
      },
      signal,
      (v) => program.readers.before(v, signal),
    )) {
      const row = record.value as readonly Value[];
      if (row[0] === 'local-stream' || row[0] === 'local-end') continue;
      const next = await expected.next();
      if (next.done) throw new Error('Excess batch evidence.');
      equal(row, next.value, 'exact batch evidence');
    }
    if (!(await expected.next()).done) throw new Error('Missing batch evidence.');
  } finally {
    await expected.return(undefined as never);
  }
}

/** Recover only the active complete batch; an unstarted old-plan suffix is abandoned. */
export async function recoverInstall(
  store: OwnedStore,
  budget: WorkingBudget,
  signal = signalDefault(),
): Promise<void> {
  signal.throwIfAborted();
  const state = store.codec.schemas.documents['local-state'].parse(await store.state());
  if (state[4] !== 'prepare-pending') throw new Error('Install recovery requires prepare-pending.');
  const marker = await store.readFixed(store.prefix + 'install-intent.json');
  if (!marker && state[11] === null) return;
  if (state[11] === null) throw new Error('Install intent has no progress owner.');
  const intent = marker ? store.codec.schemas.documents['install-intent'].parse(marker) : null;
  const saved = store.codec.schemas.documents['install-progress'].parse(
    await store.readDocument(state[11], 'install-progress'),
  );
  if (intent) equal(saved[3], intent[3], 'intent plan');
  const committed = !intent || canonical(saved[4]).equals(canonical(intent[5]));
  if (intent && !committed) equal(saved[4], intent[4], 'uncommitted batch start');
  const bindings = store.codec.schemas.documents.bindings.parse(
    await store.readDocument(state[5], 'bindings'),
  );
  const readers = new InstallReaders(store, budget, bindings[8][9], undefined, true);
  let program: InstallProgram | undefined,
    mutations: Mutations | undefined,
    scratch: InstallScratch | undefined,
    backups: InstallScratch | undefined;
  let completed = false;
  const garbage: Reference[] = [];
  const routeFiles: InstallScratch[] = [],
    directories: IndexDirectories[] = [];
  try {
    program = await InstallProgram.create(store, saved[3], readers, signal);
    if (saved[4][5] !== null || (intent && (intent[4][5] !== null || intent[5][5] !== null)))
      throw new Error('Install cursor must not have a stack.');
    if (!intent && canonical(saved[4]).equals(canonical(program.initial))) {
      await finish(store);
      completed = true;
      return;
    }
    const batch = await program.range(
      intent ? (intent[4] as InstallCursor) : program.initial,
      intent ? (intent[5] as InstallCursor) : (saved[4] as InstallCursor),
    );
    if (intent) await verifyBatchEvidence(program, batch, intent[6], signal);
    scratch = await InstallScratch.create(store, budget);
    backups = await InstallScratch.create(store, budget);
    const before = await buildInstallIndex(
      scratch,
      store.rows(
        program.context,
        'install-current',
        {
          budget,
          partition: null,
          maxDirectoryEntries: readers.maxDirectoryEntries,
        },
        signal,
      ),
      store.codec.options.model,
      null,
      signal,
    );
    let n = 0;
    async function* actualRows(): AsyncGenerator<LocalRow> {
      for await (const value of installCurrentRows(store, {
        budget,
        signal,
        maxDirectoryEntries: readers.maxDirectoryEntries,
      }))
        yield { value, start: n, end: ++n, record: n };
    }
    const actual = await buildInstallIndex(
      scratch,
      actualRows(),
      store.codec.options.model,
      null,
      signal,
    );
    const current = new IndexDirectories(scratch, actual);
    directories.push(current);
    let route = 0;
    const first = intent ? await firstIndex(program, batch) : Number.MAX_SAFE_INTEGER;
    for await (const value of program.rows.rows(0, batch[4])) {
      const row = value as readonly Value[];
      if (row[0] === 'install-unit-open')
        route =
          row[1] === 'snapshot'
            ? 1 + store.codec.options.model.partitions.findIndex((p) => p[0] === row[2])
            : 0;
      if (row[0] !== 'install' && row[0] !== 'install-parent') continue;
      if (!routeFiles[route]) routeFiles[route] = await InstallScratch.create(store, budget);
      // The byte offset is derived from the actual plan cursor and exact copied rows.
      const active = Number(row[1]) >= first;
      await routeFiles[route].append([
        String(row[2]),
        ['effect', active ? 'active' : 'prefix', row],
      ]);
    }
    const roots: number[] = [];
    for (const file of routeFiles)
      if (file) {
        async function* changes() {
          for await (const row of file.rows(0, file.position)) {
            const r = row as readonly Value[];
            yield [String(r[0]), r[1]] as const;
          }
        }
        roots.push(await buildChangeIndex(scratch, changes(), signal));
      }
    async function inspect(value: Value, node: IndexedNode | null): Promise<ChangeOutcome> {
      const wrapper = value as readonly Value[],
        row = wrapper[2] as readonly Value[];
      const mustComplete = wrapper[1] === 'prefix' || committed;
      if (row[0] === 'install-parent') {
        const parent = store.codec.schemas.rows.installParent.parse(row),
          source = await store.root.stat(parent[3]);
        if (source) {
          if (node || mustComplete) throw new Error('Unexpected/pending created parent state.');
          await emptyParent(store, parent);
          return { entryChanged: false, opaque: false, parent: null };
        }
        if (!node || node[1] !== 'directory') throw new Error('Lost/replaced created parent.');
        return { entryChanged: true, opaque: false, parent: parent[4] };
      }
      const op = store.codec.schemas.rows.install.parse(row);
      const classification = await classifyInstallOperation(
        readers,
        op,
        mustComplete,
        wrapper[1] === 'prefix',
        signal,
        async (native) => {
          await backups!.append(['backup', op, native]);
        },
      );
      return { entryChanged: classification !== 'pending', opaque: true };
    }
    await checkInstallProjection(scratch, before, actual, roots, inspect, signal);
    if (!intent) {
      await finish(store);
      completed = true;
      return;
    }
    mutations = await Mutations.create(program, null, signal, current, backups);
    await runRows(program, batch, mutations, signal, async (value) => {
      const row = value as readonly Value[];
      if (row[0] === 'install-parent') return !(await store.root.stat(String(row[3])));
      const state = await classifyInstallOperation(
        readers,
        store.codec.schemas.rows.install.parse(row),
        committed,
        false,
        signal,
      );
      return state === 'complete' ? true : state === 'parked' ? 'parked' : false;
    });
    if (!committed) await progress(store, program.plan, batch[2]);
    await retireInstallBackups(program, mutations, signal);
    await store.clearIntent(intent);
    await store.fail('install-intent-retired');
    await store.retireInstallMetadata(intent[6]);
    await finish(store);
    completed = true;
  } finally {
    if (completed && program)
      garbage.push(program.plan, program.context, ...readers.preimageReferences);
    for (const d of directories) d.close();
    await closeInstallResources([
      mutations?.close(),
      ...routeFiles.filter(Boolean).map((f) => f.close()),
      scratch?.close(),
      backups?.close(),
      program?.close(),
      readers.close(),
    ]);
    if (completed) for (const ref of garbage) await store.retireInstallMetadata(ref);
  }
}
async function firstIndex(program: InstallProgram, batch: InstallBatch): Promise<number> {
  for await (const value of program.batchRows(batch)) {
    const row = value as readonly Value[];
    if (row[0] === 'install' || row[0] === 'install-parent') return Number(row[1]);
  }
  return Number.MAX_SAFE_INTEGER;
}

async function closeInstallResources(resources: (Promise<unknown> | undefined)[]) {
  const results = await Promise.allSettled(resources);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Install resource cleanup failed.',
    );
}

async function classifyInstallOperation(
  readers: InstallReaders,
  op: InstallRow,
  committed: boolean,
  retired: boolean,
  signal: AbortSignal,
  backupObserved?: (native: NativeIdentity) => Promise<void>,
): Promise<'pending' | 'parked' | 'complete'> {
  const root = readers.store.root;
  const target = await root.stat(op[2]),
    source = op[3] === null ? null : await root.stat(op[3]),
    backup = op[7] === null ? null : await root.stat(op[7]);
  if (retired && backup) throw new Error('Unexpected retired-prefix backup.');
  const checkSource = async () => {
    await checkInstallMember(
      readers,
      op[4]!,
      op[2],
      op[3]!,
      { renamed: false, hash: !!backupObserved },
      signal,
    );
  };
  const checkDesired = async () => {
    await checkInstallMember(
      readers,
      op[4]!,
      op[2],
      op[2],
      { renamed: true, hash: !!backupObserved },
      signal,
    );
  };
  const checkOld = async () => {
    await checkInstallMember(
      readers,
      op[5]!,
      op[2],
      op[2],
      { renamed: false, hash: !!backupObserved },
      signal,
    );
  };
  const checkBackup = async () => {
    if (!backup) return;
    const observed = await checkInstallMember(
      readers,
      op[5]!,
      op[2],
      op[7]!,
      { renamed: true, hash: !!backupObserved, partial: committed },
      signal,
    );
    if (backupObserved) await backupObserved(observed);
  };
  if (op[6] === 'insert') {
    if (source && !target && !committed) {
      await checkSource();
      return 'pending';
    }
    if (!source && target) {
      await checkDesired();
      return 'complete';
    }
    throw new Error('Lost insert or conflicting insert endpoints.');
  }
  if (op[6] === 'delete') {
    if (target && !backup && !committed) {
      await checkOld();
      return 'pending';
    }
    if (!target && (backup || committed)) {
      await checkBackup();
      return 'complete';
    }
    throw new Error('Conflicting/lost delete preimage.');
  }
  if (source && target && !backup && !committed) {
    await checkSource();
    await checkOld();
    return 'pending';
  }
  if (source && !target && backup && !committed) {
    await checkSource();
    await checkBackup();
    return 'parked';
  }
  if (!source && target && (backup || committed)) {
    await checkDesired();
    await checkBackup();
    return 'complete';
  }
  throw new Error('Conflicting/lost replacement endpoints.');
}
async function retireInstallBackups(
  program: InstallProgram,
  mutations: Mutations,
  signal: AbortSignal,
) {
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
  await program.store.fail('install-backups-retired');
}
