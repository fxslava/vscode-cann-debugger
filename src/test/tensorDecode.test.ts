/*---------------------------------------------------------------------------
 * Unit tests for tensor decoding.
 *
 * The half-precision formats carry the weight here: FP16 and BF16 are what
 * Ascend kernels actually hold, neither is a native JavaScript type, and both
 * are decoded by hand - so they are checked against known bit patterns rather
 * than against another implementation of the same arithmetic.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	decodeTensor,
	DTYPES,
	dtypeInfo,
	formatValue,
	gridShape,
	guessDType,
	isTensorDType,
	parseShape,
	readBFloat16,
	readFloat16,
	shapeElements,
	tensorStats,
} from '../tensorDecode';

/** Two bytes, little-endian, from a 16-bit pattern. */
function halfBytes(...patterns: number[]): Buffer {
	const buffer = Buffer.alloc(patterns.length * 2);
	patterns.forEach((p, i) => buffer.writeUInt16LE(p, i * 2));
	return buffer;
}

/* -------------------------------------------------------------------------
 * float16
 * ---------------------------------------------------------------------- */

test('decodes IEEE 754 binary16 against known bit patterns', () => {
	assert.equal(readFloat16(halfBytes(0x3c00), 0), 1);
	assert.equal(readFloat16(halfBytes(0xbc00), 0), -1);
	assert.equal(readFloat16(halfBytes(0x4000), 0), 2);
	assert.equal(readFloat16(halfBytes(0xc000), 0), -2);
	assert.equal(readFloat16(halfBytes(0x0000), 0), 0);
	// 1/3 as the nearest half.
	assert.equal(readFloat16(halfBytes(0x3555), 0), 0.333251953125);
	// The largest finite half.
	assert.equal(readFloat16(halfBytes(0x7bff), 0), 65504);
	assert.equal(readFloat16(halfBytes(0xfbff), 0), -65504);
});

test('decodes half-precision subnormals and specials', () => {
	// Smallest positive subnormal: 2^-24.
	assert.equal(readFloat16(halfBytes(0x0001), 0), 2 ** -24);
	// Largest subnormal, just below the smallest normal.
	assert.equal(readFloat16(halfBytes(0x03ff), 0), 1023 * 2 ** -24);
	assert.equal(readFloat16(halfBytes(0x7c00), 0), Infinity);
	assert.equal(readFloat16(halfBytes(0xfc00), 0), -Infinity);
	assert.equal(Number.isNaN(readFloat16(halfBytes(0x7e00), 0)), true);
	// Negative zero is decoded faithfully as -0 rather than folded to 0; the
	// grid is where that distinction gets dropped, not the decoder.
	assert.equal(Object.is(readFloat16(halfBytes(0x8000), 0), -0), true);
	assert.equal(formatValue(readFloat16(halfBytes(0x8000), 0), 'float16'), '0');
});

/* -------------------------------------------------------------------------
 * bfloat16
 * ---------------------------------------------------------------------- */

test('decodes bfloat16 as the top half of a float32', () => {
	assert.equal(readBFloat16(halfBytes(0x3f80), 0), 1);
	// The sign bit must not turn the shift into a negative int32.
	assert.equal(readBFloat16(halfBytes(0xbf80), 0), -1);
	assert.equal(readBFloat16(halfBytes(0x4049), 0), 3.140625);
	assert.equal(readBFloat16(halfBytes(0x0000), 0), 0);
	assert.equal(readBFloat16(halfBytes(0x7f80), 0), Infinity);
	assert.equal(readBFloat16(halfBytes(0xff80), 0), -Infinity);
	assert.equal(Number.isNaN(readBFloat16(halfBytes(0x7fc0), 0)), true);
});

test('bfloat16 keeps float32 range where float16 would overflow', () => {
	// 2^100: representable as bfloat16, infinite as float16.
	const big = readBFloat16(halfBytes(0x7180), 0);
	assert.equal(Number.isFinite(big), true);
	assert.equal(big, 2 ** 100);
});

/* -------------------------------------------------------------------------
 * decodeTensor
 * ---------------------------------------------------------------------- */

test('decodes each supported element type at its own stride', () => {
	const floats = Buffer.alloc(12);
	floats.writeFloatLE(1.5, 0);
	floats.writeFloatLE(-2.25, 4);
	floats.writeFloatLE(0, 8);
	assert.deepEqual(decodeTensor(floats, 'float32', 3), [1.5, -2.25, 0]);

	// int8 is signed: 0xff is -1, not 255.
	const bytes = Buffer.from([0x00, 0x7f, 0xff, 0x80]);
	assert.deepEqual(decodeTensor(bytes, 'int8', 4), [0, 127, -1, -128]);
	assert.deepEqual(decodeTensor(bytes, 'uint8', 4), [0, 127, 255, 128]);

	const wide = Buffer.alloc(8);
	wide.writeInt32LE(-70000, 0);
	wide.writeUInt32LE(4000000000, 4);
	// The same four bytes read either way: signedness is the only difference.
	assert.deepEqual(decodeTensor(wide, 'int32', 2), [-70000, 4000000000 - 2 ** 32]);
	assert.deepEqual(decodeTensor(wide, 'uint32', 2), [2 ** 32 - 70000, 4000000000]);

	assert.deepEqual(decodeTensor(halfBytes(0x3c00, 0x4000), 'float16', 2), [1, 2]);
	assert.deepEqual(decodeTensor(halfBytes(0x3f80, 0xbf80), 'bfloat16', 2), [1, -1]);
});

test('a short read yields the elements that were readable, not an error', () => {
	// Six bytes of a requested four float32s: one and a half elements arrived.
	const partial = Buffer.alloc(6);
	partial.writeFloatLE(3.5, 0);
	const values = decodeTensor(partial, 'float32', 4);
	assert.deepEqual(values, [3.5]);
});

