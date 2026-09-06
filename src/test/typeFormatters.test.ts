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
	firstTemplateArgument,
	ITypeFormatter,
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
