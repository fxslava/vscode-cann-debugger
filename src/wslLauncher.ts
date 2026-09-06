/*---------------------------------------------------------------------------
 * Builds the host-side command line that starts the debugger, for all three
 * execution modes.
 *
 * The debugger is never spawned bare. It is wrapped in a login shell so we can
 * source the CANN environment (set_env.sh exports ASCEND_HOME_PATH,
 * LD_LIBRARY_PATH and the simulator paths the debugger needs) and then `exec`
 * the debugger, which keeps the shell's PID as the debugger's PID - that PID
 * is what Pause signals later.
 *
 *   native   <gdb> --interpreter=mi2
 *   wsl      wsl.exe -d D -e /bin/bash -lc ". set_env.sh; exec <gdb> ..."
 *   docker   wsl.exe -d D -e docker exec -i C /bin/bash -lc ". set_env.sh; ..."
 *   ssh      wsl.exe -d D -e sshpass -e ssh -T u@h "/bin/bash -lc '. set_env.sh; ...'"
 *
 * The last two differ in one way that is easy to miss. `docker exec` takes the
 * guest shell as separate argv elements, which cross the boundary untouched.
 * `ssh` does not: it joins its trailing arguments with spaces and feeds the
 * result to the remote login shell, so the shell invocation has to be quoted
 * into a single element first - hence the extra shQuote layer in the ssh case.
 *-------------------------------------------------------------------------*/

import { ExecutionMode } from './configuration';
import { buildContainerCommand, DockerOptions } from './dockerLauncher';
import { MiLaunchSpec } from './mi/miConnection';
import { buildSshCommand, SshOptions } from './sshLauncher';

export interface WslOptions {
	enabled?: boolean;
	distro?: string;
	user?: string;
	wslPath?: string;
	shell?: string;
}

