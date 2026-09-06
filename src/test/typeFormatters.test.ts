/*---------------------------------------------------------------------------
 * Unit tests for the pure half of the formatter layer: type-string parsing,
 * the length arithmetic every synthetic child is derived from, and formatter
 * selection. No debugger involved - the end-to-end path is covered by
 * adapter.integration.test.ts against fakeGdb.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createDefaultFormatterRegistry,
	decodeText,
	escapeCString,
	firstTemplateArgument,
	ITypeFormatter,
	quoteText,
	StdStringFormatter,
	StdVectorFormatter,
	stripCvRef,
	TypeFormatterRegistry,
	vectorLength,
} from '../typeFormatters';

/* -------------------------------------------------------------------------
 * stripCvRef
 * ---------------------------------------------------------------------- */

test('strips qualifiers a debugger adds but a match should ignore', () => {
	assert.equal(stripCvRef('const std::vector<float> &'), 'std::vector<float>');
	assert.equal(stripCvRef('std::vector<float> &&'), 'std::vector<float>');
	// Both qualifiers, in either order.
	assert.equal(stripCvRef('volatile const int'), 'int');
	assert.equal(stripCvRef('const volatile int'), 'int');
	// An inner const belongs to the element type and must survive.
	assert.equal(stripCvRef('std::vector<const char *>'), 'std::vector<const char *>');
	assert.equal(stripCvRef(''), '');
});

/* -------------------------------------------------------------------------
 * firstTemplateArgument
 * ---------------------------------------------------------------------- */

test('reads the element type out of a template, respecting nesting', () => {
	assert.equal(
		firstTemplateArgument('std::vector<float, std::allocator<float> >'), 'float');
	// The comma inside std::pair must not end the argument.
	assert.equal(
		firstTemplateArgument('std::vector<std::pair<int, int>, std::allocator<std::pair<int, int> > >'),
		'std::pair<int, int>');
	// Sole argument: the closing angle bracket ends it.
	assert.equal(firstTemplateArgument('std::atomic<int>'), 'int');
	assert.equal(firstTemplateArgument('int'), undefined);
	assert.equal(firstTemplateArgument(''), undefined);
});

/* -------------------------------------------------------------------------
 * vectorLength
 * ---------------------------------------------------------------------- */

test('derives the element count from the raw pointers', () => {
	// 0x2000..0x2010 of 4-byte floats.
	assert.equal(vectorLength(0x2000n, 0x2010n, 4n), 4);
	// An empty vector is a real state, not a failure.
	assert.equal(vectorLength(0x2000n, 0x2000n, 4n), 0);
});

test('refuses pointer pairs that cannot describe a live vector', () => {
	// finish before start: an uninitialised or moved-from object.
	assert.equal(vectorLength(0x2010n, 0x2000n, 4n), undefined);
	// Not a whole number of elements: the layout assumption is wrong.
	assert.equal(vectorLength(0x2000n, 0x2006n, 4n), undefined);
	// A zero-sized element would divide by zero.
	assert.equal(vectorLength(0x2000n, 0x2010n, 0n), undefined);
});

/* -------------------------------------------------------------------------
 * StdVectorFormatter.match
 * ---------------------------------------------------------------------- */

test('claims the libstdc++ and libc++ spellings of std::vector', () => {
	const formatter = new StdVectorFormatter();
	assert.equal(formatter.match('std::vector<float, std::allocator<float> >'), true);
	assert.equal(formatter.match('const std::vector<float, std::allocator<float> > &'), true);
	// libc++ inserts an inline namespace.
	assert.equal(formatter.match('std::__1::vector<int, std::__1::allocator<int> >'), true);
});

test('declines types whose layout the pointer arithmetic would misread', () => {
	const formatter = new StdVectorFormatter();
	// Bit-packed specialisation: _M_start is not an element pointer.
	assert.equal(formatter.match('std::vector<bool, std::allocator<bool> >'), false);
	assert.equal(formatter.match('std::map<int, int>'), false);
	assert.equal(formatter.match('float *'), false);
	// A user type that merely starts with the same letters.
	assert.equal(formatter.match('std::vector_view<int>'), false);
});

