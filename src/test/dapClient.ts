/*---------------------------------------------------------------------------
 * A minimal DAP client, and the fixture that puts a live adapter behind it.
 *
 * Shared by the integration tests so that a second one - which needs its own
 * adapter process, launched with different options - does not have to
 * duplicate the protocol plumbing.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { DebugProtocol } from '@vscode/debugprotocol';

const OUT_DIR = join(__dirname, '..');
export const ADAPTER = join(OUT_DIR, 'debugAdapter.js');
export const FAKE_GDB_JS = join(__dirname, 'fakeGdb.js');
export const HOST_SOURCE = 'D:\\Projects\\vllm-ascend\\csrc\\tests\\add_custom.cpp';

/** Minimal DAP client: Content-Length framing over the adapter's stdio. */
export class DapClient {
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
		return this.waitForNextEvent(event, timeoutMs);
	}

	/**
	 * Wait for the *next* occurrence, ignoring any already seen. Stepping needs
	 * this: the session has stopped once already, so waitForEvent('stopped')
	 * would return that first stop immediately.
	 */
	public waitForNextEvent(event: string, timeoutMs = 5000): Promise<DebugProtocol.Event> {
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

	/**
	 * Everything the adapter has printed so far in one category, concatenated
	 * the way the Debug Console would show it.
	 */
	public output(category: 'stdout' | 'stderr' | 'console'): string {
		return this.events
			.filter((e) => e.event === 'output')
			.map((e) => (e as DebugProtocol.OutputEvent).body)
			.filter((body) => (body.category ?? 'console') === category)
			.map((body) => body.output)
			.join('');
	}

	/** Bodies of a custom event, in arrival order. */
	public custom(event: string): unknown[] {
		return this.events.filter((e) => e.event === event).map((e) => e.body);
	}

	/** The MI dialogue the adapter has published, concatenated. */
	public traceLog(): string {
		return this.custom('ascend.miTrace')
			.map((body) => (body as { log?: string }).log ?? '')
			.join('');
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

export interface Fixture {
	adapter: ChildProcess;
	client: DapClient;
}

/**
 * Spawn the adapter exactly as VS Code would, launch it against fakeGdb, and
 * run it up to the first breakpoint. `extra` is merged into the launch
 * configuration, which is how a test asks for a different logging policy.
 */
export async function launchFixture(extra: Record<string, unknown> = {}): Promise<Fixture> {
	const adapter = spawn(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'pipe'] });
	adapter.stderr!.on('data', (d: Buffer) => process.stderr.write(`[adapter] ${d}`));
	const client = new DapClient(adapter);

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
		...extra,
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

	return { adapter, client };
}

/** Best-effort teardown; the adapter may already have exited. */
export async function closeFixture(fixture: Fixture | undefined): Promise<void> {
	if (!fixture) {
		return;
	}
	try {
		await fixture.client.send('disconnect', { terminateDebuggee: true });
	} catch {
		/* adapter may already be gone */
	}
	fixture.adapter.kill();
}
