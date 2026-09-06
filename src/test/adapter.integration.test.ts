/*---------------------------------------------------------------------------
 * End-to-end test of the adapter process.
 *
 * Spawns out/debugAdapter.js exactly as VS Code would, speaks real DAP over
 * stdio, and points the launch configuration at fakeGdb.js instead of
 * ascend-gdb. Everything in between is the production code path.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DebugProtocol } from '@vscode/debugprotocol';

const OUT_DIR = join(__dirname, '..');
const ADAPTER = join(OUT_DIR, 'debugAdapter.js');
const FAKE_GDB_JS = join(__dirname, 'fakeGdb.js');
const HOST_SOURCE = 'D:\\Projects\\vllm-ascend\\csrc\\tests\\add_custom.cpp';

/** Minimal DAP client: Content-Length framing over the adapter's stdio. */
class DapClient {
	private buffer = Buffer.alloc(0);
	private seq = 1;
	private readonly pending = new Map<number, {
		resolve: (r: DebugProtocol.Response) => void;
		reject: (e: Error) => void;
	}>();
	private readonly events: DebugProtocol.Event[] = [];
	private readonly eventWaiters: Array<{ event: string; resolve: (e: DebugProtocol.Event) => void }> = [];

	constructor(private readonly proc: ChildProcess) {
		proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
	}

	public send<T extends DebugProtocol.Response>(command: string, args?: unknown): Promise<T> {
		const request: DebugProtocol.Request = {
			seq: this.seq++, type: 'request', command, arguments: args,
		};
		const json = JSON.stringify(request);
		this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
		return new Promise((resolve, reject) => {
			this.pending.set(request.seq, { resolve: resolve as never, reject });
		});
	}

