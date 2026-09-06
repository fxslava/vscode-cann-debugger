/*---------------------------------------------------------------------------
 * Extension host side: configuration defaults, sanity checks that are far
 * cheaper to do here than inside the adapter, and two convenience commands.
 *
 * The adapter itself runs as a separate process (see debugAdapter.ts); this
 * file never touches GDB.
 *-------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { AscendLaunchArguments, NpuMemoryRegion } from './configuration';
import { DEFAULT_PASSWORD_ENV_VAR } from './sshLauncher';
import { readPassword } from './targetManager/targetConfig';
import { TargetViewProvider } from './targetManager/targetViewProvider';

const DEBUG_TYPE = 'ascend-gdb';

export function activate(context: vscode.ExtensionContext): void {
	const targetView = new TargetViewProvider(context);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(
			DEBUG_TYPE,
			new AscendConfigurationProvider(),
		),
		vscode.debug.registerDebugAdapterDescriptorFactory(
			DEBUG_TYPE,
			new AscendAdapterDescriptorFactory(context),
		),
		vscode.window.registerWebviewViewProvider(TargetViewProvider.viewType, targetView, {
			// Keep the form (and any half-typed password) alive while the user
			// switches to another view; re-creating it would clear the field.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('ascend-gdb.viewNpuMemory', viewNpuMemory),
		vscode.commands.registerCommand('ascend-gdb.sendMiCommand', sendMiCommand),
		vscode.commands.registerCommand('ascend-gdb.deployAndDebug', () =>
			targetView.deployAndDebugFromCommand()),
		vscode.commands.registerCommand('ascend-gdb.openTargetManager', () =>
			vscode.commands.executeCommand(`${TargetViewProvider.viewType}.focus`)),
	);
}

/**
 * Hands the adapter its SSH password through the environment.
 *
 * The alternative - putting it in the debug configuration - would leak it into
 * `session.configuration`, which any other extension can read, and into
 * launch.json the moment the user saved the configuration. An environment
 * variable on a process VS Code spawns for this session alone is visible to
 * that process and its children, which is exactly the set that needs it:
 * sshLauncher copies it into SSHPASS for the ssh child and nowhere else.
 */
class AscendAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	constructor(private readonly context: vscode.ExtensionContext) {}

	public async createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		executable: vscode.DebugAdapterExecutable | undefined,
	): Promise<vscode.DebugAdapterDescriptor> {
		const command = executable?.command ?? process.execPath;
		const args = executable?.args ?? [this.context.asAbsolutePath('out/debugAdapter.js')];
		const options = executable?.options ?? {};

		const execution = (session.configuration as unknown as AscendLaunchArguments).execution;
		const ssh = execution?.ssh;
		if (execution?.mode !== 'ssh' || !ssh || ssh.identityFile) {
			return new vscode.DebugAdapterExecutable(command, args, options);
		}

		const password = await readPassword(this.context.secrets, {
			host: ssh.host,
			port: ssh.port,
			user: ssh.user,
		});
		if (!password) {
			// Not fatal: the target may rely on an agent or a default key. The
			// adapter reports the authentication failure with a usable hint.
			return new vscode.DebugAdapterExecutable(command, args, options);
		}

		return new vscode.DebugAdapterExecutable(command, args, {
			...options,
			env: { ...(options.env ?? {}), [DEFAULT_PASSWORD_ENV_VAR]: password },
		});
	}
}

export function deactivate(): void {
	/* nothing to clean up: the adapter process exits with the session */
}

class AscendConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Fill in a usable configuration when the user hits F5 with no launch.json,
	 * and apply the defaults that make the WSL round trip work.
	 */
	public resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !['c', 'cpp'].includes(editor.document.languageId)) {
				return undefined;
			}
			config.type = DEBUG_TYPE;
			config.name = 'Ascend C: launch';
			config.request = 'launch';
			config.program = '${workspaceFolder}/build/test_kernel';
			config.stopAtEntry = true;
		}

		config.cwd ??= folder ? folder.uri.fsPath : '${workspaceFolder}';
		config.gdbPath ??= 'ascend-gdb';
		config.miMode ??= 'mi2';
		config.wsl = { enabled: true, ...(config.wsl ?? {}) };
		config.memoryReferences ??= 'auto';

		// Without an explicit mapping the adapter still falls back to the
		// /mnt/<drive> rule, but seeding the workspace root makes the common
		// case exact and keeps breakpoints binding on case-differing paths.
		if (folder && !config.sourceFileMap) {
			const host = folder.uri.fsPath;
			const drive = /^([a-zA-Z]):[\\/]/.exec(host);
			if (drive) {
				const guest = `/mnt/${drive[1].toLowerCase()}/${host.slice(3).replace(/\\/g, '/')}`;
				config.sourceFileMap = { [guest]: host };
			}
		}

		return config;
	}

	/** Runs after ${...} substitution: this is where we can validate real paths. */
	public async resolveDebugConfigurationWithSubstitutedVariables(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
	): Promise<vscode.DebugConfiguration | undefined> {
		const args = config as unknown as AscendLaunchArguments;

		if (config.request === 'launch' && !args.program) {
			await vscode.window.showErrorMessage(
				'Ascend debug: "program" is required. Point it at the built kernel test binary.');
			return undefined;
		}

		if (args.execution?.mode === 'ssh' && !args.execution.ssh?.host) {
			const pick = await vscode.window.showErrorMessage(
				'Ascend debug: execution.mode is "ssh" but no "execution.ssh.host" was set.',
				'Open Target Manager');
			if (pick === 'Open Target Manager') {
				await vscode.commands.executeCommand('ascend-gdb.openTargetManager');
			}
			return undefined;
		}

		if (args.wsl?.enabled !== false && args.wsl?.distro) {
			const available = await listWslDistros();
			if (available.length && !available.includes(args.wsl.distro)) {
				const pick = await vscode.window.showWarningMessage(
					`WSL distribution "${args.wsl.distro}" was not found. Installed: ${available.join(', ')}.`,
					'Use ' + available[0], 'Debug anyway', 'Cancel');
				if (pick === 'Cancel' || pick === undefined) {
					return undefined;
				}
				if (pick?.startsWith('Use ')) {
					args.wsl.distro = available[0];
				}
			}
		}

		return config;
	}
}

/**
 * Resolve a configured NPU region to a concrete address.
 *
 * VS Code opens the Hex Editor from a variable's context menu ("View Binary
 * Data"), which needs a memoryReference - the adapter publishes one for every
 * configured region under the "NPU Memory" scope in the Variables view. This
 * command is the shortcut for finding the address itself.
 */
async function viewNpuMemory(): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== DEBUG_TYPE) {
		await vscode.window.showWarningMessage('Start an Ascend debug session first.');
		return;
	}

	const regions = (session.configuration.npuMemoryRegions ?? []) as NpuMemoryRegion[];
	if (!regions.length) {
		await vscode.window.showInformationMessage(
			'No "npuMemoryRegions" are configured in this launch configuration.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		regions.map((r) => ({
			label: r.name,
			description: r.address,
			detail: r.description,
			region: r,
		})),
		{ placeHolder: 'Select an NPU memory region' });
	if (!picked) {
		return;
	}

	try {
		const result = await session.customRequest('ascend/resolveRegion', { region: picked.region });
		const address: string | undefined = result?.address;
		if (!address) {
			await vscode.window.showErrorMessage(
				`Could not resolve "${picked.region.address}" to an address.`);
			return;
		}
		const action = await vscode.window.showInformationMessage(
			`${picked.region.name} is at ${address}. Open it from the "NPU Memory" scope in the Variables view (right-click a region and choose View Binary Data).`,
			'Copy address');
		if (action === 'Copy address') {
			await vscode.env.clipboard.writeText(address);
		}
	} catch (err) {
		await vscode.window.showErrorMessage(`Ascend debug: ${(err as Error).message}`);
	}
}

/** Escape hatch: talk to ascend-gdb directly when the UI does not cover a case. */
async function sendMiCommand(): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== DEBUG_TYPE) {
		await vscode.window.showWarningMessage('Start an Ascend debug session first.');
		return;
	}
	const text = await vscode.window.showInputBox({
		prompt: 'GDB command. Prefix with "-" to send raw MI (e.g. -data-read-memory-bytes 0x0 64).',
		placeHolder: 'info registers',
	});
	if (!text) {
		return;
	}
	try {
		const result = await session.customRequest('ascend/miCommand', { text });
		const channel = getOutputChannel();
		channel.appendLine(`(gdb) ${text}`);
		channel.appendLine(String(result?.output ?? ''));
		channel.show(true);
	} catch (err) {
		await vscode.window.showErrorMessage(`Ascend debug: ${(err as Error).message}`);
	}
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
	outputChannel ??= vscode.window.createOutputChannel('Ascend GDB');
	return outputChannel;
}

function listWslDistros(): Promise<string[]> {
	return new Promise((resolve) => {
		execFile('wsl.exe', ['-l', '-q'], { windowsHide: true }, (err, stdout) => {
			if (err) {
				return resolve([]);
			}
			// wsl.exe -l writes UTF-16LE; Node hands it to us as latin1-ish text
			// with interleaved NULs, so strip them before splitting.
			const cleaned = stdout.replace(/\0/g, '');
			resolve(cleaned.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
		});
	});
}
