/*---------------------------------------------------------------------------
 * Reaching a debugger that lives on a remote Ascend host over SSH.
 *
 * Structurally identical to dockerLauncher: an argv prefix that carries the
 * guest shell across one more boundary. The chain on a Windows host is
 *
 *   wsl.exe -d Ubuntu-22.04 -e sshpass -e ssh -T user@10.0.0.5 "/bin/bash -lc '...'"
 *   ^ host boundary          ^ password        ^ network boundary  ^ remote shell
 *
 * Two details matter for the MI stream:
 *
 *   -T  never allocate a pseudo-tty. A tty echoes every command back and
 *       line-buffers the reply, which corrupts MI exactly as `docker exec -t`
 *       would. This is why `ssh -tt`, the usual advice for remote signals, is
 *       wrong here.
 *
 *   ssh joins its trailing command arguments with spaces and hands the result
 *       to the remote login shell, so the whole guest script must arrive as a
 *       *single* argv element that is already quoted for that shell.
 *
 * The password is never written to argv. `sshpass -e` reads it from SSHPASS in
 * the environment, because argv is world-readable through /proc on the machine
 * running the client, while a process's environment is not.
 *-------------------------------------------------------------------------*/

import { WslOptions } from './wslLauncher';

/**
 * Environment variable the extension host fills from SecretStorage before it
 * spawns the adapter. The password therefore never enters launch.json, the
 * DAP `launch` request, or `session.configuration`.
 */
export const DEFAULT_PASSWORD_ENV_VAR = 'ASCEND_SSH_PASSWORD';

export interface SshOptions {
	/** Hostname or IP of the Ascend target, e.g. 192.168.1.100. */
	host?: string;
	/** TCP port of the remote sshd. Defaults to 22. */
	port?: number;
	/** Remote account, e.g. HwHiAiUser or root. */
	user?: string;
	/** Private key on the machine that runs the ssh client, not on the target. */
	identityFile?: string;
	/**
	 * Literal password. Left unset by the Target Manager, which routes the
	 * secret through `passwordEnvVar` instead; honoured for hand-written
	 * configurations that already keep their secrets elsewhere.
	 */
	password?: string;
	/** Environment variable holding the password. Defaults to ASCEND_SSH_PASSWORD. */
	passwordEnvVar?: string;
	/** ssh client executable, resolved on whichever side `viaWsl` selects. */
	sshPath?: string;
	/** sshpass executable; only consulted when a password is in play. */
	sshpassPath?: string;
	/** Extra arguments spliced in before the destination, e.g. ["-o","Compression=yes"]. */
	sshArgs?: string[];
	/**
	 * accept-new (the default) trusts a host the first time and refuses it
	 * afterwards if the key changes; "yes" refuses unknown hosts outright.
	 * An interactive prompt would hang the MI stream, so "ask" is not offered.
	 */
	strictHostKeyChecking?: 'yes' | 'no' | 'accept-new';
	/**
	 * Run the ssh client inside the WSL distribution rather than on the host.
	 * Defaults to true on Windows: Windows ships an OpenSSH client but no
	 * sshpass, and the distro is already a prerequisite of this extension.
	 */
	viaWsl?: boolean;
	/** Seconds between keepalives, so a stalled NPU does not wedge the session. */
	serverAliveInterval?: number;
	/** Directory on the target that the binary is deployed into. */
	deployPath?: string;
}

export class SshConfigurationError extends Error {}

/** argv plus the environment that argv needs; see buildSshCommand. */
export interface SshInvocation {
	argv: string[];
	/**
	 * Overlay for the spawn's environment. Carries SSHPASS when sshpass is
	 * used, and the WSLENV entry that lets it cross the wsl.exe boundary.
	 */
	env: NodeJS.ProcessEnv;
}

/**
 * Resolve the password from the environment variable the extension host set,
 * falling back to an inline `password` for hand-written configurations.
 */
