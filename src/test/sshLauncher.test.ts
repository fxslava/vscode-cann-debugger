import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveExecutionMode, shouldTranslatePaths } from '../configuration';
import {
	appendWslEnv,
	buildSshCommand,
	DEFAULT_PASSWORD_ENV_VAR,
	resolveSshPassword,
	SshConfigurationError,
} from '../sshLauncher';
import { buildDebuggerSpawn, buildSignalEnv, buildSignalPrefix } from '../wslLauncher';

const WSL = { distro: 'Ubuntu-22.04' };
const SSH = { host: '192.168.1.100', user: 'HwHiAiUser', viaWsl: false };
const MSDEBUG = '/usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi';
const WITH_PASSWORD = { [DEFAULT_PASSWORD_ENV_VAR]: 'hunter2' };

test('key authentication needs no sshpass and refuses to prompt', () => {
	const { argv, env } = buildSshCommand({ ...SSH, identityFile: '/home/me/.ssh/id_ed25519' }, WSL, '', {});

	assert.equal(argv[0], 'ssh');
	assert.ok(!argv.includes('sshpass'));
	// A passphrase prompt nobody can answer would look like a startup timeout.
	assert.ok(hasOption(argv, 'BatchMode=yes'));
	assert.deepEqual(argv.slice(-3), ['-i', '/home/me/.ssh/id_ed25519', 'HwHiAiUser@192.168.1.100']);
	assert.deepEqual(env, {});
});

test('the password travels in SSHPASS, never in argv', () => {
	const { argv, env } = buildSshCommand(SSH, WSL, '', WITH_PASSWORD);

	assert.deepEqual(argv.slice(0, 3), ['sshpass', '-e', 'ssh']);
	assert.equal(env.SSHPASS, 'hunter2');
	// argv is world-readable through /proc; the environment is not.
	assert.ok(!argv.some((a) => a.includes('hunter2')));
	// BatchMode would disable password authentication outright.
	assert.ok(!hasOption(argv, 'BatchMode=yes'));
});

test('a tty is never allocated: it would corrupt the MI stream', () => {
	const { argv } = buildSshCommand(SSH, WSL, '', {});
	assert.ok(argv.includes('-T'));
	assert.ok(!argv.includes('-t'));
	assert.ok(!argv.includes('-tt'));
});

test('port, extra arguments and host key policy reach the command line', () => {
	const { argv } = buildSshCommand(
		{ ...SSH, port: 2222, strictHostKeyChecking: 'yes', sshArgs: ['-o', 'Compression=yes'] },
		WSL, '', {});

	assert.ok(hasOption(argv, 'StrictHostKeyChecking=yes'));
	assert.ok(hasOption(argv, 'Compression=yes'));
	assert.deepEqual(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2), ['-p', '2222']);
	// The destination is always last, so a trailing remote command follows it.
	assert.equal(argv[argv.length - 1], 'HwHiAiUser@192.168.1.100');
});

test('routing through WSL carries SSHPASS across the boundary', () => {
	const { argv, env } = buildSshCommand({ ...SSH, viaWsl: true }, WSL, '', WITH_PASSWORD);

	assert.deepEqual(argv.slice(0, 6), [
		'wsl.exe', '-d', 'Ubuntu-22.04', '-e', 'sshpass', '-e',
	]);
	// Without WSLENV the variable stops at wsl.exe and sshpass finds nothing.
	assert.equal(env.WSLENV, 'SSHPASS/u');
});

test('WSLENV entries are appended, not replaced', () => {
	assert.equal(appendWslEnv('FOO/p', 'SSHPASS/u'), 'FOO/p:SSHPASS/u');
	assert.equal(appendWslEnv(undefined, 'SSHPASS/u'), 'SSHPASS/u');
	// Already present: adding it twice would confuse WSL's parser.
	assert.equal(appendWslEnv('SSHPASS/u:FOO/p', 'SSHPASS/u'), 'SSHPASS/u:FOO/p');
});

test('a missing host is reported, not silently guessed', () => {
	assert.throws(() => buildSshCommand({ user: 'root' }, WSL, '', {}), SshConfigurationError);
});

