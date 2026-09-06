import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveExecutionMode, shouldTranslatePaths } from '../configuration';
import { buildContainerCommand, buildDockerExecArgv, DockerConfigurationError } from '../dockerLauncher';
import { buildDebuggerSpawn, buildSignalPrefix } from '../wslLauncher';

const DOCKER = { containerName: 'ascend-suites' };
const WSL = { distro: 'Ubuntu-22.04' };
const MSDEBUG = '/usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi';

test('docker exec keeps stdin open and never allocates a TTY', () => {
	const argv = buildDockerExecArgv(DOCKER, ['/bin/bash', '-lc', 'true']);
	assert.deepEqual(argv, ['docker', 'exec', '-i', 'ascend-suites', '/bin/bash', '-lc', 'true']);
	// A TTY would echo commands back and corrupt the MI stream.
	assert.ok(!argv.includes('-t'));
});

test('docker exec carries user, workdir and extra arguments', () => {
	const argv = buildDockerExecArgv(
		{ ...DOCKER, user: 'root', workdir: '/wsl/out', dockerArgs: ['-e', 'FOO=1'] },
		['gdb']);
	assert.deepEqual(argv, [
		'docker', 'exec', '-i', '-u', 'root', '-w', '/wsl/out', '-e', 'FOO=1',
		'ascend-suites', 'gdb',
	]);
});

test('a missing container name is reported, not silently guessed', () => {
	assert.throws(() => buildDockerExecArgv({}, ['gdb']), DockerConfigurationError);
});

test('composes the wsl.exe hop in front of docker exec', () => {
	const argv = buildContainerCommand(DOCKER, WSL, ['/bin/bash', '-lc', 'true']);
	assert.deepEqual(argv, [
		'wsl.exe', '-d', 'Ubuntu-22.04', '-e',
		'docker', 'exec', '-i', 'ascend-suites',
		'/bin/bash', '-lc', 'true',
	]);
});

test('drops the wsl hop for Docker Desktop on Windows', () => {
	const argv = buildContainerCommand({ ...DOCKER, viaWsl: false }, WSL, ['gdb']);
	assert.equal(argv[0], 'docker');
	assert.ok(!argv.includes('wsl.exe'));
});

test('builds the full nested spawn for msdebug-mi in the container', () => {
	const spec = buildDebuggerSpawn({
		mode: 'docker',
		wsl: WSL,
		docker: DOCKER,
		gdbPath: MSDEBUG,
		miMode: 'mi2',
		cwd: '/wsl/out-debug',
		setupScript: '/usr/local/Ascend/ascend-toolkit/set_env.sh',
	});

	assert.equal(spec.command, 'wsl.exe');
	assert.deepEqual(spec.args.slice(0, 8), [
		'-d', 'Ubuntu-22.04', '-e',
		'docker', 'exec', '-i', 'ascend-suites', '/bin/bash',
	]);
	assert.equal(spec.args[8], '-lc');

	const script = spec.args[9];
	assert.match(script, /^cd '\/wsl\/out-debug'/);
	assert.match(script, /\. '\/usr\/local\/Ascend\/ascend-toolkit\/set_env\.sh' >\/dev\/null/);
	// exec keeps the shell's PID, which is what Pause signals later.
	assert.match(script, /echo __ASCEND_GDB_PID__:\$\$ >&2; exec '.*msdebug-mi' '--interpreter=mi2' '-q'$/);
	// The host spawn must not inherit a guest path as its cwd.
	assert.equal(spec.cwd, undefined);
});

test('signal prefix reaches into the container for Pause', () => {
	const prefix = buildSignalPrefix({ mode: 'docker', wsl: WSL, docker: DOCKER });
	assert.deepEqual(prefix, [
		'wsl.exe', '-d', 'Ubuntu-22.04', '-e', 'docker', 'exec', '-i', 'ascend-suites',
	]);
	assert.deepEqual(buildSignalPrefix({ mode: 'wsl', wsl: WSL }), ['wsl.exe', '-d', 'Ubuntu-22.04', '-e']);
	assert.equal(buildSignalPrefix({ mode: 'native' }), undefined);
});

test('execution.mode wins over the legacy wsl.enabled switch', () => {
	assert.equal(resolveExecutionMode({ execution: { mode: 'docker' }, wsl: { enabled: false } }), 'docker');
	assert.equal(resolveExecutionMode({ wsl: { enabled: false } }), 'native');
	assert.equal(resolveExecutionMode({}), 'wsl');
});

test('docker mode translates paths; plain native mode does not', () => {
	assert.equal(shouldTranslatePaths({ execution: { mode: 'docker' } }), true);
	assert.equal(shouldTranslatePaths({ execution: { mode: 'native' } }), false);
	// A native debugger against a remote Linux target still needs translation.
	assert.equal(
		shouldTranslatePaths({ execution: { mode: 'native' }, miDebuggerServerAddress: 'localhost:1234' }),
		true);
	assert.equal(shouldTranslatePaths({ execution: { mode: 'docker' }, pathTranslation: 'off' }), false);
});
