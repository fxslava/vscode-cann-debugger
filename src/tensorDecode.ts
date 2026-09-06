/*---------------------------------------------------------------------------
 * Tensor decoding: raw bytes -> numbers a human can read.
 *
 * Everything here is pure. The Tensor Inspector fetches bytes over DAP
 * readMemory and renders them in a webview; this module is the part in the
 * middle that says what those bytes mean, and it is unit tested on its own.
 *
 * Two of the formats matter more than the rest on an NPU and neither is a
 * native JavaScript type:
 *
 *   float16   IEEE 754 binary16 - the Ascend cube unit's native input format
 *   bfloat16  the top 16 bits of a float32: same exponent range, 8 fewer
 *             mantissa bits, which is why it is used for training
 *
 * Both are decoded by hand below rather than through a TypedArray, because
 * Float16Array is not available on the Node versions this extension targets.
 *-------------------------------------------------------------------------*/

export type TensorDType =
	| 'float32' | 'float64' | 'float16' | 'bfloat16'
	| 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32';

export interface DTypeInfo {
	id: TensorDType;
	/** What the picker shows. */
	label: string;
	/** Bytes per element. */
	size: number;
	float: boolean;
}

/**
 * Offered in the inspector, NPU-relevant formats first.
 *
 * 64-bit integers are deliberately absent: they do not survive a round trip
 * through a JavaScript number, and a viewer that silently rounds values is
 * worse than one that does not offer the type at all.
 */
export const DTYPES: readonly DTypeInfo[] = [
	{ id: 'float16', label: 'FP16 (half)', size: 2, float: true },
	{ id: 'bfloat16', label: 'BF16 (bfloat16)', size: 2, float: true },
	{ id: 'float32', label: 'FP32 (float)', size: 4, float: true },
	{ id: 'float64', label: 'FP64 (double)', size: 8, float: true },
	{ id: 'int8', label: 'INT8', size: 1, float: false },
	{ id: 'uint8', label: 'UINT8', size: 1, float: false },
	{ id: 'int16', label: 'INT16', size: 2, float: false },
	{ id: 'uint16', label: 'UINT16', size: 2, float: false },
	{ id: 'int32', label: 'INT32', size: 4, float: false },
	{ id: 'uint32', label: 'UINT32', size: 4, float: false },
];

/** A tensor bigger than this is a memory dump, not something to read in a grid. */
export const MAX_ELEMENTS = 65536;

/**
 * The pseudo-type that means "the user's own decoder". There is no stride to
 * derive a byte count from, so a script window is sized in bytes directly.
 */
export const SCRIPT_DTYPE = 'script';

/** Ceiling on a script window: it crosses to the webview as base64. */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Parse a byte count as typed - decimal or `0x` hex. Returns undefined for
 * anything that is not a usable window, so the caller can say which.
 */
export function parseByteCount(text: string): number | undefined {
	const trimmed = (text || '').trim();
	if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) {
		return undefined;
	}
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SCRIPT_BYTES) {
		return undefined;
	}
	return value;
}

export function dtypeInfo(dtype: TensorDType): DTypeInfo {
	const found = DTYPES.find((d) => d.id === dtype);
	if (!found) {
		throw new Error(`Unknown tensor data type: ${dtype}`);
	}
	return found;
}

export function isTensorDType(value: unknown): value is TensorDType {
	return typeof value === 'string' && DTYPES.some((d) => d.id === value);
}

/* -------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------- */

/**
 * Parse a shape written the way people write shapes: `16x16`, `16*16`,
 * `16,16`, `2x3x4`, or a bare `256` for one row.
 *
 * Returns undefined rather than a guess when the text is not a shape, so the
 * caller can say so instead of silently inspecting the wrong window.
 */
export function parseShape(text: string): number[] | undefined {
	const trimmed = (text || '').trim();
	// Every separator must have a dimension on both sides. Without this, a
	// half-typed "16x" parses as [16] and quietly reads the wrong window.
	if (!/^\d+(?:\s*[x*,\s]\s*\d+)*$/i.test(trimmed)) {
		return undefined;
	}

	const parts = trimmed.split(/\s*[x*,\s]\s*/i).filter((p) => p.length > 0);
	if (!parts.length) {
		return undefined;
	}
	const dims: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) {
			return undefined;
		}
		const value = Number(part);
		// A zero-length dimension has nothing to show and would make the
		// element count collapse to zero for the whole tensor.
		if (!Number.isSafeInteger(value) || value <= 0) {
			return undefined;
		}
		dims.push(value);
	}
	return dims;
}

export function shapeElements(shape: readonly number[]): number {
	return shape.reduce((total, dim) => total * dim, 1);
}

/**
 * Flatten a shape to the rows and columns of a 2-D grid. The last dimension
 * is the row width - that is the contiguous one in a row-major tensor - and
 * everything above it stacks into rows, so a 2x3x4 shows as 6 rows of 4.
 */
export function gridShape(shape: readonly number[]): { rows: number; columns: number } {
	if (!shape.length) {
		return { rows: 0, columns: 0 };
	}
	const columns = shape[shape.length - 1];
	return { rows: shapeElements(shape.slice(0, -1)), columns };
}

/* -------------------------------------------------------------------------
 * Element decoding
 * ---------------------------------------------------------------------- */

