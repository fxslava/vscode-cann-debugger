/*---------------------------------------------------------------------------
 * End-to-end test of the adapter process.
 *
 * Spawns out/debugAdapter.js exactly as VS Code would, speaks real DAP over
 * stdio, and points the launch configuration at fakeGdb.js instead of
 * ascend-gdb. Everything in between is the production code path.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DebugProtocol } from '@vscode/debugprotocol';

import { closeFixture, DapClient, Fixture, HOST_SOURCE, launchFixture } from './dapClient';
import { decodeTensor, formatValue, gridShape, shapeElements } from '../tensorDecode';

let fixture: Fixture;
let client: DapClient;

before(async () => {
	fixture = await launchFixture();
	client = fixture.client;
});

after(() => closeFixture(fixture));

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

test('groups registers into folders instead of one flat wall', async () => {
	const folders = await registerFolders();
	assert.deepEqual(folders.map((f) => f.name),
		['Vector Registers', 'Scalar Registers', 'System Registers']);
	// Each folder says how much is inside without being opened.
	assert.equal(folders.find((f) => f.name === 'Vector Registers')!.value, '1 registers');
	assert.equal(folders.find((f) => f.name === 'Scalar Registers')!.value, '2 registers');
	assert.ok(folders.every((f) => f.variablesReference > 0), 'every folder must open');
});

test('registers holding addresses get a memoryReference', async () => {
	const scalars = await registersIn('Scalar Registers');
	assert.equal(scalars.get('x0')?.memoryReference, '0x2000');
	// A zero register points nowhere useful, so it gets no reference.
	assert.equal(scalars.get('x1')?.memoryReference, undefined);

	// pc is not general-purpose, so it files under System.
	const system = await registersIn('System Registers');
	assert.match(system.get('pc')!.value, /^0x400546/);
	assert.equal(system.has('cpsr'), true);
	// ...and the vector file is its own folder.
	const vectors = await registersIn('Vector Registers');
	assert.equal(vectors.has('v0'), true);
	assert.equal(vectors.has('x0'), false);
});

test('annotates the registers that hold a local variable', async () => {
	// The connection a register view cannot otherwise show: a local with no
	// address, because it lives in a register.
	const scalars = await registersIn('Scalar Registers');
	assert.equal(scalars.get('x0')!.value, '0x2000 [mapped to: xGm]');

	const vectors = await registersIn('Vector Registers');
	assert.equal(vectors.get('v0')!.value, '0x1234 [mapped to: scores]');

	// x29 is named by every stack local's `info address` answer, but holds
	// none of them: reading that as a binding would label it with the frame.
	const system = await registersIn('System Registers');
	assert.equal(/mapped to/.test(system.get('pc')!.value), false);
	assert.equal(scalars.get('x1')!.value, '0x0');
});

/** The Registers scope's folder rows. */
async function registerFolders(): Promise<DebugProtocol.Variable[]> {
	const frameId = await topFrameId();
	const scopes = await client.send<DebugProtocol.ScopesResponse>('scopes', { frameId });
	const registers = scopes.body.scopes.find((s) => s.name === 'Registers')!;
	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: registers.variablesReference,
	});
	return variables.body.variables;
}

/** The registers inside one folder, by name. */
async function registersIn(folder: string): Promise<Map<string, DebugProtocol.Variable>> {
	const folders = await registerFolders();
	const found = folders.find((f) => f.name === folder);
	assert.ok(found, `${folder} missing from the Registers scope`);
	const variables = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: found.variablesReference,
	});
	return new Map(variables.body.variables.map((v) => [v.name, v]));
}

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

test('formats a short std::string out of the local buffer', async () => {
	const label = await local('label');
	assert.equal(label.value, '"hello ascend"');
	assert.equal(label.evaluateName, 'label');
	// Short String Optimization: _M_p points into the object's own footprint,
	// so the characters are at 0x5010 while the object starts at 0x5000.
	assert.equal(label.memoryReference, '0x5010');

	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: label.variablesReference,
	});
	assert.deepEqual(children.body.variables.map((v) => v.name), ['[text]']);
	assert.equal(children.body.variables[0].value, '"hello ascend"');
	assert.equal(children.body.variables[0].type, 'char [12]');
	assert.equal(children.body.variables[0].evaluateName, '(label)._M_dataplus._M_p');
});

test('formats a heap-allocated std::string the same way', async () => {
	const banner = await local('banner');
	assert.equal(banner.value, '"Ascend C kernel: AddCustom"');
	// Past the local buffer, so _M_p points at the heap instead.
	assert.equal(banner.memoryReference, '0x6000');
});

test('declines a string whose length the local buffer could not hold', async () => {
	// _M_p points inside the object - the string is short - yet the length
	// field claims 99 characters. Trusting it would invent text out of stack
	// noise, so the raw members are shown instead.
	const scratch = await local('scratch');
	assert.equal(scratch.value, 'error: summary string parsing error');

	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: scratch.variablesReference,
	});
	assert.deepEqual(children.body.variables.map((v) => v.name), ['_M_dataplus']);
});

