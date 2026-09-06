/*---------------------------------------------------------------------------
 * Transport between the adapter and ascend-gdb.
 *
 * Owns exactly three things:
 *   - spawning the debugger (through wsl.exe when the guest is WSL),
 *   - framing stdout into lines and turning them into MiRecords,
 *   - matching `^done`/`^error` replies to the command that caused them via
 *     the MI token, so concurrent DAP requests cannot cross-talk.
 *
 * It knows nothing about DAP. Everything above this layer talks in MI records.
 *-------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { MiRecord, MiRecordType, miString, parseMiLine } from './miParser';

export interface MiLaunchSpec {
	/** Executable to spawn on the host (wsl.exe, or the debugger itself). */
	command: string;
	args: string[];
	/** Host-side cwd for the spawn. Irrelevant to the guest's own cwd. */
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export class MiError extends Error {
	constructor(message: string, public readonly record: MiRecord, public readonly command: string) {
		super(message);
		this.name = 'MiError';
	}
}

interface PendingCommand {
	command: string;
	resolve: (record: MiRecord) => void;
	reject: (err: Error) => void;
}

/** Emitted for `*stopped`, `=thread-created`, stream records, and process exit. */
export declare interface MiConnection {
	on(event: 'exec', listener: (record: MiRecord) => void): this;
	on(event: 'notify', listener: (record: MiRecord) => void): this;
	on(event: 'status', listener: (record: MiRecord) => void): this;
	on(event: 'console', listener: (text: string) => void): this;
	on(event: 'target', listener: (text: string) => void): this;
	on(event: 'log', listener: (text: string) => void): this;
	/** Output that is not MI at all - almost always the debuggee's own stdout. */
	on(event: 'inferior', listener: (text: string) => void): this;
	on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
	on(event: 'error', listener: (err: Error) => void): this;
}

/** Printed by our shell wrapper so that Pause can signal GDB inside the guest. */
const GUEST_PID_MARKER = '__ASCEND_GDB_PID__:';

export class MiConnection extends EventEmitter {
	private proc?: ChildProcess;
	private stdoutBuffer = '';
	private stderrBuffer = '';
	private token = 0;
	private readonly pending = new Map<number, PendingCommand>();
	private guestPid?: number;
	private exited = false;

	/** Set by the owner to mirror the MI dialogue into the Debug Console. */
	public engineLogging = false;
	public onEngineLog?: (text: string) => void;

	public get isRunning(): boolean {
		return !!this.proc && !this.exited;
	}

	/** PID of ascend-gdb *inside the guest*, when the wrapper reported it. */
	public get debuggerGuestPid(): number | undefined {
		return this.guestPid;
	}