/** IEEE 754 binary16, little-endian. */
export function readFloat16(bytes: Buffer, offset: number): number {
	const raw = bytes.readUInt16LE(offset);
	const sign = raw & 0x8000 ? -1 : 1;
	const exponent = (raw >> 10) & 0x1f;
	const fraction = raw & 0x03ff;

	if (exponent === 0) {
		// Subnormal, and zero: no implicit leading one.
		return sign * fraction * 2 ** -24;
	}
	if (exponent === 0x1f) {
		return fraction ? NaN : sign * Infinity;
	}
	return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** bfloat16 is a float32 with the low 16 mantissa bits chopped off. */
export function readBFloat16(bytes: Buffer, offset: number): number {
	const raw = bytes.readUInt16LE(offset);
	const wide = Buffer.allocUnsafe(4);
	// >>> 0 because a raw with the sign bit set shifts into a negative int32.
	wide.writeUInt32LE((raw << 16) >>> 0, 0);
	return wide.readFloatLE(0);
}

/**
 * Decode up to `count` elements. A short buffer yields a short result rather
 * than an error: a partially readable NPU window should show the part that
 * was readable, the way the Hex Editor does.
 */
export function decodeTensor(bytes: Buffer, dtype: TensorDType, count: number): number[] {
	const { size } = dtypeInfo(dtype);
	const available = Math.min(count, Math.floor(bytes.length / size));
	const out: number[] = new Array(available);

	for (let i = 0; i < available; i++) {
		const at = i * size;
		switch (dtype) {
			case 'float16': out[i] = readFloat16(bytes, at); break;
			case 'bfloat16': out[i] = readBFloat16(bytes, at); break;
			case 'float32': out[i] = bytes.readFloatLE(at); break;
			case 'float64': out[i] = bytes.readDoubleLE(at); break;
			case 'int8': out[i] = bytes.readInt8(at); break;
			case 'uint8': out[i] = bytes.readUInt8(at); break;
			case 'int16': out[i] = bytes.readInt16LE(at); break;
			case 'uint16': out[i] = bytes.readUInt16LE(at); break;
			case 'int32': out[i] = bytes.readInt32LE(at); break;
			case 'uint32': out[i] = bytes.readUInt32LE(at); break;
		}
	}
	return out;
}

/* -------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------- */

/** Cell text: short enough for a grid, honest about specials. */
export function formatValue(value: number, dtype: TensorDType): string {
	if (Number.isNaN(value)) {
		return 'NaN';
	}
	if (!Number.isFinite(value)) {
		return value > 0 ? 'inf' : '-inf';
	}
	if (!dtypeInfo(dtype).float) {
		return String(value);
	}
	if (value === 0) {
		// Negative zero included: -0 in a tensor is noise, not information.
		return '0';
	}
	const magnitude = Math.abs(value);
	if (magnitude >= 1e-4 && magnitude < 1e6) {
		return trimTrailingZeros(value.toFixed(4));
	}
	return value.toExponential(3);
}

function trimTrailingZeros(text: string): string {
	return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

export interface TensorStats {
	min: number;
	max: number;
	mean: number;
	/** Counted separately: they would poison min/max and the colour scale. */
	nan: number;
	infinite: number;
	finite: number;
}

/**
 * Summary over the finite values, which is what the heat-map scale needs.
 * A tensor that is entirely NaN reports zeroed bounds and a nan count - that
 * combination is itself the diagnosis when a kernel has gone wrong.
 */
export function tensorStats(values: readonly number[]): TensorStats {
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	let nan = 0;
	let infinite = 0;
	let finite = 0;

	for (const value of values) {
		if (Number.isNaN(value)) {
			nan++;
		} else if (!Number.isFinite(value)) {
			infinite++;
		} else {
			finite++;
			sum += value;
			if (value < min) {
				min = value;
			}
			if (value > max) {
				max = value;
			}
		}
	}

	return {
		min: finite ? min : 0,
		max: finite ? max : 0,
		mean: finite ? sum / finite : 0,
		nan,
		infinite,
		finite,
	};
}

/* -------------------------------------------------------------------------
 * Guessing, so the dialog opens with something sensible in it
 * ---------------------------------------------------------------------- */

/**
 * Best guess at the element type from the C type of the variable the user
 * right-clicked. `half` is Ascend C's own spelling of float16, which is the
 * case worth getting right - it is what most kernel buffers are declared as.
 */
export function guessDType(type: string | undefined): TensorDType | undefined {
	if (!type) {
		return undefined;
	}
	// Strip qualifiers, address-space markers and pointer/array decoration.
	const bare = type
		.replace(/\b(const|volatile|__gm__|__ubuf__|__cbuf__|__ca__|__cb__|__cc__)\b/g, '')
		.replace(/[*&]|\[\s*\d*\s*\]/g, '')
		.trim()
		.toLowerCase();

	switch (bare) {
		case 'half': case '__fp16': case 'float16_t': case 'fp16':
			return 'float16';
		case 'bfloat16_t': case '__bf16': case 'bf16':
			return 'bfloat16';
		case 'float': case 'float32_t':
			return 'float32';
		case 'double':
			return 'float64';
		case 'int8_t': case 'signed char': case 'char':
			return 'int8';
		case 'uint8_t': case 'unsigned char':
			return 'uint8';
		case 'int16_t': case 'short': case 'short int':
			return 'int16';
		case 'uint16_t': case 'unsigned short': case 'short unsigned int':
			return 'uint16';
		case 'int32_t': case 'int':
			return 'int32';
		case 'uint32_t': case 'unsigned int': case 'unsigned':
			return 'uint32';
		default:
			return undefined;
	}
}