export function resolveSshPassword(
	ssh: SshOptions,
	hostEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const fromEnv = hostEnv[ssh.passwordEnvVar || DEFAULT_PASSWORD_ENV_VAR];
	return fromEnv || ssh.password || undefined;
}

/** Whether the ssh client is spawned inside the distro rather than on the host. */
export function sshRunsInWsl(ssh: SshOptions): boolean {
	return ssh.viaWsl ?? process.platform === 'win32';
}

/**
 * Build the argv that runs `remoteCommand` on the target.
 *
 * `remoteCommand` must already be a single string in remote-shell syntax; pass
 * '' to get the bare prefix, which is what Pause needs.
 */
export function buildSshCommand(
	ssh: SshOptions,
	wsl: WslOptions | undefined,
	remoteCommand: string,
	hostEnv: NodeJS.ProcessEnv = process.env,
): SshInvocation {
	if (!ssh.host) {
		throw new SshConfigurationError(
			'execution.mode is "ssh" but no target was named. ' +
			'Set "execution.ssh.host" in your launch configuration, or fill in ' +
			'Target Host in the Ascend NPU Target Manager.');
	}

	const viaWsl = sshRunsInWsl(ssh);
	const password = resolveSshPassword(ssh, hostEnv);
	const env: NodeJS.ProcessEnv = {};
	const argv: string[] = [];

	if (password) {
		argv.push(ssh.sshpassPath || 'sshpass', '-e');
		env.SSHPASS = password;
		if (viaWsl) {
			// Without this the variable stops at the wsl.exe boundary. The /u
			// flag means "only travelling Windows -> WSL", which is the only
			// direction it ever travels.
			env.WSLENV = appendWslEnv(hostEnv.WSLENV, 'SSHPASS/u');
		}
	}

	argv.push(ssh.sshPath || 'ssh');
	argv.push('-T');
	argv.push('-o', `StrictHostKeyChecking=${ssh.strictHostKeyChecking || 'accept-new'}`);
	if (!password) {
		// Key auth only: fail fast instead of blocking on a passphrase prompt
		// that nobody can answer, which would look like a startup timeout.
		argv.push('-o', 'BatchMode=yes');
	}
	// ssh's own progress chatter would otherwise land in the Debug Console on
	// every session; real failures are still reported at ERROR.
	argv.push('-o', 'LogLevel=ERROR');
	const alive = ssh.serverAliveInterval ?? 30;
	if (alive > 0) {
		argv.push('-o', `ServerAliveInterval=${alive}`);
	}
	if (ssh.identityFile) {
		argv.push('-i', ssh.identityFile);
	}
	if (ssh.port) {
		argv.push('-p', String(ssh.port));
	}
	argv.push(...(ssh.sshArgs ?? []));
	argv.push(ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host);
	if (remoteCommand) {
		argv.push(remoteCommand);
	}

	return { argv: viaWsl ? wslPrefix(wsl).concat(argv) : argv, env };
}

/**
 * wsl.exe prefix. Duplicated from wslLauncher rather than imported so that the
 * dependency stays one-way (wslLauncher -> sshLauncher), exactly as it is for
 * dockerLauncher.
 */
function wslPrefix(wsl: WslOptions | undefined): string[] {
	const argv = [wsl?.wslPath || 'wsl.exe'];
	if (wsl?.distro) {
		argv.push('-d', wsl.distro);
	}
	if (wsl?.user) {
		argv.push('-u', wsl.user);
	}
	// `-e` runs the command with no intermediate shell, so each argv element
	// crosses the boundary intact and needs no Windows-side shell quoting.
	argv.push('-e');
	return argv;
}

/** Add one entry to a WSLENV list without dropping what the user already set. */
export function appendWslEnv(existing: string | undefined, entry: string): string {
	const parts = (existing ?? '').split(':').filter(Boolean);
	const name = entry.split('/')[0];
	if (parts.some((p) => p.split('/')[0] === name)) {
		return parts.join(':');
	}
	parts.push(entry);
	return parts.join(':');
}
