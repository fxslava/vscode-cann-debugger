/*---------------------------------------------------------------------------
 * Pushing the built ELF to the Ascend target, and probing that the target can
 * actually host a debug session.
 *
 * This runs in the extension host, not the adapter, so it can use ssh2 and
 * talk to the user. The adapter keeps using the ssh CLI (see sshLauncher) -
 * the MI stream wants a plain pipe, and the CLI is the well-trodden path for
 * that, while a file copy wants progress reporting and structured errors.
 *
 * Host keys are trusted on first use and pinned afterwards. ssh2 accepts any
 * key by default, which would make the password worth less than the network it
 * crosses; the prompt below is the whole point of the `hostVerifier`.
 *-------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import * as vscode from 'vscode';

const KNOWN_HOSTS_KEY = 'ascend-gdb.knownHostKeys';

export interface SshCredentials {
	host: string;
	port: number;
	username: string;
	password?: string;
	/** Path to a private key on this machine. Wins over the password. */
	identityFile?: string;
	passphrase?: string;
}

export class DeployError extends Error {}

/* ------------------------------ connecting ------------------------------ */

/** OpenSSH's own fingerprint format, so it can be compared with ssh-keyscan. */
function fingerprint(key: Buffer): string {
	return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/**
 * Trust-on-first-use check. Returns a verifier that pins the key the first
 * time the user confirms it and refuses a changed key afterwards.
 */
function makeHostVerifier(
	context: vscode.ExtensionContext,
	creds: SshCredentials,
): (key: Buffer, callback: (valid: boolean) => void) => void {
	const id = `${creds.host}:${creds.port}`;

	return (key, callback) => {
		const known = context.globalState.get<Record<string, string>>(KNOWN_HOSTS_KEY) ?? {};
		const seen = known[id];
		const actual = fingerprint(key);

		if (seen === actual) {
			return callback(true);
		}

		const prompt = seen
			? `The host key for ${id} has CHANGED.\n\nPinned:  ${seen}\nOffered: ${actual}\n\n` +
			  'This is what a machine-in-the-middle looks like. Only continue if the ' +
			  'target was legitimately re-imaged or re-keyed.'
			: `First connection to ${id}.\n\nHost key fingerprint: ${actual}\n\n` +
			  'Confirm this matches the target before continuing.';

		void vscode.window
			.showWarningMessage(prompt, { modal: true }, 'Trust and continue')
			.then(async (choice) => {
				if (choice !== 'Trust and continue') {
					return callback(false);
				}
				await context.globalState.update(KNOWN_HOSTS_KEY, { ...known, [id]: actual });
				callback(true);
			}, () => callback(false));
	};
}

function buildConnectConfig(
	context: vscode.ExtensionContext,
	creds: SshCredentials,
): ConnectConfig {
	const config: ConnectConfig = {
		host: creds.host,
		port: creds.port || 22,
		username: creds.username,
		readyTimeout: 20000,
		keepaliveInterval: 15000,
		hostVerifier: makeHostVerifier(context, creds),
	};

	if (creds.identityFile) {
		try {
			config.privateKey = fs.readFileSync(creds.identityFile);
		} catch (err) {
			throw new DeployError(
				`Could not read the private key "${creds.identityFile}": ${(err as Error).message}`);
		}
		if (creds.passphrase) {
			config.passphrase = creds.passphrase;
		}
	} else if (creds.password) {
		config.password = creds.password;
	} else {
		throw new DeployError(
			'No SSH credentials. Enter a password in the Ascend NPU Target Manager, ' +
			'or point "Private key" at a key file.');
	}

	return config;
}

/** Open a connection, run `body`, and always close the connection afterwards. */
export async function withConnection<T>(
	context: vscode.ExtensionContext,
	creds: SshCredentials,
	body: (client: Client) => Promise<T>,
): Promise<T> {
	const config = buildConnectConfig(context, creds);
	const client = new Client();

	await new Promise<void>((resolve, reject) => {
		client.once('ready', resolve);
		client.once('error', (err: Error & { level?: string }) => {
			reject(new DeployError(describeConnectError(err, creds)));
		});
		client.connect(config);
	});

	try {
		return await body(client);
	} finally {
		client.end();
	}
}

function describeConnectError(err: Error & { level?: string }, creds: SshCredentials): string {
	const where = `${creds.username}@${creds.host}:${creds.port || 22}`;
	const code = (err as NodeJS.ErrnoException).code;

	if (err.level === 'client-authentication') {
		return `${where} rejected the credentials. Check the username and password, ` +
			'and that the account is allowed to log in over SSH.';
	}
	if (/verification failed|handshake/i.test(err.message) && /host/i.test(err.message)) {
		return `The host key for ${creds.host} was not accepted.`;
	}
	if (code === 'ECONNREFUSED') {
		return `${where} refused the connection. Is sshd running on that port?`;
	}
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
		return `${creds.host} is unreachable from this machine.`;
	}
	if (code === 'ENOTFOUND') {
		return `${creds.host} could not be resolved.`;
	}
	if (code === 'ETIMEDOUT' || /timed out/i.test(err.message)) {
		return `${where} did not answer within 20s. Check the address and any firewall.`;
	}
	return `${where}: ${err.message}`;
}