export interface DebuggerSpawnOptions {
	mode: ExecutionMode;
	wsl?: WslOptions;
	docker?: DockerOptions;
	ssh?: SshOptions;
	/** Debugger executable inside the guest. */
	gdbPath: string;
	gdbArgs?: string[];
	miMode?: string;
	/** Guest-side working directory, applied with `cd` inside the guest shell. */
	cwd?: string;
	/**
	 * Host-side working directory for the spawn itself. Must never be the guest
	 * cwd: handing `/mnt/d/...` or `/tests` to a Windows spawn fails with ENOENT.
	 */
	hostCwd?: string;
	/** Guest path of the CANN environment script to source. */
	setupScript?: string;
	environment?: Array<{ name: string; value: string }>;
	/**
	 * Environment the spawn inherits. Injected for tests; in production this is
	 * the adapter's own environment, which is where the extension host left the
	 * SSH password (see sshLauncher.DEFAULT_PASSWORD_ENV_VAR).
	 */
	hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Echoed on stderr by the guest wrapper. `$$` is the shell's PID, and because
 * the shell then `exec`s the debugger, it is the debugger's PID too.
 * Unquoted on purpose: no spaces, so it survives every quoting layer.
 */
export const GUEST_PID_ECHO = 'echo __ASCEND_GDB_PID__:$$ >&2';

export function buildDebuggerSpawn(options: DebuggerSpawnOptions): MiLaunchSpec {
	const miMode = options.miMode || 'mi2';
	// gdbArgs come before --interpreter so that a wrapper needing its own
	// leading argument (a script interpreter, a launcher) still works; both GDB
	// and lldb-mi accept these options in any order.
	const gdbArgv = [
		options.gdbPath,
		...(options.gdbArgs ?? []),
		`--interpreter=${miMode}`,
		'-q',
	];

	if (options.mode === 'native') {
		// Native debugger: no shell wrapper, no boundary to cross.
		const env = { ...process.env };
		for (const e of options.environment ?? []) {
			env[e.name] = e.value;
		}
		return {
			command: gdbArgv[0],
			args: gdbArgv.slice(1),
			cwd: options.hostCwd,
			env,
		};
	}

	const hostEnv = options.hostEnv ?? process.env;
	const shell = options.wsl?.shell || '/bin/bash';
	const script = buildGuestScript(options, gdbArgv);
	const shellArgv = [shell, '-lc', script];

	if (options.mode === 'ssh') {
		// One argv element, already quoted for the remote login shell.
		const remoteCommand = `${shell} -lc ${shQuote(script)}`;
		const invocation = buildSshCommand(options.ssh ?? {}, options.wsl, remoteCommand, hostEnv);
		return {
			command: invocation.argv[0],
			args: invocation.argv.slice(1),
			// SSHPASS rides here rather than in argv, and WSLENV carries it over
			// the wsl.exe boundary when the client runs inside the distro.
			env: { ...hostEnv, ...invocation.env },
		};
	}

	const argv = options.mode === 'docker'
		? buildContainerCommand(options.docker ?? {}, options.wsl, shellArgv)
		: buildWslCommand(options.wsl, shellArgv);

	return {
		command: argv[0],
		args: argv.slice(1),
		// WSLENV would be needed to forward host variables; we export inside the
		// guest script instead, which is explicit and distro-independent.
		env: hostEnv,
	};
}

function buildWslCommand(wsl: WslOptions | undefined, innerArgv: string[]): string[] {
	const argv = [wsl?.wslPath || 'wsl.exe'];
	if (wsl?.distro) {
		argv.push('-d', wsl.distro);
	}
	if (wsl?.user) {
		argv.push('-u', wsl.user);
	}
	argv.push('-e');
	return argv.concat(innerArgv);
}

export interface SignalOptions {
	mode: ExecutionMode;
	wsl?: WslOptions;
	docker?: DockerOptions;
	ssh?: SshOptions;
	hostEnv?: NodeJS.ProcessEnv;
}

/**
 * argv prefix that runs an arbitrary command in the same environment as the
 * debugger. Used by Pause, which needs to deliver SIGINT on the far side of
 * whatever boundaries the debugger lives behind.
 */
export function buildSignalPrefix(options: SignalOptions): string[] | undefined {
	if (options.mode === 'native') {
		return undefined;
	}
	if (options.mode === 'docker') {
		if (!options.docker?.containerName) {
			return undefined;
		}
		// `buildContainerCommand` with an empty inner argv yields the prefix.
		return buildContainerCommand(options.docker, options.wsl, []);
	}
	if (options.mode === 'ssh') {
		if (!options.ssh?.host) {
			return undefined;
		}
		// The caller appends ["kill","-INT",pid]; ssh joins those with spaces
		// into a command the remote shell runs verbatim, so no quoting is owed.
		return buildSshCommand(options.ssh, options.wsl, '', options.hostEnv).argv;
	}
	return buildWslCommand(options.wsl, []);
}

/**
 * Environment the signal spawn needs. Only ssh has one: sshpass must find the
 * password again, and the interrupt runs as its own short-lived process.
 */
export function buildSignalEnv(options: SignalOptions): NodeJS.ProcessEnv | undefined {
	if (options.mode !== 'ssh' || !options.ssh?.host) {
		return undefined;
	}
	const hostEnv = options.hostEnv ?? process.env;
	const invocation = buildSshCommand(options.ssh, options.wsl, '', hostEnv);
	return { ...hostEnv, ...invocation.env };
}

function buildGuestScript(options: DebuggerSpawnOptions, gdbArgv: string[]): string {
	const parts: string[] = [];

	if (options.cwd) {
		// Do not abort if the directory is missing; the debugger still starts and
		// the resulting error is far easier to read than a silent spawn failure.
		parts.push(`cd ${shQuote(options.cwd)} 2>/dev/null || echo "warning: cannot cd to ${options.cwd}" >&2`);
	}

	for (const e of options.environment ?? []) {
		parts.push(`export ${e.name}=${shQuote(e.value)}`);
	}

	if (options.setupScript) {
		const q = shQuote(options.setupScript);
		// Sourcing must not pollute stdout: MI would choke on it.
		parts.push(`if [ -f ${q} ]; then . ${q} >/dev/null 2>&1 || echo "warning: ${options.setupScript} failed" >&2; fi`);
	}

	parts.push(GUEST_PID_ECHO);
	parts.push(`exec ${gdbArgv.map(shQuote).join(' ')}`);

	return parts.join('; ');
}

/** POSIX single-quote quoting: the only form that is safe for arbitrary text. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