	/**
	 * Spawn the debugger and resolve once it has produced its first `(gdb)`
	 * prompt, i.e. once MI is actually usable.
	 */
	public async start(spec: MiLaunchSpec, timeoutMs = 30000): Promise<void> {
		this.log(`spawn: ${spec.command} ${spec.args.map(quoteForLog).join(' ')}\n`);

		const proc = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			// wsl.exe does its own argument handling; never let cmd.exe near it.
			windowsHide: true,
			shell: false,
		});
		this.proc = proc;

		proc.stdout?.setEncoding('utf8');
		proc.stderr?.setEncoding('utf8');
		proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr?.on('data', (chunk: string) => this.onStderr(chunk));

		proc.on('error', (err) => {
			this.emit('error', err);
			this.failAllPending(err);
		});
		proc.on('exit', (code, signal) => {
			this.exited = true;
			this.failAllPending(new Error(`Debugger exited (code=${code}, signal=${signal})`));
			this.emit('exit', code, signal);
		});

		await this.waitForPrompt(timeoutMs);
	}

	private waitForPrompt(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(new Error(
					`Timed out after ${timeoutMs}ms waiting for the debugger prompt. ` +
					`Check that the debugger exists inside the guest and that the CANN setup script is valid.`));
			}, timeoutMs);

			const onPrompt = () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve();
			};
			const onExit = (code: number | null) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(new Error(
					`Debugger exited with code ${code} before producing a prompt.` +
					(this.stderrBuffer ? `\n${this.stderrBuffer.trim()}` : '')));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.removeListener('__prompt', onPrompt);
				this.removeListener('exit', onExit);
			};

			this.once('__prompt', onPrompt);
			this.once('exit', onExit);
		});
	}

	/**
	 * Send one MI command and wait for its result record.
	 * `^error` becomes a rejected MiError carrying GDB's own message.
	 */
	public sendCommand(command: string): Promise<MiRecord> {
		if (!this.proc || this.exited || !this.proc.stdin?.writable) {
			return Promise.reject(new Error(`Cannot send "${command}": the debugger is not running.`));
		}
		const token = ++this.token;
		const line = `${token}${command}\n`;

		return new Promise<MiRecord>((resolve, reject) => {
			this.pending.set(token, { command, resolve, reject });
			this.log(`--> ${line}`);
			this.proc!.stdin!.write(line, (err) => {
				if (err) {
					this.pending.delete(token);
					reject(err);
				}
			});
		});
	}

	/** Send a command and swallow `^error`, for best-effort setup steps. */
	public async sendCommandIgnoringErrors(command: string): Promise<MiRecord | undefined> {
		try {
			return await this.sendCommand(command);
		} catch (err) {
			this.log(`(ignored) ${command}: ${(err as Error).message}\n`);
			return undefined;
		}
	}

	/** Run a human-readable GDB command through MI and capture its console output. */
	public async sendCliCommand(text: string): Promise<string> {
		const captured: string[] = [];
		const collect = (s: string) => captured.push(s);
		this.on('console', collect);
		try {
			await this.sendCommand(`-interpreter-exec console ${quoteMiString(text)}`);
		} finally {
			this.removeListener('console', collect);
		}
		return captured.join('');
	}

	/**
	 * Interrupt the debuggee. Prefers `-exec-interrupt`; when the target is not
	 * async-capable that fails, and we fall back to signalling GDB inside the
	 * guest - Node cannot deliver SIGINT across the WSL, container or SSH
	 * boundary itself.
	 */
	public async interrupt(
		signalArgv?: string[],
		signalEnv?: NodeJS.ProcessEnv,
	): Promise<boolean> {
		try {
			await this.sendCommand('-exec-interrupt --all');
			return true;
		} catch {
			// fall through
		}
		if (signalArgv && this.guestPid !== undefined) {
			const argv = signalArgv.concat(['kill', '-INT', String(this.guestPid)]);
			this.log(`interrupt fallback: ${argv.join(' ')}\n`);
			try {
				// signalEnv carries SSHPASS in ssh mode; every other mode inherits
				// the adapter's own environment unchanged.
				spawn(argv[0], argv.slice(1), {
					windowsHide: true,
					stdio: 'ignore',
					env: signalEnv ?? process.env,
				}).unref();
				return true;
			} catch (err) {
				this.log(`interrupt fallback failed: ${(err as Error).message}\n`);
			}
		}
		return false;
	}

	public async stop(): Promise<void> {
		if (!this.proc || this.exited) {
			return;
		}
		await this.sendCommandIgnoringErrors('-gdb-exit');
		// -gdb-exit does not always reply; give it a moment, then be blunt.
		await new Promise<void>((resolve) => {
			if (this.exited) {
				return resolve();
			}
			const timer = setTimeout(() => {
				try {
					this.proc?.kill();
				} catch {
					/* already gone */
				}
				resolve();
			}, 1500);
			this.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/* --------------------------- stream handling -------------------------- */

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let nl: number;
		while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			if (line.length) {
				this.handleLine(line);
			}
		}
	}

	private onStderr(chunk: string): void {
		this.stderrBuffer += chunk;
		if (this.stderrBuffer.length > 8192) {
			this.stderrBuffer = this.stderrBuffer.slice(-8192);
		}
		let rest = chunk;
		const idx = chunk.indexOf(GUEST_PID_MARKER);
		if (idx >= 0) {
			const m = /__ASCEND_GDB_PID__:(\d+)/.exec(chunk);
			if (m) {
				this.guestPid = Number(m[1]);
				this.log(`guest debugger pid: ${this.guestPid}\n`);
			}
			rest = chunk.replace(/__ASCEND_GDB_PID__:\d+\r?\n?/g, '');
		}
		if (rest.trim()) {
			this.emit('inferior', rest);
		}
	}

	private handleLine(line: string): void {
		const record = parseMiLine(line);
		if (this.engineLogging && record.type !== MiRecordType.Prompt) {
			this.log(`<-- ${line}\n`);
		}

		switch (record.type) {
			case MiRecordType.Prompt:
				this.emit('__prompt');
				return;

			case MiRecordType.Result: {
				const cls = record.class ?? '';
				if (record.token !== undefined) {
					const pending = this.pending.get(record.token);
					if (pending) {
						this.pending.delete(record.token);
						if (cls === 'error') {
							const msg = miString(record.results['msg'], 'GDB reported an error');
							pending.reject(new MiError(msg, record, pending.command));
						} else {
							pending.resolve(record);
						}
						return;
					}
				}
				// Unsolicited result record (e.g. from a console-issued command).
				this.emit('notify', record);
				return;
			}

			case MiRecordType.ExecAsync:
				this.emit('exec', record);
				return;

			case MiRecordType.NotifyAsync:
				this.emit('notify', record);
				return;

			case MiRecordType.StatusAsync:
				this.emit('status', record);
				return;

			case MiRecordType.ConsoleStream:
				this.emit('console', record.text ?? '');
				return;

			case MiRecordType.TargetStream:
				this.emit('target', record.text ?? '');
				return;

			case MiRecordType.LogStream:
				this.emit('log', record.text ?? '');
				return;

			default:
				// Not MI. Under WSL the debuggee shares GDB's stdout, so this is
				// where the kernel's own printf output surfaces.
				this.emit('inferior', line + '\n');
				return;
		}
	}

	private failAllPending(err: Error): void {
		for (const [, p] of this.pending) {
			p.reject(err);
		}
		this.pending.clear();
	}

	private log(text: string): void {
		if (this.engineLogging) {
			this.onEngineLog?.(text);
		}
	}
}

/** Quote a string for use as an MI c-string argument. */
export function quoteMiString(text: string): string {
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quoteForLog(arg: string): string {
	return /\s/.test(arg) ? `"${arg}"` : arg;
}