/* -------------------------------------------------------------------------
 * StdStringFormatter.match
 * ---------------------------------------------------------------------- */

test('claims the spellings of a byte std::string', () => {
	const formatter = new StdStringFormatter();
	assert.equal(formatter.match(
		'std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >'), true);
	assert.equal(formatter.match(
		'std::basic_string<char, std::char_traits<char>, std::allocator<char> >'), true);
	// The typedef, as some debuggers report it.
	assert.equal(formatter.match('std::string'), true);
	assert.equal(formatter.match('const std::__cxx11::string &'), true);
});

test('declines strings whose characters are not bytes', () => {
	const formatter = new StdStringFormatter();
	// wstring, u16string and u32string all need different decoding.
	assert.equal(formatter.match(
		'std::__cxx11::basic_string<wchar_t, std::char_traits<wchar_t>, std::allocator<wchar_t> >'),
		false);
	assert.equal(formatter.match(
		'std::__cxx11::basic_string<char16_t, std::char_traits<char16_t> >'), false);
	assert.equal(formatter.match('std::string_view'), false);
	assert.equal(formatter.match('char *'), false);
});

/* -------------------------------------------------------------------------
 * Text decoding
 * ---------------------------------------------------------------------- */

test('decodes UTF-8 when the bytes really are UTF-8', () => {
	assert.equal(decodeText(Buffer.from('hello ascend', 'utf8')), 'hello ascend');
	assert.equal(decodeText(Buffer.from('naïve café', 'utf8')), 'naïve café');
	assert.equal(decodeText(Buffer.alloc(0)), '');
});

test('falls back to raw bytes rather than inventing replacement characters', () => {
	// A half-initialised buffer is not text; showing the bytes is more honest
	// than a row of U+FFFD.
	const invalid = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
	const decoded = decodeText(invalid);
	assert.equal(decoded, 'AÿþB');
	assert.equal(decoded.includes('�'), false);
});

test('escapes what would otherwise break the row', () => {
	assert.equal(escapeCString('plain'), 'plain');
	assert.equal(escapeCString('a\nb\tc'), 'a\\nb\\tc');
	assert.equal(escapeCString('say "hi"'), 'say \\"hi\\"');
	assert.equal(escapeCString('back\\slash'), 'back\\\\slash');
	// Control bytes become hex escapes, not invisible holes.
	assert.equal(escapeCString('\x00\x1b\x7f'), '\\x00\\x1b\\x7f');
});

test('marks a clamped read instead of pretending it was the whole string', () => {
	assert.equal(quoteText('hello', 0), '"hello"');
	assert.equal(quoteText('hello', 95), '"hello"... (100 chars)');
});

/* -------------------------------------------------------------------------
 * Registry
 * ---------------------------------------------------------------------- */

function stubFormatter(name: string): ITypeFormatter {
	return {
		name,
		match: () => true,
		inspect: async () => undefined,
		getChildren: async () => [],
	};
}

test('the most recently registered formatter shadows earlier ones', () => {
	const registry = new TypeFormatterRegistry();
	registry.register(stubFormatter('builtin'));
	registry.register(stubFormatter('override'));
	assert.equal(registry.find('anything')?.name, 'override');
});

test('an unknown or absent type matches nothing', () => {
	const registry = createDefaultFormatterRegistry();
	assert.equal(registry.find(undefined), undefined);
	assert.equal(registry.find(''), undefined);
	assert.equal(registry.find('int'), undefined);
});

test('the default registry routes std::vector to the vector formatter', () => {
	const registry = createDefaultFormatterRegistry();
	assert.equal(registry.find('std::vector<float, std::allocator<float> >')?.name, 'std::vector');
});
