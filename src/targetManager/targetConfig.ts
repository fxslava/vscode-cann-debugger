/*---------------------------------------------------------------------------
 * The model behind the Ascend NPU Target Manager view.
 *
 * One target describes where an operator runs: the container simulator, or a
 * real NPU box reached over SSH. Everything in `AscendTarget` is safe to write
 * to disk. The SSH password deliberately is not part of it - it lives in
 * VS Code's SecretStorage, keyed by user@host:port, and is handed to the debug
 * adapter through its environment (see extension.ts) so that it never reaches
 * launch.json, the DAP `launch` request, or `session.configuration`.
 *-------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

export type TargetMode = 'docker' | 'hardware';

export interface AscendTarget {
	/** docker = CANN container simulator; hardware = remote Ascend device. */
	mode: TargetMode;

	/** Host path of the built ELF. May contain ${workspaceFolder}. */
	program: string;
	/** Whitespace-separated arguments for the debuggee. */
	args: string;
	stopAtEntry: boolean;

	/* --- remote hardware --- */
	host: string;
	port: number;
	username: string;
	/** Directory on the target the binary is copied into. */
	deployPath: string;
	/** Private key on the machine running the ssh client; empty = password auth. */
	identityFile: string;

	/* --- container simulator --- */
	containerName: string;
	dockerViaWsl: boolean;

	/* --- shared --- */
	wslDistro: string;
	gdbPath: string;
	setupScript: string;

	/** Also write the generated configuration into .vscode/launch.json. */
	updateLaunchJson: boolean;
}

export const DEFAULT_TARGET: AscendTarget = {
	mode: 'docker',
	program: '${workspaceFolder}/build/test_kernel',
	args: '',
	stopAtEntry: true,
	host: '',
	port: 22,
	username: 'HwHiAiUser',
	deployPath: '/home/HwHiAiUser/ascend-debug',
	identityFile: '',
	containerName: 'ascend-suites',
	dockerViaWsl: true,
	wslDistro: '',
	gdbPath: '/usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi',
	setupScript: '/usr/local/Ascend/ascend-toolkit/set_env.sh',
	updateLaunchJson: true,
};

const SECTION = 'ascend-gdb';
const TARGET_KEY = 'target';

/** Name of the configuration the manager owns in .vscode/launch.json. */
export const GENERATED_CONFIG_NAME = 'Ascend NPU: Deploy & Debug';

export function readTarget(folder?: vscode.WorkspaceFolder): AscendTarget {
	const stored = vscode.workspace
		.getConfiguration(SECTION, folder?.uri)
		.get<Partial<AscendTarget>>(TARGET_KEY);
	// Spread over the defaults so a target written by an older version, or
	// hand-edited down to two keys, still yields a complete object.
	return { ...DEFAULT_TARGET, ...(stored ?? {}) };
}

export async function writeTarget(
	target: AscendTarget,
	folder?: vscode.WorkspaceFolder,
): Promise<void> {
	const scope = folder
		? vscode.ConfigurationTarget.WorkspaceFolder
		: vscode.ConfigurationTarget.Workspace;
	await vscode.workspace
		.getConfiguration(SECTION, folder?.uri)
		.update(TARGET_KEY, target, scope);
}

/* ------------------------------ secrets -------------------------------- */

/** Identity of the account whose password is stored, and nothing more. */
export interface CredentialIdentity {
	host?: string;
	port?: number;
	user?: string;
}

/**
 * Key under which the password is stored. Including user, host and port means
 * pointing the view at a second box does not silently reuse the first box's
 * password, and changing the username invalidates the old secret rather than
 * masking a typo as an authentication failure.
 */
export function secretKey(id: CredentialIdentity): string {
	return `${SECTION}.ssh.password:${id.user ?? ''}@${id.host ?? ''}:${id.port ?? 22}`;
}

export function readPassword(
	secrets: vscode.SecretStorage,
	id: CredentialIdentity,
): Thenable<string | undefined> {
	return secrets.get(secretKey(id));
}

export function writePassword(
	secrets: vscode.SecretStorage,
	id: CredentialIdentity,
	password: string,
): Thenable<void> {
	return secrets.store(secretKey(id), password);
}

export function deletePassword(
	secrets: vscode.SecretStorage,
	id: CredentialIdentity,
): Thenable<void> {
	return secrets.delete(secretKey(id));
}

/* ---------------------------- variables -------------------------------- */