test('asking for fewer elements than the buffer holds stops early', () => {
	const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
	assert.deepEqual(decodeTensor(bytes, 'uint8', 2), [1, 2]);
	assert.deepEqual(decodeTensor(Buffer.alloc(0), 'float32', 4), []);
});

/* -------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------- */

test('parses the ways people write a shape', () => {
	assert.deepEqual(parseShape('16x16'), [16, 16]);
	assert.deepEqual(parseShape('16X16'), [16, 16]);
	assert.deepEqual(parseShape('16*16'), [16, 16]);
	assert.deepEqual(parseShape('16, 16'), [16, 16]);
	assert.deepEqual(parseShape('2x3x4'), [2, 3, 4]);
	assert.deepEqual(parseShape(' 256 '), [256]);
});

test('refuses text that is not a shape rather than guessing', () => {
	assert.equal(parseShape(''), undefined);
	assert.equal(parseShape('   '), undefined);
	assert.equal(parseShape('abc'), undefined);
	assert.equal(parseShape('16x'), undefined);
	// A zero dimension would collapse the element count to nothing.
	assert.equal(parseShape('0x16'), undefined);
	assert.equal(parseShape('16x-4'), undefined);
	assert.equal(parseShape('1.5x2'), undefined);
});

test('flattens a shape into rows and columns, last dimension across', () => {
	assert.deepEqual(gridShape([16, 16]), { rows: 16, columns: 16 });
	// The contiguous dimension is the row; everything above it stacks.
	assert.deepEqual(gridShape([2, 3, 4]), { rows: 6, columns: 4 });
	assert.deepEqual(gridShape([256]), { rows: 1, columns: 256 });
	assert.deepEqual(gridShape([]), { rows: 0, columns: 0 });
	assert.equal(shapeElements([2, 3, 4]), 24);
});

/* -------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------- */

test('formats cells short enough for a grid', () => {
	assert.equal(formatValue(1.5, 'float32'), '1.5');
	assert.equal(formatValue(0.333251953125, 'float16'), '0.3333');
	assert.equal(formatValue(0, 'float32'), '0');
	// Negative zero is noise in a tensor, not information.
	assert.equal(formatValue(-0, 'float32'), '0');
	assert.equal(formatValue(-2.25, 'float32'), '-2.25');
	// Out of comfortable decimal range, switch to exponent form.
	assert.equal(formatValue(1e-9, 'float32'), '1.000e-9');
	assert.equal(formatValue(2.5e8, 'float32'), '2.500e+8');
	// Integers are never dressed up as decimals.
	assert.equal(formatValue(-128, 'int8'), '-128');
	assert.equal(formatValue(255, 'uint8'), '255');
});

test('names the specials instead of showing a blank cell', () => {
	assert.equal(formatValue(NaN, 'float16'), 'NaN');
	assert.equal(formatValue(Infinity, 'float32'), 'inf');
	assert.equal(formatValue(-Infinity, 'float32'), '-inf');
});

test('summarises the finite values and counts the rest', () => {
	const stats = tensorStats([1, -3, NaN, Infinity, 5, -Infinity]);
	assert.equal(stats.min, -3);
	assert.equal(stats.max, 5);
	assert.equal(stats.mean, 1);
	assert.equal(stats.finite, 3);
	assert.equal(stats.nan, 1);
	assert.equal(stats.infinite, 2);
});

test('an all-NaN tensor reports zeroed bounds, which is itself the diagnosis', () => {
	const stats = tensorStats([NaN, NaN]);
	assert.equal(stats.nan, 2);
	assert.equal(stats.finite, 0);
	assert.equal(stats.min, 0);
	assert.equal(stats.max, 0);
	assert.equal(Number.isNaN(stats.mean), false);
});

/* -------------------------------------------------------------------------
 * Type metadata and guessing
 * ---------------------------------------------------------------------- */

test('every offered type has a stride that matches its name', () => {
	assert.equal(dtypeInfo('float16').size, 2);
	assert.equal(dtypeInfo('bfloat16').size, 2);
	assert.equal(dtypeInfo('float32').size, 4);
	assert.equal(dtypeInfo('float64').size, 8);
	assert.equal(dtypeInfo('int8').size, 1);
	// 64-bit integers are deliberately not offered: they do not survive a
	// round trip through a JavaScript number.
	assert.equal(DTYPES.some((d) => d.id.includes('64') && !d.float), false);
	assert.equal(isTensorDType('float16'), true);
	assert.equal(isTensorDType('int64'), false);
	assert.equal(isTensorDType(undefined), false);
});

test('guesses the element type from the C type of the clicked variable', () => {
	// Ascend C spells float16 "half"; getting this one right matters most.
	assert.equal(guessDType('half'), 'float16');
	assert.equal(guessDType('__gm__ half *'), 'float16');
	assert.equal(guessDType('const __ubuf__ half *'), 'float16');
	assert.equal(guessDType('float'), 'float32');
	assert.equal(guessDType('float [16]'), 'float32');
	assert.equal(guessDType('double'), 'float64');
	assert.equal(guessDType('int8_t'), 'int8');
	assert.equal(guessDType('uint8_t'), 'uint8');
	assert.equal(guessDType('int'), 'int32');
	assert.equal(guessDType('__bf16'), 'bfloat16');
});

test('offers no guess rather than a wrong one', () => {
	assert.equal(guessDType(undefined), undefined);
	assert.equal(guessDType(''), undefined);
	assert.equal(guessDType('TilingData'), undefined);
	assert.equal(guessDType('std::vector<float, std::allocator<float> >'), undefined);
});
