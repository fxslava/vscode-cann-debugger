/*---------------------------------------------------------------------------
 * Unit tests for register grouping and the `info address` reader.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	annotateRegisterValue,
	categorizeRegister,
	formatRegisterValue,
	groupRegisters,
	parseRegisterBinding,
	REGISTER_GROUPS,
	renderRegisterValue,
} from '../registers';

/* -------------------------------------------------------------------------
 * Grouping
 * ---------------------------------------------------------------------- */

test('files the vector register file under Vector', () => {
	assert.equal(categorizeRegister('v0'), 'vector');
	assert.equal(categorizeRegister('v31'), 'vector');
	// The same file under its other spellings.
	assert.equal(categorizeRegister('q7'), 'vector');
	assert.equal(categorizeRegister('z15'), 'vector');
	assert.equal(categorizeRegister('V0'), 'vector');
});

test('files general-purpose and scalar registers under Scalar', () => {
	assert.equal(categorizeRegister('x0'), 'scalar');
	assert.equal(categorizeRegister('w12'), 'scalar');
	assert.equal(categorizeRegister('s3'), 'scalar');
	assert.equal(categorizeRegister('r7'), 'scalar');
	// Named, but general-purpose in everything except spelling.
	assert.equal(categorizeRegister('sp'), 'scalar');
	assert.equal(categorizeRegister('fp'), 'scalar');
	assert.equal(categorizeRegister('lr'), 'scalar');
});

test('anything unrecognised is shown under System rather than guessed at', () => {
	assert.equal(categorizeRegister('pc'), 'system');
	assert.equal(categorizeRegister('cpsr'), 'system');
	assert.equal(categorizeRegister('fpsr'), 'system');
	// An Ascend-specific register this build has never heard of still appears.
	assert.equal(categorizeRegister('AICORE_STATUS'), 'system');
	// A bare prefix is not a numbered register.
	assert.equal(categorizeRegister('v'), 'system');
	assert.equal(categorizeRegister('vector_ctrl'), 'system');
	assert.equal(categorizeRegister(''), 'system');
});

test('keeps the debugger register order within each group', () => {
	const groups = groupRegisters(['x0', 'v0', 'pc', 'x1', 'v1', 'cpsr']);
	assert.deepEqual(groups.get('vector'), ['v0', 'v1']);
	assert.deepEqual(groups.get('scalar'), ['x0', 'x1']);
	assert.deepEqual(groups.get('system'), ['pc', 'cpsr']);
});

test('every group exists even when empty, so callers need no guard', () => {
	const groups = groupRegisters([]);
	for (const info of REGISTER_GROUPS) {
		assert.deepEqual(groups.get(info.id), []);
	}
});

test('unnamed register slots are skipped', () => {
	const groups = groupRegisters(['x0', '', 'v0']);
	assert.deepEqual(groups.get('scalar'), ['x0']);
	assert.deepEqual(groups.get('vector'), ['v0']);
});

/* -------------------------------------------------------------------------
 * Reading `info address`
 * ---------------------------------------------------------------------- */

test('reads a variable that lives in a register', () => {
	assert.deepEqual(
		parseRegisterBinding('Symbol "acc" is a variable in register $v0.\n'),
		{ symbol: 'acc', register: 'v0' });
	// Some builds drop the "a variable" and the $.
	assert.deepEqual(
		parseRegisterBinding('Symbol "acc" is in register v0.'),
		{ symbol: 'acc', register: 'v0' });
});

test('a stack local is not a register binding, however it is phrased', () => {
	// This names x29 but the variable is in memory. Reading it as a binding
	// would label the frame pointer with every local in the frame.
	assert.equal(
		parseRegisterBinding('Symbol "n" is a variable at frame base reg $x29 offset 20.'),
		undefined);
	assert.equal(
		parseRegisterBinding('Symbol "g" is static storage at address 0x601040.'),
		undefined);
	assert.equal(
		parseRegisterBinding('Symbol "k" is a complex DWARF expression: 0: DW_OP_reg0.'),
		undefined);
});