/**
 * Expand the handful of variables that have to be resolved *before* the debug
 * session starts, because the deploy step needs a real path on this machine.
 * VS Code expands the rest itself when the configuration reaches it.
 */
export function resolveVariables(value: string, folder?: vscode.WorkspaceFolder): string {
	if (!value || !folder) {
		return value;
	}
	return value
		.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath)
		.replace(/\$\{workspaceFolderBasename\}/g, path.basename(folder.uri.fsPath));
}

/** POSIX join that does not go through path.win32 on a Windows host. */
export function remoteJoin(dir: string, name: string): string {
	return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Remote path the binary ends up at once deployed. */
export function remoteProgramPath(
	target: AscendTarget,
	folder?: vscode.WorkspaceFolder,
): string {
	const local = resolveVariables(target.program, folder);
	return remoteJoin(target.deployPath, path.basename(local.replace(/\\/g, '/')));
}

/* -------------------------- launch synthesis ---------------------------- */

/**
 * Turn a target into the launch configuration the adapter understands.
 * Contains no secret: the password is injected into the adapter's environment
 * by the DebugAdapterDescriptorFactory instead.
 */
export function buildLaunchConfiguration(
	target: AscendTarget,
	folder?: vscode.WorkspaceFolder,
): vscode.DebugConfiguration {
	const wsl = { enabled: true, distro: target.wslDistro || undefined };
	const args = target.args.trim() ? target.args.trim().split(/\s+/) : [];

	const common: vscode.DebugConfiguration = {
		type: 'ascend-gdb',
		request: 'launch',
		name: GENERATED_CONFIG_NAME,
		args,
		stopAtEntry: target.stopAtEntry,
		gdbPath: target.gdbPath,
		setupScript: target.setupScript,
		wsl,
	};

	if (target.mode === 'hardware') {
		const remoteProgram = remoteProgramPath(target, folder);
		return {
			...common,
			name: `${GENERATED_CONFIG_NAME} (${target.host})`,
			// The binary was deployed, so both of these are paths on the target.
			program: remoteProgram,
			cwd: target.deployPath,
			execution: {
				mode: 'ssh',
				ssh: {
					host: target.host,
					port: target.port,
					user: target.username,
					deployPath: target.deployPath,
					// Empty means password auth, which the adapter picks up from
					// its environment; a key makes the password irrelevant.
					identityFile: target.identityFile || undefined,
				},
			},
		};
	}

	return {
		...common,
		program: target.program,
		cwd: '${workspaceFolder}',
		execution: {
			mode: 'docker',
			docker: {
				containerName: target.containerName,
				viaWsl: target.dockerViaWsl,
			},
		},
	};
}

/**
 * Write the generated configuration into .vscode/launch.json, replacing the
 * entry this view owns and leaving every hand-written one alone.
 */
export async function syncLaunchJson(
	config: vscode.DebugConfiguration,
	folder?: vscode.WorkspaceFolder,
): Promise<void> {
	const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
	const existing = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
	// Match on the stable prefix: the hardware variant appends the host, so the
	// entry has to be recognised even after the target moves to another box.
	const kept = existing.filter((c) => !String(c.name ?? '').startsWith(GENERATED_CONFIG_NAME));
	await launch.update(
		'configurations',
		[config, ...kept],
		folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace,
	);
}

/* ----------------------------- validation ------------------------------- */

/** Problems that would fail at launch, reported while they are still cheap. */
export function validateTarget(target: AscendTarget): string[] {
	const problems: string[] = [];

	if (!target.program.trim()) {
		problems.push('Program is required: point it at the built kernel binary.');
	}
	if (!target.gdbPath.trim()) {
		problems.push('Debugger path is required (msdebug-mi or ascend-gdb).');
	}

	if (target.mode === 'hardware') {
		if (!target.host.trim()) {
			problems.push('Target host is required for remote NPU hardware.');
		}
		if (!target.username.trim()) {
			problems.push('SSH username is required for remote NPU hardware.');
		}
		if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
			problems.push('SSH port must be between 1 and 65535.');
		}
		if (!target.deployPath.trim().startsWith('/')) {
			problems.push('Deploy path must be an absolute path on the target, e.g. /home/HwHiAiUser/ascend-debug.');
		}
	} else if (!target.containerName.trim()) {
		problems.push('Container name is required for the Docker simulator.');
	}

	return problems;
}
