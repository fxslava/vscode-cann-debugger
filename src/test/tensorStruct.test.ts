/*---------------------------------------------------------------------------
 * Unit tests for the C struct DSL.
 *
 * Offsets, padding and bitfield placement are the whole value of this
 * feature: a viewer that gets them subtly wrong shows plausible numbers from
 * the wrong bytes, which is worse than showing nothing. So the layout is
 * checked against what a C compiler would produce, field by field.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

interface Field {
	name: string;
	type: string;
	kind: string;
	count: number;
	offsetBits: number;
	widthBits: number;
	bitfield: boolean;
}

interface Parsed {
	error?: string;
	name?: string;
	fields?: Field[];
	size?: number;
	alignment?: number;
	packed?: boolean;
}

interface Decoded {
	error?: string;
	columns?: string[];
	text?: string[][];
	values?: (number | null)[][];
	size?: number;
	count?: number;
}

interface TensorStructModule {
	TEMPLATE: string;
	parseStruct(source: string): Parsed;
	decodeStructs(source: string, buffer: Uint8Array): Decoded;
}

const TensorStruct: TensorStructModule =
	require(join(__dirname, '..', '..', 'media', 'tensorStruct.js'));

/** Field offsets in bytes, keyed by name - what a C programmer would check. */
function offsets(source: string): Record<string, number> {
	const parsed = TensorStruct.parseStruct(source);
	assert.equal(parsed.error, undefined, parsed.error);
	const out: Record<string, number> = {};
	for (const field of parsed.fields!) {
		out[field.name] = field.offsetBits / 8;
	}
	return out;
}

function sizeOf(source: string): number {
	const parsed = TensorStruct.parseStruct(source);
	assert.equal(parsed.error, undefined, parsed.error);
	return parsed.size!;
}

/* -------------------------------------------------------------------------
 * Layout: alignment and padding
 * ---------------------------------------------------------------------- */

test('aligns each member to its own size and pads the struct to its widest', () => {
	// char at 0, then 3 bytes of padding before the int, then 4 more at the
	// end so an array of these keeps the int aligned.
	const source = 'struct S { char a; int b; char c; };';
	assert.deepEqual(offsets(source), { a: 0, b: 4, c: 8 });
	assert.equal(sizeOf(source), 12);
});

test('a struct of one type needs no padding at all', () => {
	const source = 'struct S { uint16_t a; uint16_t b; uint16_t c; };';
	assert.deepEqual(offsets(source), { a: 0, b: 2, c: 4 });
	assert.equal(sizeOf(source), 6);
});

test('an 8-byte member drags the whole struct to 8-byte alignment', () => {
	const source = 'struct S { uint8_t flag; uint64_t address; uint8_t tail; };';
	assert.deepEqual(offsets(source), { flag: 0, address: 8, tail: 16 });
	assert.equal(sizeOf(source), 24);
});

test('packed removes every byte of padding', () => {
	const source = 'struct S { char a; int b; char c; } __attribute__((packed));';
	assert.deepEqual(offsets(source), { a: 0, b: 1, c: 5 });
	assert.equal(sizeOf(source), 6);
	assert.equal(TensorStruct.parseStruct(source).packed, true);
});

test('#pragma pack(1) means the same thing', () => {
	const source = '#pragma pack(1)\nstruct S { char a; int b; };';
	assert.deepEqual(offsets(source), { a: 0, b: 1 });
	assert.equal(sizeOf(source), 5);
});

test('arrays occupy their whole extent', () => {
	const source = 'struct S { uint8_t tag; __fp16 data[16]; uint8_t tail; };';
	// tag at 0, one byte of padding, 32 bytes of halves, then the tail.
	assert.deepEqual(offsets(source), { tag: 0, data: 2, tail: 34 });
	assert.equal(sizeOf(source), 36);
});

/* -------------------------------------------------------------------------
 * Layout: bitfields
 * ---------------------------------------------------------------------- */

test('packs bitfields from the least significant bit up', () => {
	const parsed = TensorStruct.parseStruct(TensorStruct.TEMPLATE);
	assert.equal(parsed.error, undefined, parsed.error);
	const byName = new Map(parsed.fields!.map((f) => [f.name, f]));

	assert.equal(byName.get('magic')!.offsetBits, 0);
	// Both bitfields share the uint16_t at byte 2: dim in bits 0-3, stride 4-15.
	assert.equal(byName.get('dim')!.offsetBits, 16);
	assert.equal(byName.get('dim')!.widthBits, 4);
	assert.equal(byName.get('stride')!.offsetBits, 20);
	assert.equal(byName.get('stride')!.widthBits, 12);
	// The half array follows on its own 2-byte boundary.
	assert.equal(byName.get('data')!.offsetBits, 32);
	assert.equal(parsed.size, 36);
});

