// Mocha regression tests; included by the existing tests/**/*.test.ts command.
// Real source functions run in a VM with fake time and no service imports.
import { it as test } from 'mocha';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

class Clock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { fn: () => void; due: number; interval: number }>();
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, 0);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clear = (id: number) => this.timers.delete(id);
  add(fn: () => void, ms: number, interval: number) {
    const id = this.nextId++;
    this.timers.set(id, { fn, due: this.now + ms, interval });
    return id;
  }
  async flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async advance(ms: number) {
    const target = this.now + ms;
    await this.flush();
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else this.timers.delete(id);
      timer.fn();
      await this.flush();
    }
    this.now = target;
    await this.flush();
  }
}

function loadSelected(relativePath: string, names: string[], expose: string[], clock: Clock): any {
  const filename = path.resolve(testDirectory, '../..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const selected: string[] = [];
  for (const node of ast.statements) {
    const declared = ts.isFunctionDeclaration(node) ? [node.name?.text]
      : ts.isVariableStatement(node)
        ? node.declarationList.declarations.map(d => d.name.getText(ast)) : [];
    if (declared.some(name => typeof name === 'string' && names.includes(name))) {
      for (const name of declared) if (typeof name === 'string' && names.includes(name)) found.add(name);
      selected.push(node.getText(ast));
    }
  }
  assert.deepEqual([...found].sort(), [...names].sort(), 'source extraction must find every dependency');
  const input = selected.join('\n').replace(/\bexport\s+/g, '')
    + `\n globalThis.subject = { ${expose.join(',')} };`;
  const js = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({
    Date: { now: () => clock.now },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clear, clearInterval: clock.clear,
    console: { log() {}, warn() {}, error() {} },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(js, context, { timeout: 1000 });
  return context.subject;
}

function scheduler(clock: Clock) {
  return loadSelected('src/services/ChainSyncService/index.ts',
    ['startTask', 'stopTask'], ['startTask', 'stopTask'], clock);
}

function rpc(clock: Clock) {
  return loadSelected('src/utils/rpcProvider.ts', [
    'MIN_CALL_GAP_MS', 'nextSlotAt', 'throttle', 'rateLimitedUntil',
    'backoffMs', 'consecutiveSuccesses', 'consecutiveMaxBackoffs',
    'MAX_BACKOFF_MS', 'SUCCESSES_BEFORE_BACKOFF_RESET',
    'MAX_BACKOFFS_BEFORE_CIRCUIT_OPEN', 'CIRCUIT_OPEN_MS',
    'recordRateLimit', 'clearRateLimit', 'isRateLimited', 'waitForRateLimit',
    'isRateLimitError', 'BLOCK_NUMBER_TTL_MS', 'blockNumberCache',
    'getProviderUrl', 'wrapDestroy', 'wrapSend',
  ], ['wrapSend', 'recordRateLimit', 'isRateLimited'], clock);
}

test('control: completed sync runs again and stopped timer stays stopped', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let beats = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => { calls++; } };
  subject.startTask(task, () => beats++);
  await clock.advance(60000);
  assert.equal(calls, 2);
  assert.equal(beats, 2);
  subject.stopTask(task);
  await clock.advance(120000);
  assert.equal(calls, 2);
});

test('regression: slow L2 sync must not overlap the next scheduled sync', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => clock.setTimeout(resolve, 90000));
    active--;
  } };
  subject.startTask(task, () => {});
  await clock.advance(61000);
  subject.stopTask(task);
  assert.equal(maximum, 1, `concurrent syncs=${maximum}; starts=${calls}`);
});

test('control: a rate-limit wait delays the mocked RPC until its deadline', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  subject.recordRateLimit();
  const pending = provider.send('eth_getLogs', []);
  await clock.advance(4999);
  assert.deepEqual(sent, []);
  await clock.advance(1);
  assert.equal(await pending, 'ok');
  assert.deepEqual(sent, [5000]);
});

test('regression: an extended rate-limit deadline must delay already waiting RPCs', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  subject.recordRateLimit(); // deadline 5000
  const pending = provider.send('eth_getLogs', []);
  await clock.advance(1000);
  subject.recordRateLimit(); // extended deadline 11000
  await clock.advance(4000);
  const premature = sent.slice();
  await clock.advance(6000);
  await pending;
  assert.deepEqual(premature, [], `request escaped the extended cooldown at ${premature}ms`);
  assert.deepEqual(sent, [11000]);
});

test('sync guard is released after rejection so the next tick can recover', async () => {
  const clock = new Clock();
  const subject = scheduler(clock);
  let calls = 0;
  let beats = 0;
  const task = { name: 'L2Events', interval: 60000, sync: async () => {
    if (++calls === 1) throw new Error('mock RPC failure');
  } };
  subject.startTask(task, () => beats++);
  await clock.advance(60000);
  subject.stopTask(task);
  assert.equal(calls, 2);
  assert.equal(beats, 1);
});

test('a rate limit set while queued in the throttle is respected before send', async () => {
  const clock = new Clock();
  const subject = rpc(clock);
  const sent: number[] = [];
  const provider = subject.wrapSend({ send: async () => { sent.push(clock.now); return 'ok'; } });
  const first = provider.send('eth_getLogs', []);
  await clock.flush();
  const second = provider.send('eth_getLogs', []);
  await clock.flush();
  subject.recordRateLimit();
  await clock.advance(150);
  assert.deepEqual(sent, [0]);
  await clock.advance(4850);
  await Promise.all([first, second]);
  assert.deepEqual(sent, [0, 5000]);
});
