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

// Separate OS process sampler: no imports from the product, no raw argv/environment output.
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
const exec = promisify(execFile);
const command = async (file, args) =>
  (await exec(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const numbers = (text) =>
  Object.fromEntries(
    [...text.matchAll(/^([A-Za-z_]+):?\s+([0-9]+)/gmu)].map((m) => [m[1], Number(m[2])]),
  );
export function treeRss(rows, parent) {
  if (parent <= 0) return 0;
  const included = new Set([parent]);
  // Bounded by OS process count, not fixture file count.
  for (let n = 0; n < rows.length; n++) {
    let changed = false;
    for (const row of rows)
      if (included.has(row.parent) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
    if (!changed) break;
  }
  return rows.reduce((sum, row) => (included.has(row.pid) ? sum + row.rss : sum), 0);
}
export function cgroupDirectories(group, mountRoot = '/') {
  if (!group.startsWith('/') || group.split('/').includes('..')) return null;
  const relative =
    mountRoot === '/'
      ? group
      : group === '/'
        ? '/'
        : group.startsWith(mountRoot + '/') || group === mountRoot
          ? group.slice(mountRoot.length)
          : null;
  if (relative === null) return null;
  const result = [],
    mount = '/sys/fs/cgroup';
  let directory = path.posix.join(mount, relative);
  while (true) {
    result.push(directory);
    if (directory === mount) return result;
    if (result.length >= 64) return null;
    directory = path.posix.dirname(directory);
  }
}
let groups;
async function effectiveGroups() {
  if (groups) return groups;
  const group = /^0::(.*)$/mu.exec(await readFile('/proc/self/cgroup', 'utf8'))?.[1];
  const mount = (await readFile('/proc/self/mountinfo', 'utf8'))
    .split('\n')
    .find((line) => line.includes(' - cgroup2 ') && line.split(' ')[4] === '/sys/fs/cgroup');
  groups = group && mount && mount.split(' ')[3] === '/' ? cgroupDirectories(group, '/') : null;
  return groups;
}
export async function cgroupLimits(directories, read = readFile) {
  let total = Infinity,
    available = Infinity;
  for (const directory of directories) {
    let max;
    try {
      max = (await read(directory + '/memory.max', 'utf8')).trim();
    } catch (e) {
      // Only the proven full hierarchy root lacks these non-root interfaces.
      if (e.code === 'ENOENT' && directory === '/sys/fs/cgroup') continue;
      throw e;
    }
    if (max === 'max') continue;
    const current = Number(await read(directory + '/memory.current', 'utf8'));
    if (!Number.isFinite(Number(max)) || !Number.isFinite(current))
      throw new Error('Invalid cgroup reading');
    available = Math.min(available, Number(max) - current);
    total = Math.min(total, Number(max));
  }
  return { total, available };
}
export async function snapshot() {
  let rows = [],
    available,
    paging = null,
    total = os.totalmem(),
    memoryQuality,
    effectiveLimitKnown = true;
  if (process.platform === 'linux') {
    const mem = numbers(await readFile('/proc/meminfo', 'utf8'));
    available = mem.MemAvailable * 1024;
    memoryQuality = 'MemAvailable';
    const vm = numbers(await readFile('/proc/vmstat', 'utf8'));
    paging = { input: vm.pswpin, output: vm.pswpout, unit: 'pages', scope: 'system' };
    try {
      const directories = await effectiveGroups();
      if (!directories) throw new Error('Unresolved effective cgroup');
      const limits = await cgroupLimits(directories);
      available = Math.min(available, limits.available);
      total = Math.min(total, limits.total);
      memoryQuality += '+current-and-ancestor-cgroup-v2';
    } catch {
      effectiveLimitKnown = false;
      memoryQuality += '+effective-cgroup-limit-unavailable';
    }
    for (const name of await readdir('/proc')) {
      if (!/^[0-9]+$/u.test(name)) continue;
      try {
        const text = await readFile('/proc/' + name + '/stat', 'utf8'),
          fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        const status = numbers(await readFile('/proc/' + name + '/status', 'utf8'));
        rows.push({
          pid: Number(name),
          parent: Number(fields[1]),
          rss: (status.VmRSS ?? 0) * 1024,
        });
      } catch (e) {
        if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e;
      }
    }
  } else if (process.platform === 'darwin') {
    const text = await command('/bin/ps', ['-axo', 'pid=,ppid=,rss=']);
    rows = text
      .trim()
      .split('\n')
      .map((line) => {
        const [pid, parent, rss] = line.trim().split(/\s+/u).map(Number);
        return { pid, parent, rss: rss * 1024 };
      });
    const vm = await command('/usr/bin/vm_stat', []),
      pageSize = Number(/page size of ([0-9]+)/u.exec(vm)?.[1]);
    const value = (name) => Number(new RegExp('^' + name + ': +([0-9]+)', 'mu').exec(vm)?.[1]);
    available =
      (value('Pages free') + value('Pages inactive') + value('Pages speculative')) * pageSize;
    memoryQuality = 'vm_stat-free+inactive+speculative-estimate';
    paging = { input: value('Swapins'), output: value('Swapouts'), unit: 'pages', scope: 'system' };
  } else if (process.platform === 'win32') {
    // No command lines or credentials in the query/output. Page faults are deliberately NOT called swap I/O.
    const script =
      '$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; $m=Get-CimInstance Win32_OperatingSystem; @{rows=@($p);available=([long]$m.FreePhysicalMemory*1024)} | ConvertTo-Json -Compress -Depth 3';
    const data = JSON.parse(
      await command('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ]),
    );
    available = data.available;
    memoryQuality = 'FreePhysicalMemory';
    rows = data.rows.map((r) => ({
      pid: r.ProcessId,
      parent: r.ParentProcessId,
      rss: Number(r.WorkingSetSize),
    }));
  } else throw new Error('Unsupported qualification OS');
  if (!Number.isFinite(available)) throw new Error('Unavailable memory reading');
  if (paging && (!Number.isFinite(paging.input) || !Number.isFinite(paging.output))) paging = null;
  return { rows, available, memoryQuality, paging, total, effectiveLimitKnown };
}
export async function observe(control, output) {
  let result = {
    samples: 0,
    peakRss: 0,
    minAvailable: Number.MAX_SAFE_INTEGER,
    firstPaging: null,
    lastPaging: null,
    phases: {},
    missing: [],
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    started: new Date().toISOString(),
  };
  let first = true;
  while (true) {
    const state = JSON.parse(await readFile(control, 'utf8'));
    if (state.stop) break;
    if (Date.now() - Date.parse(result.started) > 65 * 60 * 1000)
      throw new Error('Sampler duration bound exceeded');
    try {
      const sample = await snapshot(),
        rss = treeRss(sample.rows, state.pid),
        phase = state.phase ?? 'idle';
      result.total = sample.total;
      result.effectiveLimitKnown =
        (result.effectiveLimitKnown ?? true) && sample.effectiveLimitKnown;
      if (!sample.effectiveLimitKnown && !result.missing.includes('effective memory limit'))
        result.missing.push('effective memory limit');
      result.memoryQuality = sample.memoryQuality;
      result.samples++;
      result.peakRss = Math.max(result.peakRss, rss);
      result.minAvailable = Math.min(result.minAvailable, sample.available);
      result.firstPaging ??= sample.paging;
      result.lastPaging = sample.paging;
      if (Object.keys(result.phases).length >= 128 && !result.phases[phase])
        throw new Error('Phase count bound exceeded');
      const p = (result.phases[phase] ??= {
        samples: 0,
        peakRss: 0,
        minAvailable: Number.MAX_SAFE_INTEGER,
      });
      p.samples++;
      p.peakRss = Math.max(p.peakRss, rss);
      p.minAvailable = Math.min(p.minAvailable, sample.available);
      if (!sample.paging && !result.missing.includes('attributable paging I/O'))
        result.missing.push('attributable paging I/O');
    } catch (e) {
      if (result.missing.length < 8 && !result.missing.includes(e.message))
        result.missing.push(e.message.slice(0, 200));
    }
    // Bounded aggregate only, no growing sample trace. Parent writes control atomically.
    await writeFile(output + '.next', JSON.stringify({ ...result, first }, null, 2) + '\n');
    await rename(output + '.next', output);
    first = false;
    await setTimeout(process.platform === 'win32' ? 1000 : 200);
  }
  result.finished = new Date().toISOString();
  result.pagingDelta =
    result.firstPaging && result.lastPaging
      ? {
          input: result.lastPaging.input - result.firstPaging.input,
          output: result.lastPaging.output - result.firstPaging.output,
          scope: 'system; attribution not proven',
        }
      : null;
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await observe(process.argv[2], process.argv[3]);
