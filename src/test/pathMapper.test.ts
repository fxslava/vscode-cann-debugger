import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PathMapper } from '../pathMapper';

const workspace = new PathMapper({
	sourceFileMap: { '/mnt/d/Projects/vllm-ascend': 'D:\\Projects\\vllm-ascend' },
	distro: 'Ubuntu-22.04',
});

test('maps a Windows workspace path into the guest', () => {
	assert.equal(
		workspace.toDebugger('D:\\Projects\\vllm-ascend\\csrc\\tests\\add_custom.cpp'),
		'/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp');
});

test('maps a guest path back to Windows', () => {
	assert.equal(
		workspace.toHost('/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp'),
		'D:\\Projects\\vllm-ascend\\csrc\\tests\\add_custom.cpp');
});

test('falls back to the generic /mnt/<drive> rule outside the mapping', () => {
	const plain = new PathMapper({});
	assert.equal(plain.toDebugger('C:\\temp\\kernel.cpp'), '/mnt/c/temp/kernel.cpp');
	assert.equal(plain.toHost('/mnt/c/temp/kernel.cpp'), 'C:\\temp\\kernel.cpp');
	assert.equal(plain.toHost('/mnt/e'), 'E:\\');
});

test('matches host prefixes case-insensitively, as Windows does', () => {
	assert.equal(
		workspace.toDebugger('d:\\projects\\VLLM-ascend\\csrc\\tests\\x.cpp'),
		'/mnt/d/Projects/vllm-ascend/csrc/tests/x.cpp');
});

test('only matches whole path segments', () => {
	// D:\Projects\vllm-ascend-old must not be rewritten by the vllm-ascend rule.
	assert.equal(
		workspace.toDebugger('D:\\Projects\\vllm-ascend-old\\x.cpp'),
		'/mnt/d/Projects/vllm-ascend-old/x.cpp');
});

test('passes guest paths through unchanged', () => {
	assert.equal(workspace.toDebugger('/home/dev/build/test_kernel'), '/home/dev/build/test_kernel');
});

test('exposes guest-only paths through the WSL UNC share', () => {
	assert.equal(
		workspace.toHost('/home/dev/kernel.cpp'),
		'\\\\wsl$\\Ubuntu-22.04\\home\\dev\\kernel.cpp');
});

test('accepts UNC input from the Windows side', () => {
	assert.equal(
		workspace.toDebugger('\\\\wsl$\\Ubuntu-22.04\\home\\dev\\kernel.cpp'),
		'/home/dev/kernel.cpp');
	assert.equal(
		workspace.toDebugger('\\\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\kernel.cpp'),
		'/home/dev/kernel.cpp');
});

test('round-trips the workspace root itself', () => {
	assert.equal(workspace.toDebugger('D:\\Projects\\vllm-ascend'), '/mnt/d/Projects/vllm-ascend');
	assert.equal(workspace.toHost('/mnt/d/Projects/vllm-ascend'), 'D:\\Projects\\vllm-ascend');
});

test('sameFile compares in guest space and tolerates relative reports', () => {
	assert.ok(workspace.sameFile(
		'D:\\Projects\\vllm-ascend\\csrc\\tests\\add_custom.cpp',
		'/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp'));
	assert.ok(workspace.sameFile(
		'/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp',
		'tests/add_custom.cpp'));
	assert.ok(!workspace.sameFile('/a/b/x.cpp', '/a/b/y.cpp'));
});

test('passthrough mode leaves everything alone', () => {
	const native = new PathMapper({ passthrough: true });
	assert.equal(native.toDebugger('D:\\x\\y.cpp'), 'D:\\x\\y.cpp');
	assert.equal(native.toHost('/home/dev/y.cpp'), '/home/dev/y.cpp');
});

/* --------------------------------------------------------------------------
 * Container mappings: the bind mount is an arbitrary root, not /mnt/<drive>.
 * ----------------------------------------------------------------------- */

const container = new PathMapper({
	sourceFileMap: { '/tests': 'D:\\Projects\\vllm-ascend\\csrc\\tests' },
});

test('maps the Windows tests tree onto the container bind mount', () => {
	assert.equal(
		container.toDebugger('D:\\Projects\\vllm-ascend\\csrc\\tests\\kernels\\test_rmsnorm_310p.cpp'),
		'/tests/kernels/test_rmsnorm_310p.cpp');
	assert.equal(
		container.toHost('/tests/kernels/test_rmsnorm_310p.cpp'),
		'D:\\Projects\\vllm-ascend\\csrc\\tests\\kernels\\test_rmsnorm_310p.cpp');
});

test('maps the container mount root itself', () => {
	assert.equal(container.toDebugger('D:\\Projects\\vllm-ascend\\csrc\\tests'), '/tests');
	assert.equal(container.toHost('/tests'), 'D:\\Projects\\vllm-ascend\\csrc\\tests');
});

test('leaves unmapped container paths alone when there is no WSL share', () => {
	// /wsl/out-debug lives in the container, not in the distro filesystem, so
	// inventing a \\\\wsl$ path for it would point at nothing.
	assert.equal(container.toHost('/wsl/out-debug/test_rmsnorm_310p'), '/wsl/out-debug/test_rmsnorm_310p');
	assert.equal(container.toHost('/usr/include/stdio.h'), '/usr/include/stdio.h');
});

test('does not confuse /tests with a sibling like /tests-old', () => {
	assert.equal(container.toHost('/tests-old/x.cpp'), '/tests-old/x.cpp');
});
