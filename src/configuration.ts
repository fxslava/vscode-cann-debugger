import { DebugProtocol } from '@vscode/debugprotocol';
import { DockerOptions } from './dockerLauncher';
import { SshOptions } from './sshLauncher';
import { WslOptions } from './wslLauncher';

/**
 * Where the debugger process lives.
 *  native - same machine and filesystem as the VS Code window
 *  wsl    - inside a WSL 2 distribution
 *  docker - inside a running container, optionally reached through WSL when
 *           the Docker engine itself lives in the distro rather than on Windows
 *  ssh    - on a remote Ascend host reached over SSH, i.e. real NPU hardware
 *           rather than the container simulator
 */
export type ExecutionMode = 'native' | 'wsl' | 'docker' | 'ssh';

export interface ExecutionOptions {
	mode?: ExecutionMode;
	docker?: DockerOptions;
	ssh?: SshOptions;
}

export interface SetupCommand {
	text: string;
	description?: string;
	ignoreFailures?: boolean;
}

export interface NpuMemoryRegion {
	/** Display name, e.g. UB, L1, L0A, L0C, GM. */
	name: string;
	/** Hex literal or any GDB expression that yields the base address. */
	address: string;
	/** Window size in bytes; defaults to 4 KiB when omitted. */
	size?: number;
	description?: string;
}

export interface AscendCommonArguments {
	program?: string;
	cwd?: string;
	args?: string[];
	environment?: Array<{ name: string; value: string }>;

	gdbPath?: string;
	gdbArgs?: string[];
	miMode?: string;
	execution?: ExecutionOptions;
	wsl?: WslOptions;
	setupScript?: string;
	setupCommands?: SetupCommand[];
	postRemoteConnectCommands?: SetupCommand[];
	miDebuggerServerAddress?: string;

	sourceFileMap?: { [debuggerPath: string]: string };
	/**
	 * Whether Windows <-> guest path translation runs. "auto" enables it
	 * whenever the debugger is not a plain host-native process - i.e. under WSL,
	 * or when talking to a gdbserver that lives on a Linux machine.
	 */
	pathTranslation?: 'auto' | 'on' | 'off';
	npuMemoryRegions?: NpuMemoryRegion[];
	memoryReferences?: 'auto' | 'all' | 'off';

	/**
	 * Mirror the GDB/MI dialogue - the commands the adapter sends, GDB's
	 * replies, and GDB's own `~`/`&` chatter - into the Debug Console.
	 *
	 * Off by default, so the console carries the debuggee's output and nothing
	 * else. The traffic is still written to the adapter's log file either way,
	 * so a session can be diagnosed after the fact without re-running it.
	 */
	trace?: boolean;

	logging?: {
		/** Older spelling of the top-level `trace`. */
		engineLogging?: boolean;
		programOutput?: boolean;
		/** DAP-level tracing from the base adapter: every protocol message. */
		trace?: boolean;
	};
}

/**
 * Resolve the execution mode. `execution.mode` wins; otherwise fall back to the
 * older `wsl.enabled` switch so existing launch configurations keep working.
 */
export function resolveExecutionMode(args: AscendCommonArguments): ExecutionMode {
	if (args.execution?.mode) {
		return args.execution.mode;
	}
	return args.wsl?.enabled === false ? 'native' : 'wsl';
}

/** Resolve `pathTranslation: "auto"` against the rest of the configuration. */
export function shouldTranslatePaths(args: AscendCommonArguments): boolean {
	switch (args.pathTranslation) {
		case 'on': return true;
		case 'off': return false;
		default:
			// Only a host-native debugger with no remote target sees the same
			// filesystem the UI does; translating there would corrupt paths.
			return resolveExecutionMode(args) !== 'native' || !!args.miDebuggerServerAddress;
	}
}

export interface AscendLaunchArguments
	extends DebugProtocol.LaunchRequestArguments, AscendCommonArguments {
	program: string;
	stopAtEntry?: boolean;
	entryFunction?: string;
}

export interface AscendAttachArguments
	extends DebugProtocol.AttachRequestArguments, AscendCommonArguments {
	processId?: string;
}

export type AscendArguments = AscendLaunchArguments | AscendAttachArguments;

export const DEFAULT_SETUP_COMMANDS: SetupCommand[] = [
	{ text: '-gdb-set print pretty on', ignoreFailures: true },
	{ text: '-gdb-set print object on', ignoreFailures: true },
	{ text: '-gdb-set charset UTF-8', ignoreFailures: true },
	{ text: '-enable-pretty-printing', ignoreFailures: true },
];