test('a bitfield never straddles its storage unit', () => {
	// 6 + 6 = 12 bits fit one byte? No - the second would cross into the next,
	// so it starts a fresh unit at bit 8.
	const parsed = TensorStruct.parseStruct('struct S { uint8_t a : 6; uint8_t b : 6; };');
	const [a, b] = parsed.fields!;
	assert.equal(a.offsetBits, 0);
	assert.equal(b.offsetBits, 8);
	assert.equal(parsed.size, 2);
});

test('consecutive bitfields share a unit when they fit', () => {
	const parsed = TensorStruct.parseStruct(
		'struct S { uint32_t a : 1; uint32_t b : 2; uint32_t c : 29; };');
	assert.deepEqual(parsed.fields!.map((f) => f.offsetBits), [0, 1, 3]);
	assert.equal(parsed.size, 4);
});

test('a zero-width bitfield skips to the next unit and takes no column', () => {
	const parsed = TensorStruct.parseStruct(
		'struct S { uint8_t a : 3; uint8_t : 0; uint8_t b : 3; };');
	assert.equal(parsed.fields!.length, 2, 'the unnamed :0 is not a field');
	assert.deepEqual(parsed.fields!.map((f) => f.offsetBits), [0, 8]);
});

test('a plain member after a bitfield resumes on a byte boundary', () => {
	const parsed = TensorStruct.parseStruct('struct S { uint8_t a : 3; uint8_t b; };');
	assert.deepEqual(parsed.fields!.map((f) => f.offsetBits), [0, 8]);
});

/* -------------------------------------------------------------------------
 * Decoding
 * ---------------------------------------------------------------------- */

/** One TileHeader: magic=0xBEEF, dim=5, stride=1024, data[0..15]=i. */
function tileHeaderBytes(instances = 1): Uint8Array {
	const size = 36;
	const bytes = new Uint8Array(size * instances);
	const view = new DataView(bytes.buffer);
	for (let n = 0; n < instances; n++) {
		const base = n * size;
		view.setUint16(base, 0xbeef + n, true);
		// dim in bits 0-3, stride in bits 4-15 of the u16 at byte 2.
		view.setUint16(base + 2, (5 & 0xf) | ((1024 & 0xfff) << 4), true);
		for (let i = 0; i < 16; i++) {
			// 1.0 as float16 is 0x3C00; scale by i to keep values distinct.
			view.setUint16(base + 4 + i * 2, i === 0 ? 0 : 0x3c00 + (i - 1) * 0x0400, true);
		}
	}
	return bytes;
}

test('decodes the template struct out of real bytes', () => {
	const decoded = TensorStruct.decodeStructs(TensorStruct.TEMPLATE, tileHeaderBytes());
	assert.equal(decoded.error, undefined, decoded.error);
	assert.equal(decoded.size, 36);
	assert.equal(decoded.count, 1);

	// Array members become one column each.
	assert.equal(decoded.columns!.length, 3 + 16);
	assert.deepEqual(decoded.columns!.slice(0, 5),
		['magic', 'dim', 'stride', 'data[0]', 'data[1]']);

	const row = decoded.text![0];
	assert.equal(row[0], '48879');   // 0xBEEF
	assert.equal(row[1], '5');       // the 4-bit field
	assert.equal(row[2], '1024');    // the 12-bit field beside it
	assert.equal(row[3], '0');
	assert.equal(row[4], '1');       // 0x3C00 is 1.0 as float16
});

test('one row per struct in the window', () => {
	const decoded = TensorStruct.decodeStructs(TensorStruct.TEMPLATE, tileHeaderBytes(3));
	assert.equal(decoded.count, 3);
	assert.equal(decoded.text!.length, 3);
	// The magic was made distinct per instance.
	assert.deepEqual(decoded.text!.map((r) => r[0]), ['48879', '48880', '48881']);
});

test('a trailing partial struct is ignored rather than half-decoded', () => {
	const bytes = new Uint8Array(36 * 2 + 10);
	const decoded = TensorStruct.decodeStructs(TensorStruct.TEMPLATE, bytes);
	assert.equal(decoded.count, 2);
});

test('signed bitfields are sign-extended', () => {
	// 4 bits holding 0b1111 is -1 signed, 15 unsigned.
	const bytes = new Uint8Array([0x0f]);
	const signed = TensorStruct.decodeStructs('struct S { int8_t a : 4; };', bytes);
	assert.equal(signed.text![0][0], '-1');
	const unsigned = TensorStruct.decodeStructs('struct S { uint8_t a : 4; };', bytes);
	assert.equal(unsigned.text![0][0], '15');
});

