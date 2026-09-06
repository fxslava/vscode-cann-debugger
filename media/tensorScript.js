// @ts-check
/*
 * Custom memory parsers for the Tensor Inspector.
 *
 * FP16 and BF16 cover what a kernel holds in a plain tensor, but not how an
 * NPU actually lays one out - Fractal-Z tiling, a custom quantisation with a
 * per-block scale, an interleaved layout someone invented last week. Rather
 * than grow a dropdown entry per layout, the user writes the decoder.
 *
 * The snippet is the body of a function of (buffer, shape) that returns a 2-D
 * array of numbers or strings. It runs in the webview, which is a sandboxed
 * iframe with no filesystem and no network - the same trust level as the
 * setupCommands already in their launch.json, which GDB executes verbatim.
 *
 * Loaded both as a webview <script> (defines window.TensorScript) and as a
 * CommonJS module, so the parts that matter can be unit tested in Node.
 */
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.TensorScript = factory();
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	/** Same ceiling as the built-in decoders: past this it is a memory dump. */
	const MAX_CELLS = 65536;

	/** What a fresh Custom Script starts as: row-major FP32, ready to edit. */
	const TEMPLATE = [
		'// buffer: Uint8Array of the window you asked for.',
		'// shape:  the dimensions you typed, e.g. [16, 16].',
		'// Return a 2-D array of numbers or strings - one array per row.',
		'',
		'const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);',
		'const cols = shape[shape.length - 1];',
		'const rows = buffer.byteLength / 4 / cols;',
		'',
		'const out = [];',
		'for (let r = 0; r < rows; r++) {',
		'  const row = [];',
		'  for (let c = 0; c < cols; c++) {',
		'    const at = (r * cols + c) * 4;',
		'    row.push(at + 4 <= buffer.byteLength ? view.getFloat32(at, true) : "--");',
		'  }',
		'  out.push(row);',
		'}',
		'return out;',
	].join('\n');

	function describe(err) {
		if (err instanceof Error) {
			return err.name === 'Error' ? err.message : err.name + ': ' + err.message;
		}
		return String(err);
	}

	/**
	 * Compile and run one snippet.
	 *
	 * Returns `{ error }` for anything that went wrong - a syntax error, a
	 * throw, a return value that is not a grid - so the caller can put the
	 * message in front of the user instead of failing silently. It never
	 * throws on its own.
	 */
	function runScript(code, buffer, shape) {
		let fn;
		try {
			// Requires 'unsafe-eval' in the webview's CSP; see the panel's
			// render(), where that is granted deliberately and only there.
			fn = new Function('buffer', 'shape', String(code));
		} catch (err) {
			return { error: 'Script did not compile - ' + describe(err) };
		}

		let returned;
		try {
			returned = fn(buffer, shape);
		} catch (err) {
			return { error: 'Script threw - ' + describe(err) };
		}

		return normalizeCells(returned);
	}

	/**
	 * Check and flatten what the script returned.
	 *
	 * A flat array is accepted as a single row, because that is the obvious
	 * intent for a 1-D shape. Anything else that is not a grid is an error
	 * naming what arrived, since a silent reshape would hide the bug.
	 */
	function normalizeCells(returned) {
		if (returned === undefined) {
			return { error: 'Script returned nothing. It needs a `return` of a 2-D array.' };
		}
		if (!Array.isArray(returned)) {
			return { error: 'Script must return an array of rows, but returned ' + typeName(returned) + '.' };
		}
		if (!returned.length) {
			return { text: [], values: [] };
		}

		// A flat array is one row.
		const rows = Array.isArray(returned[0]) ? returned : [returned];

		let cells = 0;
		const text = [];
		const values = [];
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			if (!Array.isArray(row)) {
				return {
					error: 'Row ' + r + ' is ' + typeName(row) + ', not an array. ' +
						'Every row must be an array of cells.',
				};
			}
			cells += row.length;
			if (cells > MAX_CELLS) {
				return {
					error: 'Script produced more than ' + MAX_CELLS.toLocaleString() +
						' cells. Narrow the shape, or return a summary instead.',
				};
			}
			const textRow = [];
			const valueRow = [];
			for (let c = 0; c < row.length; c++) {
				const cell = row[c];
				if (typeof cell === 'number') {
					textRow.push(formatNumber(cell));
					valueRow.push(isFinite(cell) ? cell : null);
				} else if (cell === null || cell === undefined) {
					textRow.push('--');
					valueRow.push(null);
				} else {
					textRow.push(String(cell));
					valueRow.push(null);
				}
			}
			text.push(textRow);
			values.push(valueRow);
		}
		return { text: text, values: values };
	}

	function typeName(value) {
		if (value === null) {
			return 'null';
		}
		return Array.isArray(value) ? 'an array' : 'a ' + typeof value;
	}

	/** Mirrors formatValue() in tensorDecode.ts, for cells the script produced. */
	function formatNumber(value) {
		if (Number.isNaN(value)) {
			return 'NaN';
		}
		if (!isFinite(value)) {
			return value > 0 ? 'inf' : '-inf';
		}
		if (value === 0) {
			return '0';
		}
		if (Number.isInteger(value) && Math.abs(value) < 1e6) {
			return String(value);
		}
		const magnitude = Math.abs(value);
		if (magnitude >= 1e-4 && magnitude < 1e6) {
			return String(Number(value.toFixed(4)));
		}
		return value.toExponential(3);
	}

	/** Heat-map bounds over the numeric cells; mirrors tensorStats(). */
	function statsFromCells(values) {
		let min = Infinity;
		let max = -Infinity;
		let sum = 0;
		let finite = 0;
		for (let r = 0; r < values.length; r++) {
			for (let c = 0; c < values[r].length; c++) {
				const value = values[r][c];
				if (typeof value === 'number' && isFinite(value)) {
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
		}
		return {
			min: finite ? min : 0,
			max: finite ? max : 0,
			mean: finite ? sum / finite : 0,
			finite: finite,
			nan: 0,
			infinite: 0,
		};
	}

	/** base64 -> bytes, for the raw window the extension host sends. */
	function decodeBase64(text) {
		const binary = atob(text || '');
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	return {
		MAX_CELLS: MAX_CELLS,
		TEMPLATE: TEMPLATE,
		runScript: runScript,
		normalizeCells: normalizeCells,
		statsFromCells: statsFromCells,
		formatNumber: formatNumber,
		decodeBase64: decodeBase64,
	};
}));