/* -------------------------------- SFTP ---------------------------------- */

function openSftp(client: Client): Promise<SFTPWrapper> {
	return new Promise((resolve, reject) => {
		client.sftp((err, sftp) => (err ? reject(new DeployError(err.message)) : resolve(sftp)));
	});
}

/** `mkdir -p`, one segment at a time: SFTP has no recursive mkdir. */
async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
	const segments = dir.split('/').filter(Boolean);
	let current = '';
	for (const segment of segments) {
		current += '/' + segment;
		const existing = current;
		await new Promise<void>((resolve, reject) => {
			sftp.mkdir(existing, (err) => {
				// 4 = SSH_FX_FAILURE, which is what most servers return for an
				// existing directory; 11 = SSH_FX_FILE_ALREADY_EXISTS.
				const code = (err as (Error & { code?: number }) | null)?.code;
				if (!err || code === 4 || code === 11) {
					return resolve();
				}
				reject(new DeployError(`Could not create ${existing} on the target: ${err.message}`));
			});
		});
	}
}

export interface DeployResult {
	remotePath: string;
	bytes: number;
	elapsedMs: number;
}

/**
 * Copy `localPath` into `remoteDir` and make it executable.
 * `onProgress` receives a 0..1 fraction.
 */
export async function deployBinary(
	client: Client,
	localPath: string,
	remoteDir: string,
	onProgress?: (fraction: number, transferred: number, total: number) => void,
): Promise<DeployResult> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(localPath);
	} catch {
		throw new DeployError(
			`The binary "${localPath}" does not exist on this machine. Build it before deploying.`);
	}
	if (!stat.isFile()) {
		throw new DeployError(`"${localPath}" is not a file.`);
	}

	const started = Date.now();
	const sftp = await openSftp(client);
	await ensureRemoteDir(sftp, remoteDir);

	const remotePath = `${remoteDir.replace(/\/+$/, '')}/${path.basename(localPath)}`;

	await new Promise<void>((resolve, reject) => {
		sftp.fastPut(
			localPath,
			remotePath,
			{
				// A running binary cannot be overwritten in place on Linux, so the
				// caller kills the old session first; concurrency 4 keeps a large
				// ELF from taking a visible pause over a slow lab link.
				concurrency: 4,
				chunkSize: 32 * 1024,
				step: (transferred: number, _chunk: number, total: number) => {
					onProgress?.(total ? transferred / total : 0, transferred, total);
				},
			},
			(err) => (err ? reject(new DeployError(`Upload failed: ${err.message}`)) : resolve()),
		);
	});

	await new Promise<void>((resolve, reject) => {
		sftp.chmod(remotePath, 0o755, (err) =>
			err ? reject(new DeployError(`Could not chmod ${remotePath}: ${err.message}`)) : resolve());
	});

	return { remotePath, bytes: stat.size, elapsedMs: Date.now() - started };
}

/* ------------------------------ probing --------------------------------- */

export interface RemoteExec {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run one command on the target and collect its output. */
export function execRemote(client: Client, command: string): Promise<RemoteExec> {
	return new Promise((resolve, reject) => {
		client.exec(command, (err, stream) => {
			if (err) {
				return reject(new DeployError(err.message));
			}
			let stdout = '';
			let stderr = '';
			stream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
			stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
			stream.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
		});
	});
}

export interface TargetProbe {
	uname: string;
	debuggerFound: boolean;
	npuSmi: string;
}

/**
 * What the user actually wants to know from "Test Connection": did we get in,
 * is this really an Ascend box, and is the debugger where the config says.
 */
export async function probeTarget(client: Client, gdbPath: string): Promise<TargetProbe> {
	const uname = await execRemote(client, 'uname -srm');
	// -x so a debugger that exists but is not executable by this account still
	// reports as missing, which is the failure the user would otherwise hit
	// only at launch time.
	const probe = await execRemote(client, `test -x ${shQuote(gdbPath)} && echo yes || echo no`);
	const smi = await execRemote(client, 'npu-smi info -l 2>/dev/null | head -n 5');

	return {
		uname: uname.stdout.trim() || uname.stderr.trim(),
		debuggerFound: probe.stdout.trim() === 'yes',
		npuSmi: smi.stdout.trim(),
	};
}

/** POSIX single-quote quoting; mirrors wslLauncher.shQuote. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