test('decodes every scalar type at its own width', () => {
	const bytes = new Uint8Array(24);
	const view = new DataView(bytes.buffer);
	view.setInt8(0, -8);
	view.setInt16(2, -300, true);
	view.setInt32(4, -70000, true);
	view.setFloat32(8, 1.5, true);
	view.setFloat64(16, -2.25, true);

	const decoded = TensorStruct.decodeStructs(
		'struct S { int8_t a; int16_t b; int32_t c; float d; double e; };', bytes);
	assert.equal(decoded.error, undefined, decoded.error);
	assert.deepEqual(decoded.text![0], ['-8', '-300', '-70000', '1.5', '-2.25']);
});

test('64-bit values beyond a double stay exact as text', () => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, 18446744073709551615n, true);
	const decoded = TensorStruct.decodeStructs('struct S { uint64_t a; };', bytes);
	// Rounding this into a Number would print 18446744073709552000.
	assert.equal(decoded.text![0][0], '18446744073709551615');
});

test('bool reads as true or false', () => {
	const decoded = TensorStruct.decodeStructs(
		'struct S { bool a; bool b; };', new Uint8Array([0, 1]));
	assert.deepEqual(decoded.text![0], ['false', 'true']);
});

test('only numeric cells feed the colour scale', () => {
	const decoded = TensorStruct.decodeStructs(
		'struct S { bool flag; uint8_t n; };', new Uint8Array([1, 42]));
	assert.deepEqual(decoded.values![0], [null, 42]);
});

/* -------------------------------------------------------------------------
 * Diagnosis, not guesswork
 * ---------------------------------------------------------------------- */

test('an unknown type names the type', () => {
	const parsed = TensorStruct.parseStruct('struct S { widget_t a; };');
	assert.match(parsed.error!, /Unknown type "widget_t"/);
});

test('an over-wide bitfield says what would not fit', () => {
	const parsed = TensorStruct.parseStruct('struct S { uint8_t a : 9; };');
	assert.match(parsed.error!, /"a" is 9 bits, wider than the 8-bit uint8_t/);
});

test('a bitfield on a float type is refused', () => {
	const parsed = TensorStruct.parseStruct('struct S { float a : 4; };');
	assert.match(parsed.error!, /needs an integer type/);
});

test('unsupported C is named rather than mis-parsed', () => {
	assert.match(TensorStruct.parseStruct('struct S { struct T { int x; } t; };').error!,
		/Nested structs and unions are not supported/);
	assert.match(TensorStruct.parseStruct('struct S { int * p; };').error!,
		/Pointers are not supported/);
	assert.match(TensorStruct.parseStruct('int x;').error!,
		/Could not find a `struct \{ \.\.\. \}` definition/);
	assert.match(TensorStruct.parseStruct('struct S { };').error!,
		/no fields/);
});

test('a window too small for one struct says so with both sizes', () => {
	const decoded = TensorStruct.decodeStructs(TensorStruct.TEMPLATE, new Uint8Array(8));
	assert.match(decoded.error!, /window is 8 bytes but one TileHeader is 36/);
});

/* -------------------------------------------------------------------------
 * C spellings that should just work
 * ---------------------------------------------------------------------- */

test('accepts specifiers in any order and the usual spellings', () => {
	assert.equal(sizeOf('struct S { unsigned int a; };'), 4);
	assert.equal(sizeOf('struct S { unsigned a; };'), 4);
	assert.equal(sizeOf('struct S { long int a; };'), 8);
	assert.equal(sizeOf('struct S { unsigned long long a; };'), 8);
	assert.equal(sizeOf('struct S { const volatile uint32_t a; };'), 4);
	// half and __fp16 are the same 2-byte type.
	assert.equal(sizeOf('struct S { half a; };'), 2);
	assert.equal(sizeOf('struct S { __bf16 a; };'), 2);
});

test('several fields can share one declaration', () => {
	const source = 'struct S { uint16_t a, b, c; };';
	assert.deepEqual(offsets(source), { a: 0, b: 2, c: 4 });
});

test('a field may be named after a type keyword', () => {
	// `half` is a type, but here it is the field name.
	const parsed = TensorStruct.parseStruct('struct S { uint16_t half; };');
	assert.equal(parsed.error, undefined, parsed.error);
	assert.equal(parsed.fields![0].name, 'half');
});

test('comments are ignored', () => {
	const source = [
		'struct S {',
		'  uint16_t a; // the magic',
		'  /* a gap */',
		'  uint16_t b;',
		'};',
	].join('\n');
	assert.deepEqual(offsets(source), { a: 0, b: 2 });
});

test('an anonymous struct is fine - the name is only a label', () => {
	const parsed = TensorStruct.parseStruct('struct { uint8_t a; };');
	assert.equal(parsed.error, undefined, parsed.error);
	assert.equal(parsed.size, 1);
});
