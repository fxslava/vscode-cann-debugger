/*---------------------------------------------------------------------------
 * The "Ascend NPU Target" sidebar view.
 *
 * Owns the form, the secret, and the Deploy & Debug flow:
 *
 *   form -> workspace settings (+ .vscode/launch.json)
 *        -> SecretStorage                    (password, never on disk in clear)
 *        -> SFTP upload of the ELF           (hardware mode only)
 *        -> vscode.debug.startDebugging      (with the synthesised config)
 *
 * The webview is untrusted in the usual sense: every message it sends is
 * treated as form data and validated here, and nothing it sends can name a
 * command to run.
 *-------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	deployBinary,
	DeployError,
	probeTarget,
	withConnection,
} from './deploy';
import {
	AscendTarget,
	buildLaunchConfiguration,
	DEFAULT_TARGET,
	deletePassword,
	readPassword,
	readTarget,
	resolveVariables,
	syncLaunchJson,
	validateTarget,
	writePassword,
	writeTarget,
} from './targetConfig';

type StatusLevel = 'ok' | 'warn' | 'error' | '';

interface WebviewMessage {
	type: string;
	target?: unknown;
	password?: string;
}

export class TargetViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ascend-gdb.targetManager';

	private view?: vscode.WebviewView;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			// The view may only load the two files it ships with.
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		view.webview.html = this.render(view.webview);
		view.webview.onDidReceiveMessage(
			(message: WebviewMessage) => void this.onMessage(message),
			undefined,
			this.context.subscriptions,
		);
	}

	/** Focus the view and start the flow, for the command-palette entry point. */
	public async deployAndDebugFromCommand(): Promise<void> {
		await vscode.commands.executeCommand(`${TargetViewProvider.viewType}.focus`);
		const target = readTarget(this.folder());
		await this.deployAndDebug(target, undefined);
	}

	/* ----------------------------- messages ----------------------------- */

	private async onMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				return this.sendInit();
			case 'save':
				return this.withBusy(() => this.save(this.coerce(message.target), message.password, true));
			case 'deployAndDebug':
				return this.withBusy(() =>
					this.deployAndDebug(this.coerce(message.target), message.password));
			case 'testConnection':
				return this.withBusy(() =>
					this.testConnection(this.coerce(message.target), message.password));
			case 'clearPassword':
				return this.clearPassword(this.coerce(message.target));
			case 'browseProgram':
				return this.browse('program', false);
			case 'browseIdentityFile':
				return this.browse('identityFile', true);
			default:
				// Unknown message types are dropped rather than dispatched.
				return;
		}
	}

	private async sendInit(): Promise<void> {
		const target = readTarget(this.folder());
		const stored = await readPassword(this.context.secrets, {
			host: target.host,
			port: target.port,
			user: target.username,
		});
		this.post({
			type: 'init',
			target,
			hasPassword: !!stored,
			level: '',
			text: '',
		});
	}

	private async save(
		target: AscendTarget,
		password: string | undefined,
		announce: boolean,
	): Promise<void> {
		const problems = validateTarget(target);
		if (problems.length) {
			this.status('error', problems.join('\n'));
			return;
		}

		await writeTarget(target, this.folder());

		if (password) {
			await writePassword(
				this.context.secrets,
				{ host: target.host, port: target.port, user: target.username },
				password,
			);
			this.post({ type: 'secretState', hasPassword: true });
		}

		const config = buildLaunchConfiguration(target, this.folder());
		if (target.updateLaunchJson) {
			await syncLaunchJson(config, this.folder());
		}

		if (announce) {
			this.status(
				'ok',
				target.updateLaunchJson
					? `Saved. "${config.name}" is in .vscode/launch.json.`
					: 'Saved to workspace settings.',
			);
		}
	}

	private async deployAndDebug(
		target: AscendTarget,
		password: string | undefined,
	): Promise<void> {
		const problems = validateTarget(target);
		if (problems.length) {
			this.status('error', problems.join('\n'));
			return;
		}

		await this.save(target, password, false);
		const folder = this.folder();
		const config = buildLaunchConfiguration(target, folder);

		try {
			if (target.mode === 'hardware') {
				const localProgram = resolveVariables(target.program, folder);
				const secret = await this.requireCredentials(target, password);
				// Linux refuses to write a binary that is currently executing
				// (ETXTBSY), so the previous session has to go first. Doing it
				// here turns a confusing upload error into a redeploy.
				await stopPreviousSession();
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Deploying ${path.basename(localProgram)} to ${target.host}`,
						cancellable: false,
					},
					(progress) =>
						withConnection(
							this.context,
							{
								host: target.host,
								port: target.port,
								username: target.username,
								password: secret,
								identityFile: target.identityFile || undefined,
							},
							async (client) => {
								let last = 0;
								return deployBinary(
									client,
									localProgram,
									target.deployPath,
									(fraction) => {
										const pct = Math.round(fraction * 100);
										progress.report({
											increment: pct - last,
											message: `${pct}%`,
										});
										last = pct;
									},
								);
							},
						),
				);
				this.status(
					'ok',
					`Deployed ${formatBytes(result.bytes)} to ${result.remotePath} ` +
						`in ${(result.elapsedMs / 1000).toFixed(1)}s. Starting the debugger...`,
				);
			} else {
				this.status('', 'Starting the debugger in the container...');
			}

			const started = await vscode.debug.startDebugging(folder, config);
			if (!started) {
				this.status('error', 'VS Code refused to start the debug session. See the Debug Console.');
				return;
			}
			this.status('ok', `Debugging on ${describeTarget(target)}.`);
		} catch (err) {
			this.status('error', errorText(err));
		}
	}

	private async testConnection(
		target: AscendTarget,
		password: string | undefined,
	): Promise<void> {
		if (target.mode !== 'hardware') {
			this.status('warn', 'Test Connection applies to remote NPU hardware only.');
			return;
		}
		const problems = validateTarget(target);
		if (problems.length) {
			this.status('error', problems.join('\n'));
			return;
		}

		// Persist first: a successful test is worthless if the target it tested
		// is not the one the next launch will use.
		await this.save(target, password, false);

		try {
			const secret = await this.requireCredentials(target, password);
			const probe = await withConnection(
				this.context,
				{
					host: target.host,
					port: target.port,
					username: target.username,
					password: secret,
					identityFile: target.identityFile || undefined,
				},
				(client) => probeTarget(client, target.gdbPath),
			);

			const lines = [`Connected to ${target.username}@${target.host}:${target.port}.`];
			if (probe.uname) {
				lines.push(probe.uname);
			}
			lines.push(
				probe.debuggerFound
					? `Debugger found: ${target.gdbPath}`
					: `Debugger NOT found or not executable: ${target.gdbPath}`,
			);
			if (probe.npuSmi) {
				lines.push(probe.npuSmi);
			}
			this.status(probe.debuggerFound ? 'ok' : 'warn', lines.join('\n'));
		} catch (err) {
			this.status('error', errorText(err));
		}
	}

	private async clearPassword(target: AscendTarget): Promise<void> {
		await deletePassword(this.context.secrets, {
			host: target.host,
			port: target.port,
			user: target.username,
		});
		this.post({ type: 'secretState', hasPassword: false });
		this.status('ok', `Removed the stored password for ${target.username}@${target.host}.`);
	}

	private async browse(field: 'program' | 'identityFile', isKey: boolean): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: isKey ? 'Use this key' : 'Use this binary',
			defaultUri: this.folder()?.uri,
			title: isKey ? 'Select an SSH private key' : 'Select the built kernel binary',
		});
		if (picked?.length) {
			this.post({ type: 'patch', target: { [field]: picked[0].fsPath } });
		}
	}

	/**
	 * The password for this launch: the one just typed, else the stored one.
	 * Returns undefined for key authentication, which needs no password.
	 */
	private async requireCredentials(
		target: AscendTarget,
		typed: string | undefined,
	): Promise<string | undefined> {
		if (typed) {
			return typed;
		}
		const stored = await readPassword(this.context.secrets, {
			host: target.host,
			port: target.port,
			user: target.username,
		});
		if (stored) {
			return stored;
		}
		if (target.identityFile) {
			return undefined;
		}
		throw new DeployError(
			`No password stored for ${target.username}@${target.host}. Enter one in the ` +
			'SSH Password field, or set a private key to use key authentication.');
	}

	/* ----------------------------- plumbing ----------------------------- */

	private async withBusy(body: () => Promise<void>): Promise<void> {
		this.post({ type: 'busy', value: true });
		try {
			await body();
		} finally {
			this.post({ type: 'busy', value: false });
		}
	}

	/**
	 * Rebuild a trustworthy target from whatever the webview sent. Anything
	 * missing or of the wrong type falls back to the default, so a malformed
	 * message cannot smuggle e.g. a number into `gdbPath`.
	 */
	private coerce(raw: unknown): AscendTarget {
		const input = (raw ?? {}) as Record<string, unknown>;
		const str = (key: keyof AscendTarget) =>
			typeof input[key] === 'string' ? (input[key] as string).trim() : (DEFAULT_TARGET[key] as string);
		const bool = (key: keyof AscendTarget) =>
			typeof input[key] === 'boolean' ? (input[key] as boolean) : (DEFAULT_TARGET[key] as boolean);

		const port = Number(input.port);
		return {
			mode: input.mode === 'hardware' ? 'hardware' : 'docker',
			program: str('program'),
			args: typeof input.args === 'string' ? input.args : '',
			stopAtEntry: bool('stopAtEntry'),
			host: str('host'),
			port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_TARGET.port,
			username: str('username'),
			deployPath: str('deployPath'),
			identityFile: str('identityFile'),
			containerName: str('containerName'),
			dockerViaWsl: bool('dockerViaWsl'),
			wslDistro: str('wslDistro'),
			gdbPath: str('gdbPath'),
			setupScript: str('setupScript'),
			updateLaunchJson: bool('updateLaunchJson'),
		};
	}

	private folder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private status(level: StatusLevel, text: string): void {
		this.post({ type: 'status', level, text });
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	/* ------------------------------- html -------------------------------- */

	private render(webview: vscode.Webview): string {
		const asset = (name: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
		const nonce = crypto.randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('targetManager.css')}">
<title>Ascend NPU Target</title>
</head>
<body>
	<div class="field">
		<label for="mode">Execution Mode</label>
		<select id="mode">
			<option value="docker">Docker Simulator (CANN container)</option>
			<option value="hardware">Remote NPU Hardware (SSH)</option>
		</select>
	</div>

	<div id="hardwareGroup" hidden>
		<h2>Ascend Target</h2>
		<div class="row">
			<div class="field">
				<label for="host">Target Host / IP</label>
				<input type="text" id="host" placeholder="192.168.1.100" spellcheck="false" autocomplete="off">
			</div>
			<div class="field narrow">
				<label for="port">Port</label>
				<input type="number" id="port" min="1" max="65535">
			</div>
		</div>
		<div class="field">
			<label for="username">SSH Username</label>
			<input type="text" id="username" placeholder="HwHiAiUser" spellcheck="false" autocomplete="off">
		</div>
		<div class="field">
			<label for="password">SSH Password</label>
			<input type="password" id="password" placeholder="Stored in VS Code Secret Storage" autocomplete="new-password">
			<div class="secret-state" id="secretState"></div>
		</div>
		<div class="field">
			<label for="identityFile">Private Key (optional, overrides the password)</label>
			<div class="with-button">
				<input type="text" id="identityFile" placeholder="C:\\Users\\me\\.ssh\\id_ed25519" spellcheck="false">
				<button id="browseIdentityFile" type="button">Browse</button>
			</div>
		</div>
		<div class="field">
			<label for="deployPath">Deploy Path on Target</label>
			<input type="text" id="deployPath" placeholder="/home/HwHiAiUser/ascend-debug" spellcheck="false">
			<span class="hint">The binary is copied here, chmod +x, and debugged in place.</span>
		</div>
	</div>

	<div id="dockerGroup" hidden>
		<h2>Container</h2>
		<div class="field">
			<label for="containerName">Container Name</label>
			<input type="text" id="containerName" placeholder="ascend-suites" spellcheck="false">
		</div>
		<div class="check">
			<input type="checkbox" id="dockerViaWsl">
			<label for="dockerViaWsl">Run the docker CLI inside WSL</label>
		</div>
	</div>

	<h2>Program</h2>
	<div class="field">
		<label for="program">Binary (ELF)</label>
		<div class="with-button">
			<input type="text" id="program" spellcheck="false">
			<button id="browseProgram" type="button">Browse</button>
		</div>
	</div>
	<div class="field">
		<label for="args">Arguments</label>
		<input type="text" id="args" spellcheck="false">
	</div>
	<div class="check">
		<input type="checkbox" id="stopAtEntry">
		<label for="stopAtEntry">Stop at entry</label>
	</div>

	<h2>Toolchain</h2>
	<div class="field">
		<label for="gdbPath">Debugger (msdebug-mi / ascend-gdb)</label>
		<input type="text" id="gdbPath" spellcheck="false">
	</div>
	<div class="field">
		<label for="setupScript">CANN Setup Script</label>
		<input type="text" id="setupScript" spellcheck="false">
	</div>
	<div class="field">
		<label for="wslDistro">WSL Distribution</label>
		<input type="text" id="wslDistro" placeholder="default distribution" spellcheck="false">
		<span class="hint">Used for the docker hop, and for the ssh client on Windows.</span>
	</div>
	<div class="check">
		<input type="checkbox" id="updateLaunchJson">
		<label for="updateLaunchJson">Also write .vscode/launch.json</label>
	</div>

	<div class="actions">
		<button id="deployAndDebug" class="primary" type="button">Deploy &amp; Debug</button>
		<div class="secondary-row">
			<button id="save" type="button">Save</button>
			<button id="testConnection" type="button">Test Connection</button>
			<button id="clearPassword" type="button">Forget Password</button>
		</div>
	</div>

	<div id="status" hidden></div>

	<script nonce="${nonce}" src="${asset('targetManager.js')}"></script>
</body>
</html>`;
	}
}

/**
 * End any session this view started, and wait for it to actually be gone.
 * `stopDebugging` resolves when the request is sent, not when the adapter has
 * exited, so we wait on the termination event with a short ceiling.
 */
async function stopPreviousSession(): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (session?.type !== 'ascend-gdb') {
		return;
	}
	const terminated = new Promise<void>((resolve) => {
		const subscription = vscode.debug.onDidTerminateDebugSession((ended) => {
			if (ended.id === session.id) {
				subscription.dispose();
				resolve();
			}
		});
		setTimeout(() => {
			subscription.dispose();
			resolve();
		}, 5000);
	});
	await vscode.debug.stopDebugging(session);
	await terminated;
}

function describeTarget(target: AscendTarget): string {
	return target.mode === 'hardware'
		? `${target.username}@${target.host}:${target.port}`
		: `container ${target.containerName}`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