test('watch expressions go through the same formatters as the Variables view', async () => {
	const frameId = await topFrameId();

	const watch = await client.send<DebugProtocol.EvaluateResponse>('evaluate', {
		expression: 'scores', frameId, context: 'watch',
	});
	assert.equal(watch.body.result, '{ size=4 }');
	assert.equal(watch.body.indexedVariables, 4);
	assert.equal(watch.body.memoryReference, '0x2000');
	assert.ok(watch.body.variablesReference > 0, 'a watched vector should expand');

	// And it expands to the same synthetic children, not to _Vector_base.
	const children = await client.send<DebugProtocol.VariablesResponse>('variables', {
		variablesReference: watch.body.variablesReference,
	});
	assert.deepEqual(children.body.variables.map((v) => v.name), ['[0]', '[1]', '[2]', '[3]']);
});

test('hovers are formatted too', async () => {
	const frameId = await topFrameId();
	const hover = await client.send<DebugProtocol.EvaluateResponse>('evaluate', {
		expression: 'label', frameId, context: 'hover',
	});
	assert.equal(hover.body.result, '"hello ascend"');
});

test('the Tensor Inspector pipeline decodes a window read over DAP', async () => {
	// Exactly what the inspector does, minus the webview: ask the adapter for
	// a window, then decode it with the shape and type the user picked. The
	// fake serves bytes 0x00..0x0f at 0x2000, so a 4x4 of uint8 should come
	// back as four rows counting up.
	const shape = [4, 4];
	const response = await client.send<DebugProtocol.ReadMemoryResponse>('readMemory', {
		memoryReference: '0x2000',
		offset: 0,
		count: shapeElements(shape) * 1,
	});
	assert.ok(response.success, `readMemory failed: ${response.message}`);

	const bytes = Buffer.from(response.body!.data!, 'base64');
	const values = decodeTensor(bytes, 'uint8', shapeElements(shape));
	assert.deepEqual(values, [...Array(16).keys()]);

	const { rows, columns } = gridShape(shape);
	assert.deepEqual({ rows, columns }, { rows: 4, columns: 4 });
	// The third row of the grid, as the cells would read.
	const third = values.slice(2 * columns, 3 * columns).map((v) => formatValue(v, 'uint8'));
	assert.deepEqual(third, ['8', '9', '10', '11']);
});

test('the same window decodes differently when the type changes', async () => {
	// 16 bytes is 8 float16s or 4 float32s; the inspector re-reads with the
	// stride the type implies rather than reinterpreting a fixed count.
	const response = await client.send<DebugProtocol.ReadMemoryResponse>('readMemory', {
		memoryReference: '0x2000', offset: 0, count: 16,
	});
	const bytes = Buffer.from(response.body!.data!, 'base64');

	assert.equal(decodeTensor(bytes, 'float16', 8).length, 8);
	assert.equal(decodeTensor(bytes, 'float32', 4).length, 4);
	// 0x0100 as a half is a subnormal, which is what these bytes really are.
	assert.equal(decodeTensor(bytes, 'float16', 8)[0], 256 * 2 ** -24);
});

test('the Debug Console carries the kernel output and nothing else', async () => {
	// Everything the run emitted has already been collected: the fixture waits
	// for the stop, and these all arrived ahead of it.
	const stdout = client.output('stdout');
	// The @ target stream.
	assert.match(stdout, /AddCustom: tile 0 of 8/);
	// A plain non-MI line: under WSL the debuggee shares GDB's stdout.
	assert.match(stdout, /kernel printf via shared stdout/);

	const consoleText = client.output('console');
	// GDB's & log stream is its echo of our own commands - the actual flood.
	assert.equal(consoleText.includes('-stack-list-variables'), false,
		`MI traffic reached the console:\n${consoleText}`);
	// Its ~ console stream is chatter about GDB's own state.
	assert.equal(consoleText.includes('New Thread'), false);
	// And none of the dialogue the adapter itself drives.
	assert.equal(/-var-create|-exec-run|\^done|<--|-->/.test(consoleText), false,
		`MI dialogue reached the console:\n${consoleText}`);

	// The program's output must not be diverted into the trace instead.
	assert.equal(consoleText.includes('AddCustom: tile 0 of 8'), false);
});

test('the MI dialogue is published for the trace channel, not discarded', async () => {
	// Nothing is hidden - it is moved. The extension host appends these to the
	// "Ascend GDB Trace" output channel.
	const trace = client.traceLog();

	// Commands we sent, with the MI token the reply carries.
	assert.match(trace, /--> \d+-exec-run/);
	assert.match(trace, /--> \d+-break-insert/);
	// GDB's replies.
	assert.match(trace, /<-- \d+\^done/);
	// The & log stream, which is the thing that used to flood the console.
	assert.match(trace, /-stack-list-variables --thread 1/);
	// The ~ console stream.
	assert.match(trace, /New Thread 0x7ffd/);

	// The trace is a faithful transcript of the wire, so the debuggee's output
	// appears here too - but in its raw `@"..."` record form. What matters is
	// that the decoded text reaches the console as well, which is asserted
	// above; the trace is a copy, not a diversion.
	assert.match(trace, /<-- @"AddCustom: tile 0 of 8/);
});

test('a REPL command answers once, not twice', async () => {
	// The ~ stream carrying the answer is captured to become the result; if it
	// were also forwarded as output, every command would print twice.
	const before = client.output('console');
	const response = await client.send<DebugProtocol.EvaluateResponse>('evaluate', {
		expression: 'info registers',
		context: 'repl',
	});
	assert.ok(response.success, `repl evaluate failed: ${response.message}`);
	// The answer comes back as the result...
	assert.match(response.body.result, /x0\s+0x2000\s+8192/);
	// ...and not a second time as console output.
	assert.equal(client.output('console'), before);
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