	public waitForEvent(event: string, timeoutMs = 5000): Promise<DebugProtocol.Event> {
		const already = this.events.find((e) => e.event === event);
		if (already) {
			return Promise.resolve(already);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for "${event}" event`)), timeoutMs);
			this.eventWaiters.push({
				event,
				resolve: (e) => {
					clearTimeout(timer);
					resolve(e);
				},
			});
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString('utf8');
			const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) {
				return;
			}
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.dispatch(JSON.parse(body));
		}
	}

	private dispatch(message: DebugProtocol.ProtocolMessage): void {
		if (message.type === 'response') {
			const response = message as DebugProtocol.Response;
			const pending = this.pending.get(response.request_seq);
			if (pending) {
				this.pending.delete(response.request_seq);
				pending.resolve(response);
			}
			return;
		}
		if (message.type === 'event') {
			const event = message as DebugProtocol.Event;
			this.events.push(event);
			const index = this.eventWaiters.findIndex((w) => w.event === event.event);
			if (index >= 0) {
				this.eventWaiters.splice(index, 1)[0].resolve(event);
			}
		}
	}
}

let adapter: ChildProcess;
let client: DapClient;

before(async () => {
	adapter = spawn(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'pipe'] });
	adapter.stderr!.on('data', (d: Buffer) => process.stderr.write(`[adapter] ${d}`));
	client = new DapClient(adapter);

	const init = await client.send<DebugProtocol.InitializeResponse>('initialize', {
		adapterID: 'ascend-gdb',
		linesStartAt1: true,
		columnsStartAt1: true,
		pathFormat: 'path',
		supportsMemoryReferences: true,
	});
	assert.ok(init.success, 'initialize failed');
	assert.equal(init.body?.supportsReadMemoryRequest, true);
	assert.equal(init.body?.supportsWriteMemoryRequest, true);

	const launched = client.send<DebugProtocol.LaunchResponse>('launch', {
		type: 'ascend-gdb',
		request: 'launch',
		name: 'test',
		program: 'D:\\Projects\\vllm-ascend\\csrc\\tests\\build\\test_kernel',
		cwd: 'D:\\Projects\\vllm-ascend\\csrc\\tests',
		// Run the fake through Node itself: gdbArgs precede --interpreter, so
		// this becomes `node fakeGdb.js --interpreter=mi2 -q`.
		gdbPath: process.execPath,
		gdbArgs: [FAKE_GDB_JS],
		// No WSL indirection for the fake, but path translation stays on -
		// the same combination a Windows host uses against a remote gdbserver.
		wsl: { enabled: false },
		pathTranslation: 'on',
		sourceFileMap: { '/mnt/d/Projects/vllm-ascend': 'D:\\Projects\\vllm-ascend' },
		npuMemoryRegions: [{ name: 'UB', address: '0x2000', size: 16, description: 'Unified Buffer' }],
	});

	await client.waitForEvent('initialized');

	const breakpoints = await client.send<DebugProtocol.SetBreakpointsResponse>('setBreakpoints', {
		source: { path: HOST_SOURCE },
		breakpoints: [{ line: 42 }],
	});
	assert.ok(breakpoints.success, `setBreakpoints failed: ${breakpoints.message}`);
	assert.equal(breakpoints.body.breakpoints[0].verified, true,
		'breakpoint was rejected - the Windows path was probably not translated');

	await client.send('configurationDone', {});
	await launched;
	await client.waitForEvent('stopped');
});

after(async () => {
	try {
		await client.send('disconnect', { terminateDebuggee: true });
	} catch {
		/* adapter may already be gone */
	}
	adapter?.kill();
});

test('translates the Windows breakpoint path into the guest and back', async () => {
	const response = await client.send<DebugProtocol.SetBreakpointsResponse>('setBreakpoints', {
		source: { path: HOST_SOURCE },
		breakpoints: [{ line: 42 }],
	});
	const bp = response.body.breakpoints[0];
	assert.equal(bp.verified, true);
	assert.equal(bp.line, 42);
	// fullname came back from GDB as /mnt/d/... and must reach VS Code as D:\...
	assert.equal(bp.source?.path, HOST_SOURCE);
});

test('reports threads and a mapped call stack', async () => {
	const threads = await client.send<DebugProtocol.ThreadsResponse>('threads');
	assert.equal(threads.body.threads[0].id, 1);
	assert.equal(threads.body.threads[0].name, 'aicore0');

	const stack = await client.send<DebugProtocol.StackTraceResponse>('stackTrace', {
		threadId: 1, startFrame: 0, levels: 20,
	});
	assert.equal(stack.body.totalFrames, 2);
	assert.equal(stack.body.stackFrames[0].name, 'AddCustom');
	assert.equal(stack.body.stackFrames[0].line, 42);
	assert.equal(stack.body.stackFrames[0].source?.path, HOST_SOURCE);
	assert.equal(stack.body.stackFrames[0].instructionPointerReference, '0x0000000000400546');
});

test('exposes Locals, Arguments, Registers and NPU Memory scopes', async () => {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const names = scopes.body.scopes.map((s) => s.name);
	assert.deepEqual(names, ['Locals', 'Arguments', 'Registers', 'NPU Memory']);
});

test('renders locals with a memoryReference for pointers', async () => {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const locals = scopes.body.scopes.find((s) => s.name === 'Locals')!;

	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: locals.variablesReference,
	});
	const byName = new Map(variables.body.variables.map((v) => [v.name, v]));

	const xGm = byName.get('xGm');
	assert.ok(xGm, 'xGm missing from Locals');
	assert.equal(xGm.type, '__gm__ half *');
	assert.equal(xGm.evaluateName, 'xGm');
	// A pointer resolves to what it points at, so the hex editor opens the buffer.
	assert.equal(xGm.memoryReference, '0x2000');

	// A plain int is not worth an extra round trip in "auto" mode.
	const loopCount = byName.get('loopCount');
	assert.ok(loopCount);
	assert.equal(loopCount.value, '8');
	assert.equal(loopCount.memoryReference, undefined);

	// Arguments live in their own scope, not in Locals.
	assert.equal(byName.has('tiling'), false);
});

test('expands an aggregate argument through varobj children', async () => {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const args = scopes.body.scopes.find((s) => s.name === 'Arguments')!;

	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: args.variablesReference,
	});
	const tiling = variables.body.variables.find((v) => v.name === 'tiling');
	assert.ok(tiling, 'tiling argument missing');
	assert.ok(tiling.variablesReference > 0, 'tiling should be expandable');
	assert.equal(tiling.memoryReference, '0x7ffd19169010');

	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: tiling.variablesReference,
	});
	assert.deepEqual(
		children.body.variables.map((v) => v.name), ['totalLength', 'tileNum']);
	assert.equal(children.body.variables[0].value, '1024');
});

test('serves the native Hex Editor from -data-read-memory-bytes', async () => {
	const response = await client.send<DebugProtocol.ReadMemoryResponse>('readMemory', {
		memoryReference: '0x2000',
		offset: 0,
		count: 16,
	});
	assert.ok(response.success, `readMemory failed: ${response.message}`);
	assert.equal(response.body!.address, '0x2000');
	assert.equal(response.body!.unreadableBytes ?? 0, 0);

	const bytes = Buffer.from(response.body!.data!, 'base64');
	assert.equal(bytes.length, 16);
	assert.deepEqual([...bytes], [...Array(16).keys()]);
});

test('reports unmapped NPU memory as unreadable instead of failing', async () => {
	const response = await client.send<DebugProtocol.ReadMemoryResponse>('readMemory', {
		memoryReference: '0xdeadbeef',
		count: 32,
	});
	assert.ok(response.success, 'an unreadable window should not fail the request');
	assert.equal(response.body!.data, '');
	assert.equal(response.body!.unreadableBytes, 32);
});

test('publishes configured NPU regions as addressable entries', async () => {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const npu = scopes.body.scopes.find((s) => s.name === 'NPU Memory')!;

	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: npu.variablesReference,
	});
	const ub = variables.body.variables[0];
	assert.equal(ub.name, 'UB');
	assert.equal(ub.memoryReference, '0x2000');
	assert.match(ub.value, /16 B/);
});

test('registers holding addresses get a memoryReference', async () => {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const registers = scopes.body.scopes.find((s) => s.name === 'Registers')!;

	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: registers.variablesReference,
	});
	const byName = new Map(variables.body.variables.map((v) => [v.name, v]));
	assert.equal(byName.get('x0')?.memoryReference, '0x2000');
	// A zero register points nowhere useful, so it gets no reference.
	assert.equal(byName.get('x1')?.memoryReference, undefined);
	assert.equal(byName.get('pc')?.value, '0x400546');
});

test('replaces the broken std::vector summary with synthetic children', async () => {
	const scores = await local('scores');

	// The debugger's own answer here is "error: summary string parsing error"
	// over a single _Vector_base child. None of that should reach the user.
	assert.equal(scores.value, '{ size=4 }');
	assert.equal(scores.type, 'std::vector<float, std::allocator<float> >');
	assert.equal(scores.evaluateName, 'scores');
	assert.equal(scores.indexedVariables, 4);
	// The payload, not the address of the three-pointer header.
	assert.equal(scores.memoryReference, '0x2000');
	assert.ok(scores.variablesReference > 0, 'a non-empty vector must be expandable');

	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: scores.variablesReference,
	});
	assert.deepEqual(children.body.variables.map((v) => v.name), ['[0]', '[1]', '[2]', '[3]']);
	assert.deepEqual(children.body.variables.map((v) => v.value), ['0.5', '1.5', '2.5', '3.5']);

	const first = children.body.variables[0];
	assert.equal(first.type, 'float');
	// Re-evaluatable, so Add to Watch and Copy Value work on an element.
	assert.equal(first.evaluateName, '*((scores)._M_impl._M_start + 0)');
	// A float is a leaf: offering an expander would dead-end.
	assert.equal(first.variablesReference, 0);

	// Addresses are arithmetic off the payload base - 4 bytes per float - so
	// every element opens the Hex Editor at the right place.
	assert.deepEqual(
		children.body.variables.map((v) => v.memoryReference),
		['0x2000', '0x2004', '0x2008', '0x200c']);
});

test('a paged request reads only that page', async () => {
	const scores = await local('scores');

	const page = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: scores.variablesReference,
		filter: 'indexed',
		start: 1,
		count: 2,
	});
	assert.deepEqual(page.body.variables.map((v) => v.name), ['[1]', '[2]']);
	// fakeGdb derives each value from the absolute index it was asked for, so
	// these values prove the offset reached the MI command itself rather than
	// the adapter fetching all four and slicing afterwards.
	assert.deepEqual(page.body.variables.map((v) => v.value), ['1.5', '2.5']);
	assert.deepEqual(page.body.variables.map((v) => v.memoryReference), ['0x2004', '0x2008']);

	// Synthetic children are all indexed; a named-filter request has nothing
	// to answer with and must not return the indexed ones.
	const named = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: scores.variablesReference,
		filter: 'named',
	});
	assert.deepEqual(named.body.variables, []);
});

test('falls back to one read per element when the array cast is rejected', async () => {
	// `weights` is the vector fakeGdb refuses to build an array type for -
	// the behaviour seen with opaque and locally-defined element types.
	const weights = await local('weights');
	assert.equal(weights.value, '{ size=3 }');
	assert.equal(weights.memoryReference, '0x3000');

	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: weights.variablesReference,
	});
	assert.deepEqual(children.body.variables.map((v) => v.name), ['[0]', '[1]', '[2]']);
	assert.deepEqual(children.body.variables.map((v) => v.value), ['100.25', '101.25', '102.25']);
	assert.equal(children.body.variables[0].type, 'double');
	// 8-byte elements this time.
	assert.deepEqual(
		children.body.variables.map((v) => v.memoryReference),
		['0x3000', '0x3008', '0x3010']);
});

test('a synthetic element expands back into the debugger', async () => {
	// The nested case: the formatter hands out a reference for an element it
	// has never evaluated, and expanding it re-enters the pipeline one level
	// down. Nothing is evaluated until this request arrives.
	const tilings = await local('tilings');
	assert.equal(tilings.value, '{ size=2 }');
	assert.equal(tilings.memoryReference, '0x4000');

	const elements = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: tilings.variablesReference,
	});
	assert.deepEqual(elements.body.variables.map((v) => v.name), ['[0]', '[1]']);
	const second = elements.body.variables[1];
	assert.ok(second.variablesReference > 0, 'a struct element must be expandable');
	// 8-byte structs, so the second one starts one stride in.
	assert.equal(second.memoryReference, '0x4008');

	const fields = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: second.variablesReference,
	});
	assert.deepEqual(fields.body.variables.map((v) => v.name), ['totalLength', 'tileNum']);
	assert.equal(fields.body.variables[0].value, '2048');
	// The path expression is rebuilt through the element, so the field is
	// addressable in its own right rather than being a dead label.
	assert.equal(fields.body.variables[1].evaluateName,
		'(*((tilings)._M_impl._M_start + 1)).tileNum');
});

test('a watchpoint can be set on a synthetic element', async () => {
	const scores = await local('scores');
	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: scores.variablesReference,
	});

	const info = await client.send<DebugProtocol.DataBreakpointInfoResponse>('dataBreakpointInfo', {
		variablesReference: scores.variablesReference,
		name: children.body.variables[2].name,
	});
	// The element's expression, not the literal row label "[2]".
	assert.equal(info.body.dataId, '*((scores)._M_impl._M_start + 2)');
});

/** One local by name, re-read from a fresh scope each time. */
async function local(name: string): Promise<DebugProtocol.Variable> {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const locals = scopes.body.scopes.find((s) => s.name === 'Locals')!;
	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: locals.variablesReference,
	});
	const found = variables.body.variables.find((v) => v.name === name);
	assert.ok(found, `${name} missing from Locals`);
	return found;
}

async function topFrameId(): Promise<number> {
	const stack = await client.send<DebugProtocol.StackTraceResponse>('stackTrace', {
		threadId: 1, startFrame: 0, levels: 1,
	});
	return stack.body.stackFrames[0].id;
}