test('anything unparseable yields no binding rather than a wrong one', () => {
	assert.equal(parseRegisterBinding(''), undefined);
	assert.equal(parseRegisterBinding('No symbol "zz" in current context.'), undefined);
	assert.equal(parseRegisterBinding('undefined command: "info address"'), undefined);
});

/* -------------------------------------------------------------------------
 * Annotation
 * ---------------------------------------------------------------------- */

test('annotates a register with the locals it holds', () => {
	assert.equal(annotateRegisterValue('0x2000', ['myTensor']),
		'0x2000 [mapped to: myTensor]');
	// One register can hold more than one thing across a frame.
	assert.equal(annotateRegisterValue('0x2000', ['a', 'b']),
		'0x2000 [mapped to: a, b]');
});

test('a register holding nothing reads exactly as before', () => {
	assert.equal(annotateRegisterValue('0x0', []), '0x0');
});

/* -------------------------------------------------------------------------
 * Hex and decimal
 * ---------------------------------------------------------------------- */

test('shows a scalar register as both hex and decimal', () => {
	// Hex alone is right for an address and useless for a loop counter.
	assert.equal(formatRegisterValue('0x2a'), '0x0000002A (42)');
	assert.equal(formatRegisterValue('0x0'), '0x00000000 (0)');
	assert.equal(formatRegisterValue('0x2000'), '0x00002000 (8192)');
	// Padded to a fixed width so a column of registers lines up.
	assert.equal(formatRegisterValue('0xff'), '0x000000FF (255)');
});

test('widens past 32 bits rather than truncating', () => {
	assert.equal(formatRegisterValue('0x7ffd12345678'), '0x00007FFD12345678 (140724908873336)');
	// The full 64-bit pattern, unsigned: the literal value of the bits. Signed
	// would need a register width that MI never reports.
	assert.equal(formatRegisterValue('0xffffffffffffffff'),
		'0xFFFFFFFFFFFFFFFF (18446744073709551615)');
});

test('leaves anything that is not a plain scalar alone', () => {
	// A vector register's full contents: a 128-bit decimal helps nobody.
	const wide = '0x000102030405060708090a0b0c0d0e0f';
	assert.equal(formatRegisterValue(wide), wide.toUpperCase().replace('0X', '0x'));
	// GDB's structured rendering of a vector file, and a float, pass through.
	assert.equal(formatRegisterValue('{s = {1, 2}, d = {3}}'), '{s = {1, 2}, d = {3}}');
	assert.equal(formatRegisterValue('1.5'), '1.5');
	assert.equal(formatRegisterValue(''), '');
});

/* -------------------------------------------------------------------------
 * Change marking
 * ---------------------------------------------------------------------- */

test('marks what a register last held', () => {
	assert.equal(renderRegisterValue('0x2a', '0x28'), '0x0000002A (42) [was 0x28]');
});

test('says nothing about a register that has never moved', () => {
	// The first stop has nothing to compare against.
	assert.equal(renderRegisterValue('0x2a', undefined), '0x0000002A (42)');
	// A marker equal to the current value would say nothing worth reading.
	assert.equal(renderRegisterValue('0x2a', '0x2a'), '0x0000002A (42)');
});

test('the marker holds still while the register does', () => {
	// The same last-different value renders byte-identically however many
	// stops go by, which is what stops VS Code highlighting it again.
	assert.equal(renderRegisterValue('0x2a', '0x28'), renderRegisterValue('0x2a', '0x28'));
});

test('a moved register that also holds a local says both', () => {
	// The marker comes first: when stepping, that is what is being looked for.
	assert.equal(
		renderRegisterValue('0x2a', '0x28', ['count']),
		'0x0000002A (42) [was 0x28] [mapped to: count]');
});