test('an explicit password still works for hand-written configurations', () => {
	assert.equal(resolveSshPassword({ password: 'inline' }, {}), 'inline');
	// The environment wins: it is what the extension host just filled in.
	assert.equal(resolveSshPassword({ password: 'inline' }, WITH_PASSWORD), 'hunter2');
	assert.equal(resolveSshPassword({ passwordEnvVar: 'OTHER' }, { OTHER: 'x' }), 'x');
	assert.equal(resolveSshPassword({}, {}), undefined);
});

test('the whole remote shell invocation arrives as one argv element', () => {
	const common = {
		wsl: WSL,
		gdbPath: MSDEBUG,
		miMode: 'mi2',
		cwd: '/home/HwHiAiUser/ascend-debug',
		setupScript: '/usr/local/Ascend/ascend-toolkit/set_env.sh',
		hostEnv: WITH_PASSWORD,
	};
	const spec = buildDebuggerSpawn({
		...common,
		mode: 'ssh',
		ssh: { ...SSH, viaWsl: true },
	});

	assert.equal(spec.command, 'wsl.exe');
	assert.deepEqual(spec.args.slice(0, 5), ['-d', 'Ubuntu-22.04', '-e', 'sshpass', '-e']);

	// ssh joins its trailing arguments with spaces before handing them to the
	// remote login shell, so the script must be quoted into a single element.
	const remote = spec.args[spec.args.length - 1];
	assert.equal(spec.args[spec.args.length - 2], 'HwHiAiUser@192.168.1.100');
	assert.ok(remote.startsWith(`/bin/bash -lc '`));
	assert.ok(remote.endsWith(`'`));

	// The invariant that matters: one round trip through the remote shell's
	// quoting yields exactly the script docker mode passes as its own argv.
	const viaDocker = buildDebuggerSpawn({
		...common,
		mode: 'docker',
		docker: { containerName: 'ascend-suites' },
	});
	const dockerScript = viaDocker.args[viaDocker.args.length - 1];
	assert.equal(shUnquote(remote.slice(`/bin/bash -lc `.length)), dockerScript);
	assert.match(dockerScript, /echo __ASCEND_GDB_PID__:\$\$ >&2; exec '.*msdebug-mi'/);

	assert.equal(spec.env?.SSHPASS, 'hunter2');
	// A guest path is not a valid spawn cwd on this machine.
	assert.equal(spec.cwd, undefined);
});

test('Pause reaches across the network, with the credentials it needs', () => {
	const options = { mode: 'ssh' as const, wsl: WSL, ssh: SSH, hostEnv: WITH_PASSWORD };
	const prefix = buildSignalPrefix(options);

	// MiConnection appends ["kill","-INT",pid]; ssh joins them into a command
	// the remote shell runs verbatim, so nothing here needs quoting.
	assert.ok(prefix);
	assert.equal(prefix[prefix.length - 1], 'HwHiAiUser@192.168.1.100');
	assert.equal(buildSignalEnv(options)?.SSHPASS, 'hunter2');

	// No host means no way to signal, which the caller reports as such.
	assert.equal(buildSignalPrefix({ mode: 'ssh', wsl: WSL, ssh: {} }), undefined);
	assert.equal(buildSignalEnv({ mode: 'docker', wsl: WSL }), undefined);
});

test('ssh is a remote mode: paths are translated and wsl.enabled is ignored', () => {
	assert.equal(resolveExecutionMode({ execution: { mode: 'ssh' }, wsl: { enabled: false } }), 'ssh');
	assert.equal(shouldTranslatePaths({ execution: { mode: 'ssh' } }), true);
	assert.equal(shouldTranslatePaths({ execution: { mode: 'ssh' }, pathTranslation: 'off' }), false);
});

/** True when `-o NAME=value` appears as an adjacent pair. */
function hasOption(argv: string[], option: string): boolean {
	return argv.some((a, i) => a === '-o' && argv[i + 1] === option);
}

/** What a POSIX shell does to a single-quoted word; the inverse of shQuote. */
function shUnquote(word: string): string {
	assert.ok(word.startsWith(`'`) && word.endsWith(`'`), `not single-quoted: ${word}`);
	return word.slice(1, -1).split(`'\\''`).join(`'`);
}
