/*---------------------------------------------------------------------------
 * AscendDebugSession - the Debug Adapter Protocol implementation.
 *
 * Responsibilities, in the order they happen:
 *   launch/attach   spawn ascend-gdb inside WSL, load symbols, connect to the
 *                   simulator stub if one was configured
 *   breakpoints     translate Windows source paths to guest paths and insert
 *   execution       -exec-* commands, and *stopped -> StoppedEvent
 *   inspection      stackTrace / scopes / variables built on GDB varobjs
 *   memory          readMemory / writeMemory backed by -data-read-memory-bytes,
 *                   which is what wires the NPU buffers into the Hex Editor
 *-------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { basename } from 'path';
import {
	Breakpoint,
	ContinuedEvent,
	Event,
	Handles,
	InitializedEvent,
	LoggingDebugSession,
	Logger,
	logger,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread,
	ThreadEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import {
	AscendArguments,
	AscendAttachArguments,
	ExecutionMode,
	AscendLaunchArguments,
	DEFAULT_SETUP_COMMANDS,
	MI_TRACE_EVENT,
	MiTraceEventBody,
	NpuMemoryRegion,
	resolveExecutionMode,
	SetupCommand,
	shouldTranslatePaths,
} from './configuration';
import { MiConnection, MiError, quoteMiString } from './mi/miConnection';
import { miArray, miList, miNumber, miString, miTuple, MiRecord } from './mi/miParser';
import { PathMapper } from './pathMapper';
import {
	categorizeRegister,
	groupRegisters,
	parseRegisterBinding,
	RegisterGroup,
	REGISTER_GROUPS,
	renderRegisterValue,
} from './registers';
import { buildDebuggerSpawn, buildSignalEnv, buildSignalPrefix } from './wslLauncher';
import {
	classifyType,
	resolveMemoryAddress,
	VarObject,
	VarObjectManager,
} from './varObjects';
import {
	createDefaultFormatterRegistry,
	FormatterContext,
	FormatterView,
	ITypeFormatter,
	TypeFormatterRegistry,
} from './typeFormatters';

/* -------------------------------------------------------------------------
 * Handle payloads
 * ---------------------------------------------------------------------- */

interface FrameRef {
	threadId: number;
	level: number;
}

/** One folder of the Registers scope: vector, scalar or system. */
interface RegisterGroupContainer {
	kind: 'registerGroup';
	group: RegisterGroup;
	frame: FrameRef;
}

/** Children come straight from GDB's own varobj tree. */
interface VarobjContainer {
	kind: 'varobj';
	varobj: VarObject;
	frame: FrameRef;
}

/**
 * Children are synthesised by a formatter from an already-measured view.
 * `view.state` holds the formatter's paging state, so expanding page 20 of a
 * tensor is one MI round trip and no re-measurement.
 */
interface FormattedContainer {
	kind: 'formatted';
	formatter: ITypeFormatter;
	view: FormatterView;
	frame: FrameRef;
}

/**
 * A promise to expand `expression` if anyone ever asks - the hinge that lets a
 * formatter hand out a variablesReference for a child it has not looked at.
 * Resolving it re-enters the same "formatter, or native children?" decision
 * one level down, which is what makes a vector of structs - or of vectors -
 * keep working all the way down. The resolution is cached on the container
 * because VS Code pages: the first request measures, later ones reuse.
 */
interface ExpansionContainer {
	kind: 'expansion';
	expression: string;
	frame: FrameRef;
	resolved?: VarobjContainer | FormattedContainer | 'none';
}

type VariableContainer =
	| { kind: 'locals'; frame: FrameRef }
	| { kind: 'arguments'; frame: FrameRef }
	| { kind: 'registers'; frame: FrameRef }
	| RegisterGroupContainer
	| { kind: 'npu' }
	| VarobjContainer
	| FormattedContainer
	| ExpansionContainer;

/** What we remember about a rendered variable, for setVariable / data breakpoints. */
interface RenderedVariable {
	pathExpr: string;
	varobjName?: string;
	memoryReference?: string;
	byteSize?: number;
}

/** `memory` event: tells VS Code's Hex Editor to re-read a range we just wrote. */
class MemoryEvent extends Event implements DebugProtocol.MemoryEvent {
	public body: { memoryReference: string; offset: number; count: number };
	constructor(memoryReference: string, offset: number, count: number) {
		super('memory');
		this.body = { memoryReference, offset, count };
	}
}

const DEFAULT_REGION_SIZE = 4096;

export class AscendDebugSession extends LoggingDebugSession {
	private readonly mi = new MiConnection();
	private varManager = new VarObjectManager(this.mi);
	private mapper = new PathMapper();
	/** Consulted before GDB's own children, so broken pretty-printers lose. */
	private readonly formatters: TypeFormatterRegistry = createDefaultFormatterRegistry();

	private config!: AscendArguments;
	/** Mirror the MI dialogue into the Debug Console; see `trace`. */
	private traceMi = false;
	private executionMode: ExecutionMode = 'wsl';
	private isAttach = false;
	private terminated = false;

	private readonly variableHandles = new Handles<VariableContainer>();
	private readonly frameHandles = new Handles<FrameRef>();
	private readonly renderedVariables = new Map<number, Map<string, RenderedVariable>>();

	private readonly breakpointsBySource = new Map<string, number[]>();
	private functionBreakpointIds: number[] = [];
	private instructionBreakpointIds: number[] = [];
	private dataBreakpointIds: number[] = [];

	private registerNames?: string[];
	/** Locals held in registers, rebuilt on each stop; see readRegisterBindings. */
	private registerBindings?: Map<string, string[]>;
	/**
	 * Register values as of the previous stop, and as read during this one.
	 * The swap happens on resume, not on read, so re-expanding the folder
	 * twice in one stop shows the same answer both times.
	 */
	private registerHistory = new Map<string, string>();
	private registerCurrent = new Map<string, string>();
	/**
	 * The last *different* value each register held, which is what the `[was]`
	 * marker shows. Unlike the pair above this is never rotated: it stays put
	 * while a register holds still, so the rendered string stays byte-identical
	 * and VS Code does not highlight a register that did not move.
	 */
	private readonly registerWas = new Map<string, string>();
	/** Cached probe result: lldb-mi lacks -data-write-memory-bytes. */
	private supportsWriteMemoryBytes?: boolean;
	private stoppedThreadId = 1;
	private readonly sourceExistsCache = new Map<string, boolean>();

	private configurationDoneResolve!: () => void;
	private readonly configurationDone = new Promise<void>((resolve) => {
		this.configurationDoneResolve = resolve;
	});

	public constructor() {
		super('ascend-gdb-dap.log');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	/* ---------------------------------------------------------------------
	 * Lifecycle
	 * ------------------------------------------------------------------ */

	protected override initializeRequest(
		response: DebugProtocol.InitializeResponse,
		_args: DebugProtocol.InitializeRequestArguments,
	): void {
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsSetVariable = true;
		response.body.supportsSetExpression = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsHitConditionalBreakpoints = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsInstructionBreakpoints = true;
		response.body.supportsDataBreakpoints = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsDisassembleRequest = true;
		response.body.supportsTerminateRequest = true;
		response.body.supportsValueFormattingOptions = true;
		response.body.supportsLogPoints = false;

		// The two capabilities that put NPU buffers into the native Hex Editor.
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		this.sendResponse(response);
	}

	protected override configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		args: DebugProtocol.ConfigurationDoneArguments,
	): void {
		super.configurationDoneRequest(response, args);
		this.configurationDoneResolve();
	}

