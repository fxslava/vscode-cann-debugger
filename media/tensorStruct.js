// @ts-check
/*
 * A C struct DSL for the Tensor Inspector.
 *
 * Hardware descriptors are defined in C, so let them be described in C rather
 * than transcribed into DataView offsets by hand. The user pastes a struct,
 * this works out the offsets, and the window is decoded as an array of those
 * structs - one row each.
 *
 * The layout rules it implements, because a viewer that guesses them wrong
 * lies silently:
 *
 *   Endianness   little, matching the target.
 *   Model        LP64: `long` is 8 bytes. `int` 4, `short` 2, pointers absent.
 *   Alignment    natural - each member aligns to its own size, and the struct
 *                is padded to its widest member. `__attribute__((packed))` or
 *                `#pragma pack(1)` switches everything to alignment 1.
 *   Bitfields    the GCC little-endian rules: allocated from the least
 *                significant bit up, never straddling a storage unit of the
 *                declared type, and `: 0` skips to the next unit boundary.
 *
 * Not supported, and each says so rather than guessing: nested or anonymous
 * structs and unions, pointers, enums, typedefs, and flexible array members.
 *
 * Loaded as a webview <script> (defines window.TensorStruct) and as a
 * CommonJS module, so the layout arithmetic is unit tested in Node.
 */
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./tensorScript.js'));
	} else {
		root.TensorStruct = factory(root.TensorScript);
	}
}(typeof self !== 'undefined' ? self : this, function (TensorScript) {
	'use strict';

	/* --------------------------- type table ---------------------------- */

	const TYPES = {
		'bool': { size: 1, kind: 'bool' },
		'_Bool': { size: 1, kind: 'bool' },
		'char': { size: 1, kind: 'int' },
		'signed char': { size: 1, kind: 'int' },
		'unsigned char': { size: 1, kind: 'uint' },
		'int8_t': { size: 1, kind: 'int' },
		'uint8_t': { size: 1, kind: 'uint' },
		'short': { size: 2, kind: 'int' },
		'unsigned short': { size: 2, kind: 'uint' },
		'int16_t': { size: 2, kind: 'int' },
		'uint16_t': { size: 2, kind: 'uint' },
		'int': { size: 4, kind: 'int' },
		'unsigned int': { size: 4, kind: 'uint' },
		'int32_t': { size: 4, kind: 'int' },
		'uint32_t': { size: 4, kind: 'uint' },
		'long': { size: 8, kind: 'int' },
		'unsigned long': { size: 8, kind: 'uint' },
		'long long': { size: 8, kind: 'int' },
		'unsigned long long': { size: 8, kind: 'uint' },
		'int64_t': { size: 8, kind: 'int' },
		'uint64_t': { size: 8, kind: 'uint' },
		'size_t': { size: 8, kind: 'uint' },
		'float': { size: 4, kind: 'float' },
		'double': { size: 8, kind: 'double' },
		'__fp16': { size: 2, kind: 'fp16' },
		'half': { size: 2, kind: 'fp16' },
		'float16_t': { size: 2, kind: 'fp16' },
		'__bf16': { size: 2, kind: 'bf16' },
		'bfloat16_t': { size: 2, kind: 'bf16' },
	};

	/** Words that can appear inside a type, as opposed to naming a field. */
	const TYPE_WORDS = new Set(
		Object.keys(TYPES)
			.reduce(function (all, key) { return all.concat(key.split(' ')); }, [])
			.concat(['const', 'volatile', 'signed', 'unsigned']));

	const INTEGER_KINDS = new Set(['int', 'uint', 'bool']);

	/** Same ceiling as everywhere else in the inspector. */
	const MAX_CELLS = 65536;

	const TEMPLATE = [
		'struct TileHeader {',
		'    uint16_t magic;',
		'    uint16_t dim    : 4;',
		'    uint16_t stride : 12;',
		'    __fp16   data[16];',
		'};',
	].join('\n');

	/* ------------------------------ parse ------------------------------ */

	function stripComments(source) {
		return String(source || '')
			.replace(/\/\*[\s\S]*?\*\//g, ' ')
			.replace(/\/\/[^\n]*/g, ' ');
	}

	function roundUp(value, multiple) {
		return multiple <= 1 ? value : Math.ceil(value / multiple) * multiple;
	}

	function tokenize(statement) {
		return statement
			.replace(/([[\]:,])/g, ' $1 ')
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	}

	/**
	 * Turn the specifier words into one of the entries in TYPES. C lets the
	 * specifiers appear in any order, so signedness is pulled out and the rest
	 * is normalised - `long int` and `long` are the same type.
	 */
	function resolveType(words) {
		let sign = null;
		const base = [];
		for (const word of words) {
			if (word === 'const' || word === 'volatile') {
				continue;
			}
			if (word === 'unsigned' || word === 'signed') {
				sign = word;
			} else {
				base.push(word);
			}
		}

		let key = base.join(' ');
		if (key === 'long int') { key = 'long'; }
		if (key === 'long long int') { key = 'long long'; }
		if (key === 'short int') { key = 'short'; }
		// A bare `unsigned x;` is an unsigned int.
		if (key === '' && sign) { key = 'int'; }

		if (sign === 'unsigned') {
			key = 'unsigned ' + key;
		} else if (sign === 'signed' && key === 'char') {
			key = 'signed char';
		}
		return TYPES[key] ? { key: key, info: TYPES[key] } : undefined;
	}

	function fail(message) {
		return { error: message };
	}

	/**
	 * Parse a struct definition into placed fields.
	 *
	 * Returns `{ error }` for anything it cannot lay out - an unknown type, a
	 * bitfield wider than its storage unit, a nested struct - naming the field
	 * so the message points at the line to fix.
	 */
	function parseStruct(source) {
		const text = stripComments(source);
		if (!text.trim()) {
			return fail('Write a struct definition, for example:\n' + TEMPLATE);
		}

		const packed = /__attribute__\s*\(\s*\(\s*[^)]*\bpacked\b[^)]*\)\s*\)/.test(text) ||
			/#\s*pragma\s+pack\s*\(\s*1\s*\)/.test(text);

		// Checked before matching, not after: the body pattern below cannot
		// span braces, so on a nested definition it would happily match the
		// *inner* struct and lay that out instead of complaining.
		if ((text.match(/\{/g) || []).length > 1) {
			return fail('Nested structs and unions are not supported. Flatten the definition.');
		}

		const body = /struct\s+([A-Za-z_]\w*)?\s*\{([^{}]*)\}/.exec(text);
		if (!body) {
			return fail('Could not find a `struct { ... }` definition.');
		}

		const name = body[1] || 'struct';
		const statements = body[2].split(';').map(function (s) { return s.trim(); }).filter(Boolean);
		if (!statements.length) {
			return fail('The struct has no fields.');
		}

		const fields = [];
		let bitCursor = 0;
		let maxAlign = 1;

		for (const statement of statements) {
			const tokens = tokenize(statement);

			// Consume specifier words, then back off if that swallowed the
			// field name too - `uint16_t half;` is a field called half.
			let at = 0;
			while (at < tokens.length && TYPE_WORDS.has(tokens[at])) {
				at++;
			}
			if (at === tokens.length && at > 1) {
				at--;
			}

			const resolved = resolveType(tokens.slice(0, at));
			if (!resolved) {
				const spelled = tokens.slice(0, Math.max(at, 1)).join(' ');
				return fail(`Unknown type "${spelled}" in "${statement}".`);
			}
			const type = resolved.info;

			const declarators = splitDeclarators(tokens.slice(at));
			if (typeof declarators === 'string') {
				return fail(`${declarators} in "${statement}".`);
			}
			if (!declarators.length) {
				return fail(`Missing a field name in "${statement}".`);
			}

			for (const declarator of declarators) {
				const align = packed ? 1 : type.size;
				maxAlign = Math.max(maxAlign, align);

				if (declarator.bits !== undefined) {
					const label = declarator.name || 'the unnamed bitfield';
					if (!INTEGER_KINDS.has(type.kind)) {
						return fail(`"${label}" is a bitfield, which needs an integer type, not ${resolved.key}.`);
					}
					const unit = type.size * 8;
					if (declarator.bits > unit) {
						return fail(`Bitfield "${label}" is ${declarator.bits} bits, wider than the ${unit}-bit ${resolved.key} holding it.`);
					}
					if (declarator.bits === 0) {
						// `: 0` is not a field; it forces the next one to a
						// fresh storage unit.
						bitCursor = roundUp(bitCursor, unit);
						continue;
					}
					let start = bitCursor;
					// A bitfield never straddles a unit of its own type.
					if (!packed &&
						Math.floor(start / unit) !== Math.floor((start + declarator.bits - 1) / unit)) {
						start = roundUp(start, unit);
					}
					// An unnamed bitfield reserves its bits and shows no column.
					if (declarator.name) {
						fields.push({
							name: declarator.name,
							type: resolved.key,
							kind: type.kind,
							count: 1,
							offsetBits: start,
							widthBits: declarator.bits,
							bitfield: true,
						});
					}
					bitCursor = start + declarator.bits;
					continue;
				}

				const count = declarator.length === undefined ? 1 : declarator.length;
				if (count === 0) {
					return fail(`Zero-length array "${declarator.name}" has nothing to show.`);
				}
				const start = roundUp(roundUp(bitCursor, 8), align * 8);
				fields.push({
					name: declarator.name,
					type: resolved.key,
					kind: type.kind,
					count: count,
					offsetBits: start,
					widthBits: type.size * 8,
					bitfield: false,
				});
				bitCursor = start + type.size * 8 * count;
			}
		}

		if (!fields.length) {
			return fail('The struct has no fields.');
		}

		const size = roundUp(roundUp(bitCursor, 8) / 8, maxAlign);
		return { name: name, fields: fields, size: size, alignment: maxAlign, packed: packed };
	}

	/** `a, b[4], c : 3` -> one entry each. Returns a message string on error. */
	function splitDeclarators(tokens) {
		const groups = [[]];
		for (const token of tokens) {
			if (token === ',') {
				groups.push([]);
			} else {
				groups[groups.length - 1].push(token);
			}
		}

		const out = [];
		for (const group of groups) {
			if (!group.length) {
				continue;
			}

			// An unnamed bitfield: `uint8_t : 0;` aligns to the next storage
			// unit, `uint8_t : 3;` reserves bits nothing can read.
			if (group[0] === ':') {
				if (!/^\d+$/.test(group[1] || '')) {
					return 'An unnamed bitfield needs a width, e.g. `: 0`';
				}
				if (group.length > 2) {
					return `Unexpected "${group.slice(2).join(' ')}" after the bit width`;
				}
				out.push({ name: '', length: undefined, bits: Number(group[1]) });
				continue;
			}

			const name = group[0];
			if (!/^[A-Za-z_]\w*$/.test(name)) {
				if (name === '*') {
					return 'Pointers are not supported';
				}
				return `"${name}" is not a field name`;
			}

			const rest = group.slice(1);
			let length;
			let bits;
			if (rest[0] === '[') {
				if (rest[2] !== ']' || !/^\d+$/.test(rest[1] || '')) {
					return `"${name}" needs a fixed array length, e.g. ${name}[16]`;
				}
				length = Number(rest[1]);
				rest.splice(0, 3);
			}
			if (rest[0] === ':') {
				if (!/^\d+$/.test(rest[1] || '')) {
					return `"${name}" needs a bit width, e.g. ${name} : 4`;
				}
				bits = Number(rest[1]);
				rest.splice(0, 2);
			}
			if (rest.length) {
				return `Unexpected "${rest.join(' ')}" after "${name}"`;
			}
			out.push({ name: name, length: length, bits: bits });
		}
		return out;
	}

	/* ----------------------------- decode ------------------------------ */

	function readFloat16(view, at) {
		const raw = view.getUint16(at, true);
		const sign = raw & 0x8000 ? -1 : 1;
		const exponent = (raw >> 10) & 0x1f;
		const fraction = raw & 0x03ff;
		if (exponent === 0) {
			return sign * fraction * Math.pow(2, -24);
		}
		if (exponent === 0x1f) {
			return fraction ? NaN : sign * Infinity;
		}
		return sign * (1 + fraction / 1024) * Math.pow(2, exponent - 15);
	}

	function readBFloat16(view, at) {
		const raw = view.getUint16(at, true);
		const wide = new DataView(new ArrayBuffer(4));
		wide.setUint32(0, (raw << 16) >>> 0, true);
		return wide.getFloat32(0, true);
	}

	/**
	 * A bitfield, little-endian: gather the bytes it touches, shift the field
	 * down to bit zero, mask it, then sign-extend if the type is signed.
	 * BigInt throughout, because a 64-bit field does not fit a Number.
	 */
	function readBits(view, offsetBits, width, signed) {
		const startByte = Math.floor(offsetBits / 8);
		const shift = BigInt(offsetBits % 8);
		const span = Math.ceil((offsetBits % 8 + width) / 8);

		let acc = 0n;
		for (let i = span - 1; i >= 0; i--) {
			acc = (acc << 8n) | BigInt(view.getUint8(startByte + i));
		}
		let value = (acc >> shift) & ((1n << BigInt(width)) - 1n);
		if (signed && (value >> BigInt(width - 1)) & 1n) {
			value -= 1n << BigInt(width);
		}
		return fromBigInt(value);
	}

	/** Numbers where they are exact, decimal strings where they are not. */
	function fromBigInt(value) {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value.toString();
	}

	function readScalar(view, field, at) {
		switch (field.kind) {
			case 'bool': return view.getUint8(at) !== 0;
			case 'float': return view.getFloat32(at, true);
			case 'double': return view.getFloat64(at, true);
			case 'fp16': return readFloat16(view, at);
			case 'bf16': return readBFloat16(view, at);
			case 'int':
				switch (field.widthBits) {
					case 8: return view.getInt8(at);
					case 16: return view.getInt16(at, true);
					case 32: return view.getInt32(at, true);
					default: return fromBigInt(view.getBigInt64(at, true));
				}
			default:
				switch (field.widthBits) {
					case 8: return view.getUint8(at);
					case 16: return view.getUint16(at, true);
					case 32: return view.getUint32(at, true);
					default: return fromBigInt(view.getBigUint64(at, true));
				}
		}
	}

	function cellText(value) {
		if (typeof value === 'boolean') {
			return value ? 'true' : 'false';
		}
		if (typeof value === 'number') {
			return TensorScript.formatNumber(value);
		}
		return String(value);
	}

	/**
	 * Decode the window as an array of structs - one row per instance, one
	 * column per field, with array members expanded to `name[i]`.
	 */
	function decodeStructs(source, buffer) {
		const parsed = parseStruct(source);
		if (parsed.error) {
			return parsed;
		}
		if (buffer.byteLength < parsed.size) {
			return fail(
				`The window is ${buffer.byteLength} bytes but one ${parsed.name} is ` +
				`${parsed.size}. Raise the byte count.`);
		}

		const columns = [];
		for (const field of parsed.fields) {
			if (field.count > 1) {
				for (let i = 0; i < field.count; i++) {
					columns.push(field.name + '[' + i + ']');
				}
			} else {
				columns.push(field.name);
			}
		}

		const rows = Math.floor(buffer.byteLength / parsed.size);
		if (rows * columns.length > MAX_CELLS) {
			return fail(
				`${rows} x ${columns.length} cells is more than this view will render ` +
				`(${MAX_CELLS.toLocaleString()}). Lower the byte count.`);
		}

		const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const text = [];
		const values = [];

		for (let row = 0; row < rows; row++) {
			const base = row * parsed.size;
			const textRow = [];
			const valueRow = [];
			for (const field of parsed.fields) {
				for (let i = 0; i < field.count; i++) {
					const value = field.bitfield
						? readBits(view, base * 8 + field.offsetBits, field.widthBits,
							field.kind === 'int')
						: readScalar(view, field, base + field.offsetBits / 8 + i * (field.widthBits / 8));
					textRow.push(cellText(value));
					valueRow.push(typeof value === 'number' && isFinite(value) ? value : null);
				}
			}
			text.push(textRow);
			values.push(valueRow);
		}

		return {
			columns: columns,
			text: text,
			values: values,
			size: parsed.size,
			count: rows,
			name: parsed.name,
			packed: parsed.packed,
		};
	}

	return {
		TEMPLATE: TEMPLATE,
		TYPES: TYPES,
		parseStruct: parseStruct,
		decodeStructs: decodeStructs,
		readFloat16: readFloat16,
		readBFloat16: readBFloat16,
	};
}));
