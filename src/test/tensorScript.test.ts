/*---------------------------------------------------------------------------
 * Unit tests for the Tensor Inspector's custom parsers.
 *
 * media/tensorScript.js is loaded by the webview as a plain script, but it is
 * written as a UMD module so the risky half - compiling and running a user's
 * snippet, and deciding whether what came back is a grid - can be exercised
 * here in Node, where `new Function` behaves the same way.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

interface ScriptResult {
	error?: string;
	text?: string[][];
	values?: (number | null)[][];
}

interface TensorScriptModule {
	MAX_CELLS: number;
	TEMPLATE: string;
	runScript(code: string, buffer: Uint8Array, shape: number[]): ScriptResult;
	normalizeCells(returned: unknown): ScriptResult;
	statsFromCells(values: (number | null)[][]): {
		min: number; max: number; mean: number; finite: number;
	};
	formatNumber(value: number): string;
}

// Loaded by path rather than imported: it lives in media/, outside rootDir,
// and ships to the webview as-is.
const TensorScript: TensorScriptModule =
	require(join(__dirname, '..', '..', 'media', 'tensorScript.js'));

/** Four little-endian float32s: 1.5, -2.25, 0, 3.5. */
function floatBytes(): Uint8Array {
	const buffer = new ArrayBuffer(16);
	const view = new DataView(buffer);
	[1.5, -2.25, 0, 3.5].forEach((v, i) => view.setFloat32(i * 4, v, true));
	return new Uint8Array(buffer);
}

/* -------------------------------------------------------------------------
 * Running a script
 * ---------------------------------------------------------------------- */

test('runs a snippet over the raw window', () => {
	const result = TensorScript.runScript(
		'return [[buffer[0], buffer[1]], [buffer[2], buffer[3]]];',
		new Uint8Array([1, 2, 3, 4]),
		[2, 2]);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.text, [['1', '2'], ['3', '4']]);
});

test('the snippet receives the shape it was read with', () => {
	const result = TensorScript.runScript('return [shape];', new Uint8Array(0), [2, 3, 4]);
	assert.deepEqual(result.text, [['2', '3', '4']]);
});

test('the shipped template decodes row-major float32', () => {
	// The starting point a user edits must itself be correct.
	const result = TensorScript.runScript(TensorScript.TEMPLATE, floatBytes(), [2, 2]);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.text, [['1.5', '-2.25'], ['0', '3.5']]);
});

test('a custom layout can reorder the window - the point of the feature', () => {
	// Stand-in for a tiled layout: read the 2x2 transposed.
	const code = [
		'const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);',
		'const out = [];',
		'for (let c = 0; c < 2; c++) {',
		'  const row = [];',
		'  for (let r = 0; r < 2; r++) { row.push(view.getFloat32((r * 2 + c) * 4, true)); }',
		'  out.push(row);',
		'}',
		'return out;',
	].join('\n');
	const result = TensorScript.runScript(code, floatBytes(), [2, 2]);
	assert.deepEqual(result.text, [['1.5', '0'], ['-2.25', '3.5']]);
});

/* -------------------------------------------------------------------------
 * Failure is an ordinary outcome
 * ---------------------------------------------------------------------- */

test('a syntax error is reported, not thrown', () => {
	const result = TensorScript.runScript('return [[;', new Uint8Array(4), [1]);
	assert.match(result.error!, /did not compile/);
	// The engine's own complaint is kept: it is what says where the typo is.
	assert.match(result.error!, /SyntaxError/);
});

test('a script that throws is reported with its message', () => {
	const result = TensorScript.runScript(
		'throw new Error("bad stride");', new Uint8Array(4), [1]);
	assert.match(result.error!, /Script threw - bad stride/);
});

test('a runtime fault in the snippet is caught like any other throw', () => {
	const result = TensorScript.runScript('return nothingHere.value;', new Uint8Array(4), [1]);
	assert.match(result.error!, /Script threw - ReferenceError/);
});

test('a return value that is not a grid says what arrived instead', () => {
	assert.match(TensorScript.runScript('return 42;', new Uint8Array(0), [1]).error!,
		/must return an array of rows, but returned a number/);
	assert.match(TensorScript.runScript('return "text";', new Uint8Array(0), [1]).error!,
		/returned a string/);
	assert.match(TensorScript.runScript('return null;', new Uint8Array(0), [1]).error!,
		/returned null/);
	// Forgetting the return at all is the commonest mistake of the lot.
	assert.match(TensorScript.runScript('const x = 1;', new Uint8Array(0), [1]).error!,
		/returned nothing.*`return`/s);
});

test('a row that is not an array names the row', () => {
	const result = TensorScript.runScript('return [[1, 2], 3];', new Uint8Array(0), [2, 2]);
	assert.match(result.error!, /Row 1 is a number, not an array/);
});

test('a runaway grid is refused rather than rendered', () => {
	const code = `return Array.from({ length: ${TensorScript.MAX_CELLS} }, () => [1, 2]);`;
	const result = TensorScript.runScript(code, new Uint8Array(0), [1]);
	assert.match(result.error!, /more than 65,536 cells/);
});

/* -------------------------------------------------------------------------
 * Normalising cells
 * ---------------------------------------------------------------------- */

test('a flat array is taken as a single row', () => {
	const result = TensorScript.normalizeCells([1, 2, 3]);
	assert.deepEqual(result.text, [['1', '2', '3']]);
});

test('strings pass through and are not coloured', () => {
	const result = TensorScript.normalizeCells([['ok', 7, null, undefined]]);
	assert.deepEqual(result.text, [['ok', '7', '--', '--']]);
	// Only the number is a value the heat map can use.
	assert.deepEqual(result.values, [[null, 7, null, null]]);
});

test('non-finite numbers keep their text but leave the colour scale alone', () => {
	const result = TensorScript.normalizeCells([[NaN, Infinity, -Infinity]]);
	assert.deepEqual(result.text, [['NaN', 'inf', '-inf']]);
	assert.deepEqual(result.values, [[null, null, null]]);
});

test('an empty return is empty, not an error', () => {
	const result = TensorScript.normalizeCells([]);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.text, []);
});

/* -------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------- */

test('formats script cells the way the built-in decoders do', () => {
	assert.equal(TensorScript.formatNumber(1.5), '1.5');
	assert.equal(TensorScript.formatNumber(0), '0');
	assert.equal(TensorScript.formatNumber(-0), '0');
	assert.equal(TensorScript.formatNumber(42), '42');
	assert.equal(TensorScript.formatNumber(0.333251953125), '0.3333');
	assert.equal(TensorScript.formatNumber(1e-9), '1.000e-9');
	assert.equal(TensorScript.formatNumber(NaN), 'NaN');
	assert.equal(TensorScript.formatNumber(-Infinity), '-inf');
});

test('summarises only the numeric cells for the heat map', () => {
	const stats = TensorScript.statsFromCells([[1, null], [-3, 5]]);
	assert.equal(stats.min, -3);
	assert.equal(stats.max, 5);
	assert.equal(stats.mean, 1);
	assert.equal(stats.finite, 3);
});

test('an all-text grid has no colour scale to compute', () => {
	const stats = TensorScript.statsFromCells([[null, null]]);
	assert.equal(stats.finite, 0);
	assert.equal(stats.min, 0);
	assert.equal(stats.max, 0);
});