	protected override async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: AscendLaunchArguments,
	): Promise<void> {
		await this.startSession(response, args, false);
	}

	protected override async attachRequest(
		response: DebugProtocol.AttachResponse,
		args: AscendAttachArguments,
	): Promise<void> {
		await this.startSession(response, args, true);
	}

	private async startSession(
		response: DebugProtocol.Response,
		args: AscendArguments,
		isAttach: boolean,
	): Promise<void> {
		this.config = args;
		this.isAttach = isAttach;

		// `logging.engineLogging` is the older spelling of the same switch.
		this.traceMi = args.trace === true || args.logging?.engineLogging === true;
		// The log file gets the MI dialogue whenever either kind of tracing is
		// on; DAP-level tracing additionally echoes every protocol message,
		// which would bury the MI traffic it sits next to.
		logger.setup(
			args.logging?.trace || this.traceMi ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
			false);

		const mode = resolveExecutionMode(args);
		this.executionMode = mode;
		this.mapper = new PathMapper({
			sourceFileMap: args.sourceFileMap,
			// The \wsl$ fallback only makes sense for a WSL guest; a container
			// path is not reachable through the distro's share.
			distro: mode === 'wsl' ? args.wsl?.distro : undefined,
			passthrough: !shouldTranslatePaths(args),
		});
		this.varManager = new VarObjectManager(this.mi);

		this.mi.onEngineLog = (text) => this.trace(text);
		this.wireMiEvents();

		try {
			const guestCwd = args.cwd ? this.mapper.toDebugger(args.cwd) : undefined;
			const spawnSpec = buildDebuggerSpawn({
				mode,
				wsl: args.wsl,
				docker: args.execution?.docker,
				ssh: args.execution?.ssh,
				gdbPath: args.gdbPath || 'ascend-gdb',
				gdbArgs: args.gdbArgs,
				miMode: args.miMode,
				cwd: guestCwd,
				// Only a directory that exists on this machine is a valid spawn
				// cwd; a guest path that was translated is not one.
				hostCwd: args.cwd && this.hostFileExists(args.cwd) ? args.cwd : undefined,
				setupScript: args.setupScript,
				environment: args.environment,
			});

			await this.mi.start(spawnSpec);
			await this.runSetupCommands([...DEFAULT_SETUP_COMMANDS, ...(args.setupCommands ?? [])]);

			if (guestCwd) {
				await this.mi.sendCommandIgnoringErrors(`-environment-cd ${quoteMiString(guestCwd)}`);
			}

			if (args.program) {
				const guestProgram = this.mapper.toDebugger(args.program);
				await this.mi.sendCommand(`-file-exec-and-symbols ${quoteMiString(guestProgram)}`);
			} else if (!isAttach) {
				throw new Error('"program" is required for a launch configuration.');
			}

			if (args.miDebuggerServerAddress) {
				await this.mi.sendCommand(
					`-target-select remote ${args.miDebuggerServerAddress}`);
				await this.runSetupCommands(args.postRemoteConnectCommands ?? []);
			} else if (isAttach) {
				const pid = (args as AscendAttachArguments).processId;
				if (!pid) {
					throw new Error('An attach configuration needs either "processId" or "miDebuggerServerAddress".');
				}
				await this.mi.sendCommand(`-target-attach ${pid}`);
			}

			if (!isAttach) {
				const launchArgs = args as AscendLaunchArguments;
				if (launchArgs.args?.length) {
					const joined = launchArgs.args.map((a) => quoteMiString(a)).join(' ');
					await this.mi.sendCommandIgnoringErrors(`-exec-arguments ${joined}`);
				}
			}

			// Symbols are loaded, so breakpoints inserted from here on can bind.
			this.sendEvent(new InitializedEvent());
			await this.configurationDone;

			await this.startExecution(args, isAttach);
			this.sendResponse(response);
		} catch (err) {
			const message = err instanceof MiError
				? `${err.message} (while running "${err.command}")`
				: (err as Error).message;
			this.sendErrorResponse(response, {
				id: 1001,
				format: `Failed to start the Ascend debug session: ${message}${this.startupHint(message)}`,
				showUser: true,
			});
			await this.mi.stop().catch(() => undefined);
			this.sendEvent(new TerminatedEvent());
		}
	}

	private async startExecution(args: AscendArguments, isAttach: boolean): Promise<void> {
		const stopAtEntry = !isAttach && (args as AscendLaunchArguments).stopAtEntry === true;
		const entry = (args as AscendLaunchArguments).entryFunction || 'main';

		if (isAttach || args.miDebuggerServerAddress) {
			// The target is already alive; it is stopped where the stub left it.
			if (stopAtEntry) {
				await this.mi.sendCommandIgnoringErrors(`-break-insert -t -f ${quoteMiString(entry)}`);
				await this.mi.sendCommand('-exec-continue');
			} else {
				// Report the current stop so the UI shows a stack immediately.
				await this.reportCurrentStop();
			}
			return;
		}

		if (stopAtEntry) {
			// Deliberately not `-exec-run --start`: GDB reads that as "temporary
			// breakpoint at main", but msdebug-mi (lldb-mi) reads it as "stop at
			// the loader's first instruction", which lands the user in a frame
			// with no source. A temporary breakpoint means the same thing to both.
			await this.mi.sendCommandIgnoringErrors(`-break-insert -t -f ${quoteMiString(entry)}`);
		}
		await this.mi.sendCommand('-exec-run');
	}

	/**
	 * Turn the most common startup failures into an instruction. Docker exits
	 * immediately when the container is gone, so the raw daemon message arrives
	 * without any hint about what to do next.
	 */
	private startupHint(message: string): string {
		const container = this.config?.execution?.docker?.containerName;
		if (/no such container/i.test(message) && container) {
			const distro = this.config?.wsl?.distro || '<distro>';
			return `\n\nThe container "${container}" is not running. Start it, then retry:\n` +
				`  wsl -d ${distro} -e docker start ${container}\n` +
				'If it was created with --rm it no longer exists and must be re-created.';
		}
		if (/permission denied/i.test(message) && /docker/i.test(message)) {
			return '\n\nThe WSL user cannot reach the Docker socket. Add it to the docker group, ' +
				'or set execution.docker.user.';
		}
		if (/executable file not found|command not found|ENOENT/i.test(message)) {
			return '\n\nCheck "gdbPath" - for CANN 8.5 containers the MI driver is ' +
				'/usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi.';
		}
		if (this.executionMode === 'ssh') {
			const host = this.config?.execution?.ssh?.host ?? '<host>';
			if (/sshpass/i.test(message)) {
				return '\n\nsshpass is not installed where the ssh client runs. ' +
					'Install it (apt-get install sshpass) or switch the target to key ' +
					'authentication by setting execution.ssh.identityFile.';
			}
			if (/permission denied|authentication failed/i.test(message)) {
				return `\n\nThe target ${host} rejected the credentials. Re-enter the ` +
					'password in the Ascend NPU Target Manager, or check that the account ' +
					'may log in over SSH.';
			}
			if (/host key verification failed|remote host identification has changed/i.test(message)) {
				return `\n\nThe host key for ${host} no longer matches the one in ` +
					'known_hosts. Remove the stale entry after confirming the target was ' +
					'legitimately re-imaged.';
			}
			if (/connection refused|no route to host|timed out|could not resolve/i.test(message)) {
				return `\n\nCould not reach ${host}. Check the address and that sshd is ` +
					'listening; the ssh client runs inside WSL by default, so the distro ' +
					'must be able to route to the NPU host.';
			}
		}
		return '';
	}

	private async runSetupCommands(commands: SetupCommand[]): Promise<void> {
		for (const command of commands) {
			if (!command?.text) {
				continue;
			}
			// A leading '-' means it is already MI; anything else is a console command.
			const mi = command.text.startsWith('-')
				? command.text
				: `-interpreter-exec console ${quoteMiString(command.text)}`;
			if (command.ignoreFailures) {
				await this.mi.sendCommandIgnoringErrors(mi);
			} else {
				await this.mi.sendCommand(mi);
			}
		}
	}

	private wireMiEvents(): void {
		this.mi.on('exec', (record) => {
			void this.handleExecAsync(record);
		});
		this.mi.on('notify', (record) => this.handleNotifyAsync(record));
		// `~` and `&` are GDB talking about itself; `@` and everything that is
		// not MI at all is the debuggee talking. Only the latter is what the
		// user came to see.
		this.mi.on('console', (text) => this.trace(text));
		this.mi.on('log', (text) => this.trace(text));
		this.mi.on('target', (text) => this.emitProgramOutput(text));
		this.mi.on('inferior', (text) => this.emitProgramOutput(text));
		this.mi.on('error', (err) =>
			this.sendEvent(new OutputEvent(`debugger error: ${err.message}\n`, 'stderr')));
		this.mi.on('exit', () => {
			if (!this.terminated) {
				this.terminated = true;
				this.sendEvent(new TerminatedEvent());
			}
		});
	}

	private emitProgramOutput(text: string): void {
		if (this.config?.logging?.programOutput === false) {
			return;
		}
		this.sendEvent(new OutputEvent(text, 'stdout'));
	}

	/**
	 * Every line of the MI dialogue: the commands the adapter sends, GDB's
	 * replies, and GDB's own `~` console and `&` log streams.
	 *
	 * None of it is hidden - it is *moved*. It goes out as a custom DAP event
	 * that the extension host appends to the "Ascend GDB Trace" output
	 * channel, so the whole dialogue stays there for the next time the adapter
	 * itself misbehaves, while the Debug Console keeps carrying the debuggee's
	 * output and nothing else.
	 *
	 * That distinction matters most for the `&` stream, which is GDB echoing
	 * back every command we send it - and we send a lot of them, a varobj per
	 * visible variable on every stop.
	 */
	private trace(text: string): void {
		logger.verbose(text.replace(/\n+$/, ''));
		this.sendEvent(new Event(MI_TRACE_EVENT, { log: text } as MiTraceEventBody));
		// Opt-in: MI interleaved with the debuggee's own output, in order.
		if (this.traceMi) {
			this.sendEvent(new OutputEvent(text, 'console'));
		}
	}

	/* ---------------------------------------------------------------------
	 * Stop / resume
	 * ------------------------------------------------------------------ */

	private async handleExecAsync(record: MiRecord): Promise<void> {
		if (record.class === 'running') {
			const threadId = miString(record.results['thread-id']);
			this.sendEvent(new ContinuedEvent(
				threadId === 'all' ? this.stoppedThreadId : miNumber(record.results['thread-id'], this.stoppedThreadId),
				threadId === 'all'));
			return;
		}
		if (record.class !== 'stopped') {
			return;
		}

		const results = record.results;
		const reason = miString(results['reason']);

		if (reason.startsWith('exited')) {
			const exitCode = miNumber(results['exit-code'], 0);
			if (exitCode) {
				this.sendEvent(new OutputEvent(`Program exited with code ${exitCode}.\n`, 'console'));
			}
			if (!this.terminated) {
				this.terminated = true;
				this.sendEvent(new TerminatedEvent());
			}
			return;
		}

		this.stoppedThreadId = miNumber(results['thread-id'], this.stoppedThreadId) || 1;
		this.resetHandles();

		const event = new StoppedEvent(
			mapStopReason(reason), this.stoppedThreadId) as DebugProtocol.StoppedEvent;
		event.body.allThreadsStopped = miString(results['stopped-threads']) === 'all'
			|| Array.isArray(results['stopped-threads']);

		if (reason === 'signal-received') {
			const name = miString(results['signal-name'], 'signal');
			const meaning = miString(results['signal-meaning']);
			event.body.description = meaning ? `${name}: ${meaning}` : name;
			event.body.text = event.body.description;
		}

		const bkptno = miString(results['bkptno']);
		if (bkptno) {
			event.body.hitBreakpointIds = bkptno.split(/\s+/).map(Number).filter((n) => !isNaN(n));
		}

		this.sendEvent(event);
	}

	private handleNotifyAsync(record: MiRecord): void {
		switch (record.class) {
			case 'thread-created':
				this.sendEvent(new ThreadEvent('started', miNumber(record.results['id'], 0)));
				break;
			case 'thread-exited':
				this.sendEvent(new ThreadEvent('exited', miNumber(record.results['id'], 0)));
				break;
			case 'breakpoint-modified': {
				const bkpt = miTuple(record.results['bkpt']);
				if (bkpt) {
					const bp = new Breakpoint(
						isVerified(bkpt), miNumber(bkpt['line']) || undefined) as DebugProtocol.Breakpoint;
					bp.id = miNumber(bkpt['number']);
					this.sendEvent(new Event('breakpoint', { reason: 'changed', breakpoint: bp }));
				}
				break;
			}
			default:
				break;
		}
	}

	/** Called before every resume: varobjs and handles do not survive it. */
	private async beforeResume(): Promise<void> {
		// Whatever was read this stop becomes the baseline for the next one.
		// Left alone when the user never opened the Registers view, so the
		// comparison survives a run of steps that nobody was watching.
		if (this.registerCurrent.size) {
			this.registerHistory = this.registerCurrent;
			this.registerCurrent = new Map();
		}
		await this.varManager.releaseAll();
		this.resetHandles();
	}

	private resetHandles(): void {
		// Bindings are a property of one stop: the next one may hold entirely
		// different locals in entirely different registers.
		this.registerBindings = undefined;
		this.variableHandles.reset();
		this.frameHandles.reset();
		this.renderedVariables.clear();
	}

	/** Synthesise a StoppedEvent for a target that was already halted on attach. */
	private async reportCurrentStop(): Promise<void> {
		try {
			const info = await this.mi.sendCommand('-thread-info');
			const current = miNumber(info.results['current-thread-id'], 1);
			this.stoppedThreadId = current || 1;
		} catch {
			this.stoppedThreadId = 1;
		}
		const event = new StoppedEvent('pause', this.stoppedThreadId) as DebugProtocol.StoppedEvent;
		event.body.allThreadsStopped = true;
		this.sendEvent(event);
	}

	/* ---------------------------------------------------------------------
	 * Breakpoints
	 * ------------------------------------------------------------------ */

	protected override async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	): Promise<void> {
		const hostPath = args.source.path ?? '';
		const guestPath = this.mapper.toDebugger(hostPath);

		const previous = this.breakpointsBySource.get(guestPath);
		if (previous?.length) {
			await this.mi.sendCommandIgnoringErrors(`-break-delete ${previous.join(' ')}`);
		}

		const created: DebugProtocol.Breakpoint[] = [];
		const ids: number[] = [];

		for (const requested of args.breakpoints ?? []) {
			let command = '-break-insert -f';
			if (requested.condition) {
				command += ` -c ${quoteMiString(requested.condition)}`;
			}
			const ignoreCount = parseHitCondition(requested.hitCondition);
			if (ignoreCount !== undefined) {
				command += ` -i ${ignoreCount}`;
			}
			command += ` ${quoteMiString(`${guestPath}:${requested.line}`)}`;

			try {
				const record = await this.mi.sendCommand(command);
				const bkpt = firstTuple(record.results['bkpt']);
				if (!bkpt) {
					created.push(new Breakpoint(false));
					continue;
				}
				const id = miNumber(bkpt['number']);
				ids.push(id);
				const bp = new Breakpoint(
					isVerified(bkpt),
					miNumber(bkpt['line'], requested.line),
					undefined,
					this.createSource(miString(bkpt['fullname'], guestPath)),
				) as DebugProtocol.Breakpoint;
				bp.id = id;
				const addr = miString(bkpt['addr']);
				if (addr.startsWith('0x')) {
					bp.instructionReference = addr;
				}
				if (!bp.verified) {
					bp.message = 'Pending: no code at this location yet. It will bind when the kernel image is loaded.';
				}
				created.push(bp);
			} catch (err) {
				const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
				bp.message = (err as Error).message;
				created.push(bp);
			}
		}

		this.breakpointsBySource.set(guestPath, ids);
		response.body = { breakpoints: created };
		this.sendResponse(response);
	}

	protected override async setFunctionBreakPointsRequest(
		response: DebugProtocol.SetFunctionBreakpointsResponse,
		args: DebugProtocol.SetFunctionBreakpointsArguments,
	): Promise<void> {
		if (this.functionBreakpointIds.length) {
			await this.mi.sendCommandIgnoringErrors(`-break-delete ${this.functionBreakpointIds.join(' ')}`);
			this.functionBreakpointIds = [];
		}
		const created: DebugProtocol.Breakpoint[] = [];
		for (const requested of args.breakpoints ?? []) {
			let command = '-break-insert -f';
			if (requested.condition) {
				command += ` -c ${quoteMiString(requested.condition)}`;
			}
			command += ` ${quoteMiString(requested.name)}`;
			try {
				const record = await this.mi.sendCommand(command);
				const bkpt = firstTuple(record.results['bkpt']);
				const id = bkpt ? miNumber(bkpt['number']) : 0;
				if (id) {
					this.functionBreakpointIds.push(id);
				}
				const bp = new Breakpoint(
					bkpt ? isVerified(bkpt) : false,
					bkpt ? miNumber(bkpt['line']) || undefined : undefined,
				) as DebugProtocol.Breakpoint;
				bp.id = id;
				created.push(bp);
			} catch (err) {
				const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
				bp.message = (err as Error).message;
				created.push(bp);
			}
		}
		response.body = { breakpoints: created };
		this.sendResponse(response);
	}

	protected override async setInstructionBreakpointsRequest(
		response: DebugProtocol.SetInstructionBreakpointsResponse,
		args: DebugProtocol.SetInstructionBreakpointsArguments,
	): Promise<void> {
		if (this.instructionBreakpointIds.length) {
			await this.mi.sendCommandIgnoringErrors(`-break-delete ${this.instructionBreakpointIds.join(' ')}`);
			this.instructionBreakpointIds = [];
		}
		const created: DebugProtocol.Breakpoint[] = [];
		for (const requested of args.breakpoints ?? []) {
			const base = parseAddress(requested.instructionReference);
			if (base === undefined) {
				created.push(new Breakpoint(false));
				continue;
			}
			const address = base + BigInt(requested.offset ?? 0);
			try {
				const record = await this.mi.sendCommand(
					`-break-insert -f ${quoteMiString(`*0x${address.toString(16)}`)}`);
				const bkpt = firstTuple(record.results['bkpt']);
				const id = bkpt ? miNumber(bkpt['number']) : 0;
				if (id) {
					this.instructionBreakpointIds.push(id);
				}
				const bp = new Breakpoint(!!bkpt) as DebugProtocol.Breakpoint;
				bp.id = id;
				bp.instructionReference = `0x${address.toString(16)}`;
				created.push(bp);
			} catch {
				created.push(new Breakpoint(false));
			}
		}
		response.body = { breakpoints: created };
		this.sendResponse(response);
	}

	protected override dataBreakpointInfoRequest(
		response: DebugProtocol.DataBreakpointInfoResponse,
		args: DebugProtocol.DataBreakpointInfoArguments,
	): void {
		const rendered = args.variablesReference !== undefined
			? this.renderedVariables.get(args.variablesReference)?.get(args.name)
			: undefined;
		const expression = rendered?.pathExpr || args.name;

		response.body = {
			dataId: expression,
			description: expression,
			accessTypes: ['read', 'write', 'readWrite'],
			canPersist: false,
		};
		this.sendResponse(response);
	}

	protected override async setDataBreakpointsRequest(
		response: DebugProtocol.SetDataBreakpointsResponse,
		args: DebugProtocol.SetDataBreakpointsArguments,
	): Promise<void> {
		if (this.dataBreakpointIds.length) {
			await this.mi.sendCommandIgnoringErrors(`-break-delete ${this.dataBreakpointIds.join(' ')}`);
			this.dataBreakpointIds = [];
		}
		const created: DebugProtocol.Breakpoint[] = [];
		for (const requested of args.breakpoints ?? []) {
			const flag = requested.accessType === 'read' ? '-r'
				: requested.accessType === 'readWrite' ? '-a' : '';
			const command = `-break-watch ${flag} ${quoteMiString(requested.dataId)}`.replace(/\s+/g, ' ');
			try {
				const record = await this.mi.sendCommand(command);
				const wpt = firstTuple(record.results['wpt'])
					?? firstTuple(record.results['hw-awpt'])
					?? firstTuple(record.results['hw-rwpt']);
				const id = wpt ? miNumber(wpt['number']) : 0;
				if (id) {
					this.dataBreakpointIds.push(id);
				}
				const bp = new Breakpoint(!!wpt) as DebugProtocol.Breakpoint;
				bp.id = id;
				created.push(bp);
			} catch (err) {
				const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
				bp.message = (err as Error).message;
				created.push(bp);
			}
		}
		response.body = { breakpoints: created };
		this.sendResponse(response);
	}

	/* ---------------------------------------------------------------------
	 * Execution control
	 * ------------------------------------------------------------------ */

	protected override async continueRequest(
		response: DebugProtocol.ContinueResponse,
		_args: DebugProtocol.ContinueArguments,
	): Promise<void> {
		await this.beforeResume();
		await this.execCommand(response, '-exec-continue');
		response.body = { allThreadsContinued: true };
		this.sendResponse(response);
	}

	protected override async nextRequest(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments,
	): Promise<void> {
		await this.beforeResume();
		const command = args.granularity === 'instruction' ? '-exec-next-instruction' : '-exec-next';
		await this.execCommand(response, `${command} --thread ${args.threadId}`);
		this.sendResponse(response);
	}

	protected override async stepInRequest(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments,
	): Promise<void> {
		await this.beforeResume();
		const command = args.granularity === 'instruction' ? '-exec-step-instruction' : '-exec-step';
		await this.execCommand(response, `${command} --thread ${args.threadId}`);
		this.sendResponse(response);
	}

	protected override async stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments,
	): Promise<void> {
		await this.beforeResume();
		await this.execCommand(response, `-exec-finish --thread ${args.threadId}`);
		this.sendResponse(response);
	}

	protected override async pauseRequest(
		response: DebugProtocol.PauseResponse,
		_args: DebugProtocol.PauseArguments,
	): Promise<void> {
		// Node cannot deliver SIGINT into WSL, so MiConnection falls back to
		// running `kill -INT` inside the guest against the PID our wrapper echoed.
		const signal = {
			mode: this.executionMode,
			wsl: this.config?.wsl,
			docker: this.config?.execution?.docker,
			ssh: this.config?.execution?.ssh,
		};
		const ok = await this.mi.interrupt(buildSignalPrefix(signal), buildSignalEnv(signal));
		if (!ok) {
			this.sendErrorResponse(response, {
				id: 1004,
				format: 'Could not interrupt the target. Set "mi-async on" in setupCommands, or pause from the simulator side.',
				showUser: true,
			});
			return;
		}
		this.sendResponse(response);
	}

	private async execCommand(response: DebugProtocol.Response, command: string): Promise<void> {
		try {
			await this.mi.sendCommand(command);
		} catch (err) {
			this.sendEvent(new OutputEvent(`${(err as Error).message}\n`, 'stderr'));
			response.success = false;
			response.message = (err as Error).message;
		}
	}

	protected override async terminateRequest(
		response: DebugProtocol.TerminateResponse,
		_args: DebugProtocol.TerminateArguments,
	): Promise<void> {
		await this.mi.sendCommandIgnoringErrors('-exec-interrupt --all');
		await this.mi.sendCommandIgnoringErrors('-target-detach');
		this.sendResponse(response);
	}

	protected override async disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
	): Promise<void> {
		this.terminated = true;
		if (this.mi.isRunning) {
			if (args.terminateDebuggee !== false && !this.isAttach) {
				await this.mi.sendCommandIgnoringErrors('-exec-interrupt --all');
				await this.mi.sendCommandIgnoringErrors('-target-kill');
			} else {
				await this.mi.sendCommandIgnoringErrors('-target-detach');
			}
			await this.mi.stop();
		}
		this.sendResponse(response);
	}

	/* ---------------------------------------------------------------------
	 * Threads and stack
	 * ------------------------------------------------------------------ */

	protected override async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		try {
			const record = await this.mi.sendCommand('-thread-info');
			const threads: Thread[] = [];
			for (const t of miList(record.results['threads'], 'thread')) {
				const id = miNumber(t['id']);
				const name = miString(t['name']) || miString(t['target-id'], `Thread ${id}`);
				threads.push(new Thread(id, name));
			}
			response.body = {
				threads: threads.length ? threads : [new Thread(this.stoppedThreadId, 'Ascend core 0')],
			};
		} catch {
			response.body = { threads: [new Thread(this.stoppedThreadId, 'Ascend core 0')] };
		}
		this.sendResponse(response);
	}

	protected override async stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments,
	): Promise<void> {
		const threadId = args.threadId;
		const startFrame = args.startFrame ?? 0;
		const levels = args.levels ?? 0;

		try {
			let totalFrames: number | undefined;
			try {
				const depth = await this.mi.sendCommand(`-stack-info-depth --thread ${threadId}`);
				totalFrames = miNumber(depth.results['depth']) || undefined;
			} catch {
				totalFrames = undefined;
			}

			const range = levels > 0 ? ` ${startFrame} ${startFrame + levels - 1}` : '';
			const record = await this.mi.sendCommand(`-stack-list-frames --thread ${threadId}${range}`);

			const frames: StackFrame[] = [];
			for (const f of miList(record.results['stack'], 'frame')) {
				const level = miNumber(f['level']);
				const func = miString(f['func'], '??');
				const line = miNumber(f['line']);
				const guestFile = miString(f['fullname']) || miString(f['file']);
				const frameId = this.frameHandles.create({ threadId, level });

				const frame = new StackFrame(
					frameId, func, guestFile ? this.createSource(guestFile) : undefined, line,
				) as DebugProtocol.StackFrame;

				const addr = miString(f['addr']);
				if (addr.startsWith('0x')) {
					// Enables "Open Disassembly View" and the instruction stepping UI.
					frame.instructionPointerReference = addr;
				}
				if (!guestFile) {
					frame.presentationHint = 'subtle';
				}
				frames.push(frame);
			}

			response.body = { stackFrames: frames, totalFrames };
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, {
				id: 1005,
				format: `Could not read the call stack: ${(err as Error).message}`,
			});
		}
	}

	protected override scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments,
	): void {
		const frame = this.frameHandles.get(args.frameId);
		if (!frame) {
			response.body = { scopes: [] };
			this.sendResponse(response);
			return;
		}

		const scopes: DebugProtocol.Scope[] = [
			new Scope('Locals', this.variableHandles.create({ kind: 'locals', frame }), false),
			new Scope('Arguments', this.variableHandles.create({ kind: 'arguments', frame }), false),
			new Scope('Registers', this.variableHandles.create({ kind: 'registers', frame }), true),
		];
		(scopes[0] as DebugProtocol.Scope).presentationHint = 'locals';
		(scopes[1] as DebugProtocol.Scope).presentationHint = 'arguments';
		(scopes[2] as DebugProtocol.Scope).presentationHint = 'registers';

		if (this.config?.npuMemoryRegions?.length) {
			// A scope whose entries exist purely to carry a memoryReference, which
			// is what gives "View Binary Data" on UB / L1 / L0C without a variable.
			scopes.push(new Scope('NPU Memory', this.variableHandles.create({ kind: 'npu' }), true));
		}

		response.body = { scopes };
		this.sendResponse(response);
	}

	/* ---------------------------------------------------------------------
	 * Variables
	 * ------------------------------------------------------------------ */

	protected override async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
	): Promise<void> {
		const container = this.variableHandles.get(args.variablesReference);
		if (!container) {
			response.body = { variables: [] };
			this.sendResponse(response);
			return;
		}

		try {
			let variables: DebugProtocol.Variable[];
			switch (container.kind) {
				case 'locals':
					variables = await this.readFrameVariables(container.frame, 'locals', args.variablesReference);
					break;
				case 'arguments':
					variables = await this.readFrameVariables(container.frame, 'arguments', args.variablesReference);
					break;
				case 'registers':
					variables = await this.readRegisters(container.frame);
					break;
				case 'registerGroup':
					variables = await this.readRegisterGroup(container);
					break;
				case 'npu':
					variables = await this.readNpuRegions();
					break;
				case 'varobj':
					variables = await this.readChildren(container, args.variablesReference, args.start, args.count);
					break;
				case 'formatted':
					variables = await this.readFormattedChildren(
						container, args.variablesReference, args.start, args.count, args.filter);
					break;
				case 'expansion':
					variables = await this.readExpansion(
						container, args.variablesReference, args.start, args.count, args.filter);
					break;
			}
			response.body = { variables };
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, {
				id: 1006,
				format: `Could not read variables: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Locals and arguments both come from `-stack-list-variables`, which tags
	 * arguments with `arg="1"`. One MI round trip covers both scopes; each
	 * variable then costs a `-var-create` so it can be expanded and addressed.
	 */
	private async readFrameVariables(
		frame: FrameRef,
		which: 'locals' | 'arguments',
		containerRef: number,
	): Promise<DebugProtocol.Variable[]> {
		const record = await this.mi.sendCommand(
			`-stack-list-variables --thread ${frame.threadId} --frame ${frame.level} --no-values`);

		const wanted: string[] = [];
		for (const entry of miArray(record.results['variables'])) {
			const t = miTuple(entry);
			if (!t) {
				continue;
			}
			const isArg = miString(t['arg']) === '1';
			if ((which === 'arguments') !== isArg) {
				continue;
			}
			const name = miString(t['name']);
			if (name) {
				wanted.push(name);
			}
		}

		const rendered = this.renderedVariables.get(containerRef) ?? new Map<string, RenderedVariable>();
		this.renderedVariables.set(containerRef, rendered);

		const out: DebugProtocol.Variable[] = [];
		for (const name of wanted) {
			try {
				const varobj = await this.varManager.create(name, frame.threadId, frame.level);
				out.push(await this.toDapVariable(varobj, frame, name, rendered));
			} catch (err) {
				out.push({
					name,
					value: `<unavailable: ${(err as Error).message}>`,
					variablesReference: 0,
					presentationHint: { attributes: ['readOnly'] },
				});
			}
		}
		return out;
	}

	private async readChildren(
		container: VarobjContainer,
		containerRef: number,
		start?: number,
		count?: number,
	): Promise<DebugProtocol.Variable[]> {
		const children = await this.varManager.children(container.varobj.name, start, count);
		const rendered = this.renderedVariables.get(containerRef) ?? new Map<string, RenderedVariable>();
		this.renderedVariables.set(containerRef, rendered);

		const out: DebugProtocol.Variable[] = [];
		for (const child of children) {
			out.push(await this.toDapVariable(child, container.frame, child.expression, rendered));
		}
		return out;
	}

	/* ---------------------------------------------------------------------
	 * Synthetic children
	 * ------------------------------------------------------------------ */

	/**
	 * inspect(), with the guarantee that a formatter cannot throw its way into
	 * a failed request. A formatter that blows up on one value should cost
	 * that value its nice rendering, nothing more.
	 */
	private async inspectSafely(
		formatter: ITypeFormatter,
		frame: FrameRef,
		expression: string,
		type: string,
	): Promise<FormatterView | undefined> {
		try {
			return await formatter.inspect(this.formatterContext(frame), expression, type);
		} catch (err) {
			logger.verbose(`formatter ${formatter.name} failed on ${expression}: ${(err as Error).message}`);
			return undefined;
		}
	}

	/** A formatter's window onto the debugger, bound to one frame. */
	private formatterContext(frame: FrameRef): FormatterContext {
		return {
			mi: this.mi,
			varManager: this.varManager,
			threadId: frame.threadId,
			frameLevel: frame.level,
			// The reference is handed out now and honoured later, if ever:
			// nothing is evaluated until the user actually expands the row.
			reserveExpansion: (expression: string) =>
				this.variableHandles.create({ kind: 'expansion', expression, frame }),
		};
	}

	/**
	 * Replace a value the debugger renders badly with a formatter's view of it.
	 *
	 * Returns undefined - and the caller falls back to GDB's own children -
	 * when no formatter claims the type, when there is no expression to
	 * evaluate against, or when the formatter inspects the object and decides
	 * it is not really formattable after all. An uninitialised vector is the
	 * case that matters: three raw pointers are more honest than 10^12
	 * invented elements.
	 */
	private async tryFormat(
		varobj: VarObject,
		frame: FrameRef,
		displayName: string,
		pathExpr: string,
		rendered: Map<string, RenderedVariable>,
	): Promise<DebugProtocol.Variable | undefined> {
		const formatter = this.formatters.find(varobj.type);
		if (!formatter || !pathExpr) {
			return undefined;
		}

		const view = await this.inspectSafely(formatter, frame, pathExpr, varobj.type);
		if (!view) {
			return undefined;
		}

		const variable: DebugProtocol.Variable = {
			name: displayName,
			value: view.value,
			type: varobj.type || undefined,
			evaluateName: pathExpr,
			// An empty container is a leaf: an expander that yields nothing is
			// worse than no expander at all.
			variablesReference: view.indexedVariables > 0
				? this.variableHandles.create({ kind: 'formatted', formatter, view, frame })
				: 0,
			indexedVariables: view.indexedVariables || undefined,
			memoryReference: view.memoryReference,
		};

		rendered.set(displayName, {
			pathExpr,
			varobjName: varobj.name,
			memoryReference: view.memoryReference,
		});
		return variable;
	}

	/**
	 * One page of a formatter's synthetic children.
	 *
	 * start/count are passed straight through. VS Code asks for [0,100) of a
	 * 2048-element tensor and exactly those 100 elements cross the MI wire;
	 * dropping the range here would put the whole tensor in every request,
	 * which is precisely what the paging exists to prevent.
	 */
	private async readFormattedChildren(
		container: FormattedContainer,
		containerRef: number,
		start?: number,
		count?: number,
		filter?: DebugProtocol.VariablesArguments['filter'],
	): Promise<DebugProtocol.Variable[]> {
		// Synthetic children are all indexed; there is nothing named to return.
		if (filter === 'named') {
			return [];
		}

		const first = Math.max(0, start ?? 0);
		// DAP: a missing or zero count means "the rest of them".
		const length = count && count > 0
			? count
			: Math.max(0, container.view.indexedVariables - first);

		const children = await container.formatter.getChildren(
			this.formatterContext(container.frame), container.view, first, length);

		// Remember the elements so a watchpoint can be set on one. They have no
		// varobj, so setVariable still refuses them - assigning through a
		// synthetic child would need -gdb-set, which is a separate feature.
		const rendered = this.renderedVariables.get(containerRef) ?? new Map<string, RenderedVariable>();
		this.renderedVariables.set(containerRef, rendered);
		for (const child of children) {
			if (child.evaluateName) {
				rendered.set(child.name, {
					pathExpr: child.evaluateName,
					memoryReference: child.memoryReference,
				});
			}
		}
		return children;
	}

	/**
	 * Expand a synthetic child on demand. The varobj is created here, at the
	 * moment someone clicks the twistie, rather than when the parent page was
	 * rendered - so showing 2048 elements costs 2048 rows and zero varobjs.
	 */
	private async readExpansion(
		container: ExpansionContainer,
		containerRef: number,
		start?: number,
		count?: number,
		filter?: DebugProtocol.VariablesArguments['filter'],
	): Promise<DebugProtocol.Variable[]> {
		if (container.resolved === undefined) {
			container.resolved = await this.resolveExpansion(container.expression, container.frame);
		}
		if (container.resolved === 'none') {
			return [];
		}
		return container.resolved.kind === 'formatted'
			? this.readFormattedChildren(container.resolved, containerRef, start, count, filter)
			: this.readChildren(container.resolved, containerRef, start, count);
	}

	/** Decide, one level down, whether a formatter or GDB owns the children. */
	private async resolveExpansion(
		expression: string,
		frame: FrameRef,
	): Promise<VarobjContainer | FormattedContainer | 'none'> {
		let varobj: VarObject;
		try {
			varobj = await this.varManager.create(expression, frame.threadId, frame.level);
		} catch (err) {
			logger.verbose(`cannot expand ${expression}: ${(err as Error).message}`);
			return 'none';
		}

		const formatter = this.formatters.find(varobj.type);
		if (formatter) {
			const view = await this.inspectSafely(formatter, frame, expression, varobj.type);
			if (view) {
				return { kind: 'formatted', formatter, view, frame };
			}
		}
		return { kind: 'varobj', varobj, frame };
	}

	/**
	 * Turn one varobj into a DAP variable, attaching:
	 *  - variablesReference when it can be expanded,
	 *  - indexedVariables so VS Code pages through large tensors,
	 *  - evaluateName so Copy Value / Add to Watch work,
	 *  - memoryReference, which is what puts "View Binary Data" in the menu.
	 */
	private async toDapVariable(
		varobj: VarObject,
		frame: FrameRef,
		displayName: string,
		rendered: Map<string, RenderedVariable>,
	): Promise<DebugProtocol.Variable> {
		// The path expression is fetched first because a formatter needs one:
		// `var4` means nothing to the expression evaluator, `scores` does.
		const pathExpr = await this.varManager.pathExpression(varobj.name);

		const formatted = await this.tryFormat(varobj, frame, displayName, pathExpr, rendered);
		if (formatted) {
			return formatted;
		}

		const shape = classifyType(varobj.type);
		const expandable = varobj.numchild > 0 || varobj.hasMore;

		const variable: DebugProtocol.Variable = {
			name: displayName,
			value: varobj.value || (expandable ? `{...}` : ''),
			type: varobj.type || undefined,
			variablesReference: expandable
				? this.variableHandles.create({ kind: 'varobj', varobj, frame })
				: 0,
		};

		if (shape.isArray && shape.arrayLength !== undefined && shape.arrayLength > 0) {
			variable.indexedVariables = Math.min(shape.arrayLength, varobj.numchild || shape.arrayLength);
		}

		if (pathExpr) {
			variable.evaluateName = pathExpr;
		}

		const memoryReference = await this.memoryReferenceFor(pathExpr, varobj, shape, frame);
		if (memoryReference) {
			variable.memoryReference = memoryReference;
		}

		rendered.set(displayName, {
			pathExpr: pathExpr || displayName,
			varobjName: varobj.name,
			memoryReference,
		});

		return variable;
	}

	private async memoryReferenceFor(
		pathExpr: string,
		varobj: VarObject,
		shape: ReturnType<typeof classifyType>,
		frame: FrameRef,
	): Promise<string | undefined> {
		const mode = this.config?.memoryReferences ?? 'auto';
		if (mode === 'off' || !pathExpr) {
			return undefined;
		}
		if (mode === 'auto') {
			// Taking an address costs an MI round trip each, so in auto mode we
			// only spend it where a hex view is plausibly wanted: buffers,
			// tensors, tiling structs - not loop counters.
			const interesting = shape.isPointer || shape.isArray || shape.isAggregate || varobj.numchild > 0;
			if (!interesting) {
				return undefined;
			}
		}
		return resolveMemoryAddress(this.mi, pathExpr, shape, frame.threadId, frame.level);
	}

	/**
	 * The Registers scope itself: one folder per group, not a wall of a
	 * hundred rows. Empty groups are left out rather than shown empty.
	 */
	private async readRegisters(frame: FrameRef): Promise<DebugProtocol.Variable[]> {
		const groups = groupRegisters(await this.readRegisterNames());

		const out: DebugProtocol.Variable[] = [];
		for (const info of REGISTER_GROUPS) {
			const members = groups.get(info.id) ?? [];
			if (!members.length) {
				continue;
			}
			out.push({
				name: info.label,
				value: `${members.length} registers`,
				variablesReference: this.variableHandles.create(
					{ kind: 'registerGroup', group: info.id, frame }),
				namedVariables: members.length,
				presentationHint: { kind: 'data' },
			});
		}
		return out;
	}

	/** The registers in one folder, with their values and any locals held in them. */
	private async readRegisterGroup(
		container: RegisterGroupContainer,
	): Promise<DebugProtocol.Variable[]> {
		const frame = container.frame;
		const names = await this.readRegisterNames();
		const record = await this.mi.sendCommand(
			`-data-list-register-values --thread ${frame.threadId} --frame ${frame.level} x`);
		const bindings = await this.readRegisterBindings(frame);

		const out: DebugProtocol.Variable[] = [];
		for (const entry of miList(record.results['register-values'], 'register-values')) {
			const number = miNumber(entry['number'], -1);
			const name = (number >= 0 && names[number]) || `r${number}`;
			if (!name || categorizeRegister(name) !== container.group) {
				continue;
			}
			const value = miString(entry['value']);
			this.registerCurrent.set(name, value);

			// Idempotent within a stop: registerHistory does not move until
			// the next resume, so reading the folder again recomputes exactly
			// the same marker rather than eating it.
			const previous = this.registerHistory.get(name);
			if (previous !== undefined && previous !== value) {
				this.registerWas.set(name, previous);
			}

			const variable: DebugProtocol.Variable = {
				// Stable across stops - VS Code matches variables by name to
				// decide what to highlight, so this must not carry a handle or
				// an index that changes every time the frame is rebuilt.
				name,
				value: renderRegisterValue(value, this.registerWas.get(name), bindings.get(name) ?? []),
				variablesReference: 0,
				evaluateName: `$${name}`,
				presentationHint: { kind: 'data', attributes: ['readOnly'] },
			};
			// A register holding an address should open the hex editor there -
			// the fastest way to inspect a UB/L1 pointer held in a core register.
			if (/^0x[0-9a-fA-F]+$/.test(value) && BigInt(value) !== 0n) {
				variable.memoryReference = value;
			}
			out.push(variable);
		}
		return out;
	}

	private async readRegisterNames(): Promise<string[]> {
		if (!this.registerNames) {
			const record = await this.mi.sendCommand('-data-list-register-names');
			this.registerNames = miArray(record.results['register-names'])
				.map((v) => (typeof v === 'string' ? v : ''));
		}
		return this.registerNames;
	}

	/**
	 * Which locals are living in which registers, for this stop.
	 *
	 * There is no MI command for this, so it goes through `info address` per
	 * variable and parses the answer. That is one round trip each, hence the
	 * cache; and the first refusal disables the whole thing for the stop,
	 * because a debugger that does not implement `info address` will not
	 * implement it any better on the ninth variable than on the first.
	 *
	 * A debugger that cannot answer costs one wasted command and no
	 * annotations - never an error the user has to read.
	 */
	private async readRegisterBindings(frame: FrameRef): Promise<Map<string, string[]>> {
		if (this.registerBindings) {
			return this.registerBindings;
		}
		const bindings = new Map<string, string[]>();
		this.registerBindings = bindings;

		let locals: string[];
		try {
			const record = await this.mi.sendCommand(
				`-stack-list-variables --thread ${frame.threadId} --frame ${frame.level} --no-values`);
			locals = miArray(record.results['variables'])
				.map((entry) => miString(miTuple(entry)?.['name'] ?? ''))
				.filter(Boolean);
		} catch {
			return bindings;
		}

		for (const local of locals) {
			let answer: string;
			try {
				answer = await this.mi.sendCliCommand(`info address ${local}`);
			} catch {
				// Not supported by this debugger; stop asking.
				logger.verbose(`info address unavailable; register mapping disabled`);
				return bindings;
			}
			const binding = parseRegisterBinding(answer);
			if (!binding) {
				continue;
			}
			const held = bindings.get(binding.register) ?? [];
			held.push(binding.symbol);
			bindings.set(binding.register, held);
		}
		return bindings;
	}

	/** The synthetic "NPU Memory" scope: named windows into on-chip buffers. */
	private async readNpuRegions(): Promise<DebugProtocol.Variable[]> {
		const regions = this.config?.npuMemoryRegions ?? [];
		const out: DebugProtocol.Variable[] = [];
		for (const region of regions) {
			const address = await this.resolveRegionAddress(region);
			const size = region.size ?? DEFAULT_REGION_SIZE;
			out.push({
				name: region.name,
				value: address ? `${address} (${formatBytes(size)})` : `<unresolved: ${region.address}>`,
				type: region.description,
				variablesReference: 0,
				memoryReference: address,
				presentationHint: { kind: 'data', attributes: ['readOnly'] },
			});
		}
		return out;
	}

	private async resolveRegionAddress(region: NpuMemoryRegion): Promise<string | undefined> {
		const literal = parseAddress(region.address);
		if (literal !== undefined) {
			return `0x${literal.toString(16)}`;
		}
		try {
			const record = await this.mi.sendCommand(
				`-data-evaluate-expression ${quoteMiString(`(unsigned long long)(${region.address})`)}`);
			const raw = miString(record.results['value']).trim();
			const m = /^(0x[0-9a-fA-F]+|\d+)/.exec(raw);
			return m ? `0x${BigInt(m[1]).toString(16)}` : undefined;
		} catch {
			return undefined;
		}
	}

	protected override async setVariableRequest(
		response: DebugProtocol.SetVariableResponse,
		args: DebugProtocol.SetVariableArguments,
	): Promise<void> {
		const rendered = this.renderedVariables.get(args.variablesReference)?.get(args.name);
		if (!rendered?.varobjName) {
			this.sendErrorResponse(response, { id: 1007, format: `Cannot assign to "${args.name}".` });
			return;
		}
		try {
			const value = await this.varManager.assign(rendered.varobjName, args.value);
			response.body = { value };
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, { id: 1008, format: (err as Error).message, showUser: true });
		}
	}

	/* ---------------------------------------------------------------------
	 * Evaluate
	 * ------------------------------------------------------------------ */

	protected override async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments,
	): Promise<void> {
		const frame = args.frameId !== undefined ? this.frameHandles.get(args.frameId) : undefined;

		// REPL: let the user drive GDB directly. `-` prefixed input is raw MI.
		if (args.context === 'repl' && !frame) {
			await this.evaluateInRepl(response, args.expression);
			return;
		}
		if (args.context === 'repl' && (args.expression.startsWith('-') || args.expression.startsWith('>'))) {
			await this.evaluateInRepl(response, args.expression);
			return;
		}

		const threadId = frame?.threadId ?? this.stoppedThreadId;
		const level = frame?.level ?? 0;

		try {
			const varobj = await this.varManager.create(args.expression, threadId, level);
			const frameRef: FrameRef = { threadId, level };

			// Watches and hovers go through the same formatters as the
			// Variables view: a std::vector that reads "{ size=8 }" in one
			// place and "error: summary string parsing error" in another is
			// worse than either answer on its own.
			const formatter = this.formatters.find(varobj.type);
			if (formatter) {
				const view = await this.inspectSafely(formatter, frameRef, args.expression, varobj.type);
				if (view) {
					response.body = {
						result: view.value,
						type: varobj.type || undefined,
						variablesReference: view.indexedVariables > 0
							? this.variableHandles.create({ kind: 'formatted', formatter, view, frame: frameRef })
							: 0,
						indexedVariables: view.indexedVariables || undefined,
						memoryReference: view.memoryReference,
					};
					this.sendResponse(response);
					return;
				}
			}

			const shape = classifyType(varobj.type);
			const expandable = varobj.numchild > 0 || varobj.hasMore;

			response.body = {
				result: varobj.value,
				type: varobj.type || undefined,
				variablesReference: expandable
					? this.variableHandles.create({ kind: 'varobj', varobj, frame: { threadId, level } })
					: 0,
			};
			if (shape.isArray && shape.arrayLength) {
				response.body.indexedVariables = shape.arrayLength;
			}
			const address = await resolveMemoryAddress(this.mi, args.expression, shape, threadId, level);
			if (address) {
				response.body.memoryReference = address;
			}
			this.sendResponse(response);
		} catch (err) {
			if (args.context === 'hover') {
				// A failed hover should be silent, not a red error popup.
				this.sendErrorResponse(response, { id: 1009, format: '' });
				return;
			}
			this.sendErrorResponse(response, { id: 1009, format: (err as Error).message });
		}
	}

	private async evaluateInRepl(response: DebugProtocol.EvaluateResponse, expression: string): Promise<void> {
		try {
			if (expression.startsWith('-')) {
				const record = await this.mi.sendCommand(expression);
				response.body = { result: JSON.stringify(record.results), variablesReference: 0 };
			} else {
				const text = await this.mi.sendCliCommand(expression.replace(/^>\s*/, ''));
				response.body = { result: text.trimEnd(), variablesReference: 0 };
			}
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, { id: 1010, format: (err as Error).message });
		}
	}

	protected override async setExpressionRequest(
		response: DebugProtocol.SetExpressionResponse,
		args: DebugProtocol.SetExpressionArguments,
	): Promise<void> {
		try {
			const record = await this.mi.sendCommand(
				`-data-evaluate-expression ${quoteMiString(`${args.expression} = ${args.value}`)}`);
			response.body = { value: miString(record.results['value']) };
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, { id: 1011, format: (err as Error).message, showUser: true });
		}
	}

	/* ---------------------------------------------------------------------
	 * Memory - the Hex Editor integration
	 * ------------------------------------------------------------------ */

	/**
	 * Serve VS Code's native Hex Editor from `-data-read-memory-bytes`.
	 *
	 * GDB answers with one block per readable span, so an unmapped hole in the
	 * middle of a UB window comes back as a gap rather than an error. We return
	 * the contiguous run that starts at the requested address and report the
	 * rest as unreadable, which is exactly how the Hex Editor wants to be told.
	 */
	protected override async readMemoryRequest(
		response: DebugProtocol.ReadMemoryResponse,
		args: DebugProtocol.ReadMemoryArguments,
	): Promise<void> {
		const count = args.count ?? 0;
		if (count <= 0) {
			response.body = { address: args.memoryReference, data: '', unreadableBytes: 0 };
			this.sendResponse(response);
			return;
		}

		const start = await this.resolveAddressExpression(args.memoryReference, args.offset ?? 0);
		if (start === undefined) {
			this.sendErrorResponse(response, {
				id: 1012,
				format: `Cannot resolve "${args.memoryReference}" to an address.`,
			});
			return;
		}
		const startHex = `0x${start.toString(16)}`;

		try {
			const record = await this.mi.sendCommand(`-data-read-memory-bytes ${startHex} ${count}`);
			const blocks = miList(record.results['memory'], 'memory')
				.map((b) => ({
					begin: parseAddress(miString(b['begin'])) ?? 0n,
					end: parseAddress(miString(b['end'])) ?? 0n,
					contents: miString(b['contents']),
				}))
				.filter((b) => b.contents.length > 0)
				.sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : 0));

			if (!blocks.length) {
				response.body = { address: startHex, data: '', unreadableBytes: count };
				this.sendResponse(response);
				return;
			}

			// Concatenate blocks while they stay contiguous; stop at the first hole.
			let hex = '';
			let cursor = blocks[0].begin;
			const firstAddress = blocks[0].begin;
			for (const block of blocks) {
				if (block.begin !== cursor) {
					break;
				}
				hex += block.contents;
				cursor = block.end;
			}

			const bytes = Buffer.from(hex, 'hex');
			const readable = Math.min(bytes.length, count);
			response.body = {
				address: `0x${firstAddress.toString(16)}`,
				data: bytes.subarray(0, readable).toString('base64'),
				unreadableBytes: Math.max(0, count - readable),
			};
			this.sendResponse(response);
		} catch (err) {
			// "Cannot access memory at address 0x..." is a normal answer for an
			// unmapped NPU window; report it as unreadable rather than failing,
			// so the editor renders question marks instead of an error toast.
			const message = (err as Error).message;
			if (/cannot access memory/i.test(message)) {
				response.body = { address: startHex, data: '', unreadableBytes: count };
				this.sendResponse(response);
				return;
			}
			this.sendErrorResponse(response, { id: 1013, format: message });
		}
	}

	protected override async writeMemoryRequest(
		response: DebugProtocol.WriteMemoryResponse,
		args: DebugProtocol.WriteMemoryArguments,
	): Promise<void> {
		const start = await this.resolveAddressExpression(args.memoryReference, args.offset ?? 0);
		if (start === undefined) {
			this.sendErrorResponse(response, {
				id: 1014,
				format: `Cannot resolve "${args.memoryReference}" to an address.`,
			});
			return;
		}
		const bytes = Buffer.from(args.data, 'base64');
		if (!bytes.length) {
			response.body = { bytesWritten: 0 };
			this.sendResponse(response);
			return;
		}

		try {
			const written = await this.writeBytes(start, bytes);
			response.body = { offset: 0, bytesWritten: written };
			this.sendResponse(response);
			// Nudge any open hex editor to re-read what we just changed.
			this.sendEvent(new MemoryEvent(args.memoryReference, args.offset ?? 0, written));
		} catch (err) {
			this.sendErrorResponse(response, { id: 1015, format: (err as Error).message, showUser: true });
		}
	}

	/**
	 * Write bytes to the target.
	 *
	 * `-data-write-memory-bytes` is the one command the adapter uses that
	 * msdebug-mi (lldb-mi) does not implement, so on failure we fall back to
	 * byte-wise assignment through the expression evaluator. That is slow, but
	 * hex-editor edits are small, and it keeps the capability honest rather than
	 * advertising a write path that silently fails on the CANN debugger.
	 */
	private async writeBytes(start: bigint, bytes: Buffer): Promise<number> {
		if (this.supportsWriteMemoryBytes !== false) {
			try {
				await this.mi.sendCommand(
					`-data-write-memory-bytes 0x${start.toString(16)} ${quoteMiString(bytes.toString('hex'))}`);
				this.supportsWriteMemoryBytes = true;
				return bytes.length;
			} catch (err) {
				if (!isUnsupportedCommand(err)) {
					throw err;
				}
				this.supportsWriteMemoryBytes = false;
				this.sendEvent(new OutputEvent(
					'-data-write-memory-bytes is unavailable; falling back to expression writes.\n',
					'console'));
			}
		}

		for (let i = 0; i < bytes.length; i++) {
			const address = start + BigInt(i);
			await this.mi.sendCommand(`-data-evaluate-expression ${quoteMiString(
				`*(unsigned char *)0x${address.toString(16)} = ${bytes[i]}`)}`);
		}
		return bytes.length;
	}

	/**
	 * memoryReference is usually already `0x...`, but the NPU Memory scope and
	 * user-typed references may be GDB expressions, so fall back to evaluation.
	 */
	private async resolveAddressExpression(reference: string, offset: number): Promise<bigint | undefined> {
		const literal = parseAddress(reference);
		if (literal !== undefined) {
			return literal + BigInt(offset);
		}
		try {
			const record = await this.mi.sendCommand(
				`-data-evaluate-expression ${quoteMiString(`(unsigned long long)(${reference})`)}`);
			const m = /^(0x[0-9a-fA-F]+|\d+)/.exec(miString(record.results['value']).trim());
			return m ? BigInt(m[1]) + BigInt(offset) : undefined;
		} catch {
			return undefined;
		}
	}

	/* ---------------------------------------------------------------------
	 * Disassembly
	 * ------------------------------------------------------------------ */

	protected override async disassembleRequest(
		response: DebugProtocol.DisassembleResponse,
		args: DebugProtocol.DisassembleArguments,
	): Promise<void> {
		const base = await this.resolveAddressExpression(args.memoryReference, args.offset ?? 0);
		if (base === undefined) {
			this.sendErrorResponse(response, { id: 1016, format: 'Cannot resolve the disassembly address.' });
			return;
		}

		// Ascend cores, like the aarch64 host side, use fixed 4-byte instructions,
		// so a negative instructionOffset can be turned into a byte offset. On a
		// variable-width ISA this would only be an approximation.
		const instructionCount = args.instructionCount ?? 1;
		const instructionOffset = args.instructionOffset ?? 0;
		const bytesPerInstruction = 4n;
		const start = base + BigInt(instructionOffset) * bytesPerInstruction;
		const end = start + BigInt(instructionCount) * bytesPerInstruction;

		try {
			const record = await this.mi.sendCommand(
				`-data-disassemble -s 0x${start.toString(16)} -e 0x${end.toString(16)} -- 2`);
			const instructions: DebugProtocol.DisassembledInstruction[] = [];
			for (const insn of miList(record.results['asm_insns'], 'src_and_asm_line')) {
				const inner = insn['line_asm_insn'] !== undefined
					? miList(insn['line_asm_insn'], 'line_asm_insn')
					: [insn];
				for (const i of inner) {
					const address = miString(i['address']);
					if (!address) {
						continue;
					}
					instructions.push({
						address,
						instruction: miString(i['inst']),
						instructionBytes: miString(i['opcodes']) || undefined,
						symbol: miString(i['func-name']) || undefined,
					});
				}
			}
			// The view requires exactly instructionCount entries; pad the tail.
			while (instructions.length < instructionCount) {
				const addr = start + BigInt(instructions.length) * bytesPerInstruction;
				instructions.push({ address: `0x${addr.toString(16)}`, instruction: '(unreadable)' });
			}
			response.body = { instructions: instructions.slice(0, instructionCount) };
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, { id: 1017, format: (err as Error).message });
		}
	}

	/* ---------------------------------------------------------------------
	 * Custom requests (used by the extension's commands)
	 * ------------------------------------------------------------------ */

	protected override async customRequest(
		command: string,
		response: DebugProtocol.Response,
		args: { text?: string; region?: NpuMemoryRegion },
	): Promise<void> {
		switch (command) {
			case 'ascend/miCommand': {
				const text = args?.text ?? '';
				try {
					const result = text.startsWith('-')
						? JSON.stringify((await this.mi.sendCommand(text)).results, null, 2)
						: await this.mi.sendCliCommand(text);
					response.body = { output: result };
					this.sendResponse(response);
				} catch (err) {
					this.sendErrorResponse(response, { id: 1018, format: (err as Error).message, showUser: true });
				}
				return;
			}
			case 'ascend/resolveRegion': {
				const address = args?.region ? await this.resolveRegionAddress(args.region) : undefined;
				response.body = { address };
				this.sendResponse(response);
				return;
			}
			default:
				super.customRequest(command, response, args);
		}
	}

	/* ---------------------------------------------------------------------
	 * Helpers
	 * ------------------------------------------------------------------ */

	/** Guest path from GDB -> a Source VS Code can actually open. */
	private createSource(guestPath: string): Source | undefined {
		if (!guestPath || guestPath === '??') {
			return undefined;
		}
		const hostPath = this.mapper.toHost(guestPath);
		const source = new Source(basename(hostPath.replace(/\\/g, '/')), hostPath);
		if (!this.hostFileExists(hostPath)) {
			// Keep the frame clickable-looking but mark it as not-on-disk rather
			// than letting VS Code pop up a "file not found" editor.
			(source as DebugProtocol.Source).presentationHint = 'deemphasize';
		}
		return source;
	}

	private hostFileExists(hostPath: string): boolean {
		const cached = this.sourceExistsCache.get(hostPath);
		if (cached !== undefined) {
			return cached;
		}
		let exists = false;
		try {
			exists = existsSync(hostPath);
		} catch {
			exists = false;
		}
		this.sourceExistsCache.set(hostPath, exists);
		return exists;
	}
}

/* -------------------------------------------------------------------------
 * Module-level helpers
 * ---------------------------------------------------------------------- */

function mapStopReason(reason: string): string {
	switch (reason) {
		case 'breakpoint-hit': return 'breakpoint';
		case 'watchpoint-trigger':
		case 'read-watchpoint-trigger':
		case 'access-watchpoint-trigger': return 'data breakpoint';
		case 'end-stepping-range':
		case 'function-finished': return 'step';
		case 'signal-received': return 'exception';
		case 'solib-event': return 'pause';
		case '': return 'pause';
		default: return reason;
	}
}

function isVerified(bkpt: { [key: string]: unknown }): boolean {
	const addr = miString(bkpt['addr'] as never);
	if (!addr) {
		return false;
	}
	return addr !== '<PENDING>';
}

/** `-break-insert` may answer with one tuple or several (multiple locations). */
function firstTuple(value: unknown): { [key: string]: never } | undefined {
	const t = miTuple(value as never);
	if (t) {
		return t as never;
	}
	const arr = miArray(value as never);
	for (const item of arr) {
		const inner = miTuple(item);
		if (inner) {
			return inner as never;
		}
	}
	return undefined;
}

/**
 * True when GDB/lldb-mi rejected a command because it does not exist, as
 * opposed to failing to carry it out.
 */
function isUnsupportedCommand(err: unknown): boolean {
	const message = (err as Error)?.message ?? '';
	return /undefined mi command|unrecognized|not implemented|unknown command|invalid command/i.test(message);
}

/** Accepts `0x...`, decimal, and tolerates a trailing symbol annotation. */
export function parseAddress(text: string | undefined): bigint | undefined {
	if (!text) {
		return undefined;
	}
	const m = /^\s*(0[xX][0-9a-fA-F]+|\d+)\s*$/.exec(text);
	if (!m) {
		return undefined;
	}
	try {
		return BigInt(m[1]);
	} catch {
		return undefined;
	}
}

/** VS Code sends hit conditions like "5", "> 5" or "% 3"; GDB only has ignore counts. */
function parseHitCondition(hitCondition: string | undefined): number | undefined {
	if (!hitCondition) {
		return undefined;
	}
	const m = /(\d+)/.exec(hitCondition);
	if (!m) {
		return undefined;
	}
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	// GDB skips the next `n` hits, so "break on the 5th hit" is an ignore count of 4.
	return /^\s*[>=]/.test(hitCondition) || /^\s*\d+\s*$/.test(hitCondition) ? n - 1 : n;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MiB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(bytes % 1024 ? 1 : 0)} KiB`;
	}
	return `${bytes} B`;
}
