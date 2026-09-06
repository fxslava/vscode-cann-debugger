// @ts-check
/*
 * Tensor Inspector - webview side.
 *
 * Draws only. Every decision about what the bytes mean was already made in
 * the extension host (tensorDecode.ts), which sends both the formatted text
 * for each cell and the numeric value behind it. Non-finite values arrive as
 * null, because JSON has no NaN - the text is still "NaN" or "inf", so the
 * cell reads correctly while the colour scale skips it.
 */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const el = {
		address: /** @type {HTMLInputElement} */ (document.getElementById('address')),
		dtype: /** @type {HTMLSelectElement} */ (document.getElementById('dtype')),
		shape: /** @type {HTMLInputElement} */ (document.getElementById('shape')),
		offset: /** @type {HTMLInputElement} */ (document.getElementById('offset')),
		read: /** @type {HTMLButtonElement} */ (document.getElementById('read')),
		heatmap: /** @type {HTMLInputElement} */ (document.getElementById('heatmap')),
		message: /** @type {HTMLElement} */ (document.getElementById('message')),
		stats: /** @type {HTMLElement} */ (document.getElementById('stats')),
		grid: /** @type {HTMLElement} */ (document.getElementById('grid')),
		customPanel: /** @type {HTMLElement} */ (document.getElementById('customPanel')),
		script: /** @type {HTMLTextAreaElement} */ (document.getElementById('script')),
		struct: /** @type {HTMLTextAreaElement} */ (document.getElementById('struct')),
		scriptHint: /** @type {HTMLElement} */ (document.getElementById('scriptHint')),
		structHint: /** @type {HTMLElement} */ (document.getElementById('structHint')),
		bytes: /** @type {HTMLInputElement} */ (document.getElementById('bytes')),
	};

	const SCRIPT_DTYPE = 'script';
	const STRUCT_DTYPE = 'struct';

	/** The last payload, so toggling the heat map does not re-read memory. */
	let last = null;
	/** The last raw window, so editing the script does not re-read memory. */
	let lastRaw = null;

	el.script.value = TensorScript.TEMPLATE;
	el.struct.value = TensorStruct.TEMPLATE;

	function mode() {
		return el.dtype.value;
	}

	function customMode() {
		return mode() === SCRIPT_DTYPE || mode() === STRUCT_DTYPE;
	}

	/** Show the editor and hint belonging to the selected mode, if any. */
	function syncMode() {
		const script = mode() === SCRIPT_DTYPE;
		const struct = mode() === STRUCT_DTYPE;
		el.customPanel.hidden = !customMode();
		el.script.hidden = !script;
		el.scriptHint.hidden = !script;
		el.struct.hidden = !struct;
		el.structHint.hidden = !struct;
	}

	function requestRead() {
		showMessage('');
		vscode.postMessage({
			type: 'read',
			address: el.address.value,
			dtype: el.dtype.value,
			shape: el.shape.value,
			offset: el.offset.value,
			bytes: el.bytes.value,
		});
	}

	el.read.addEventListener('click', requestRead);
	el.dtype.addEventListener('change', syncMode);
	el.heatmap.addEventListener('change', function () {
		if (last) {
			renderGrid(last);
		}
	});

	// Re-running the script is free - the bytes are already here - so an edit
	// re-renders without another trip to the target.
	[el.script, el.struct].forEach(function (editor) {
		editor.addEventListener('keydown', function (event) {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				if (lastRaw) {
					applyCustom(lastRaw);
				} else {
					requestRead();
				}
			}
		});
	});
	el.bytes.addEventListener('keydown', function (event) {
		if (event.key === 'Enter') {
			requestRead();
		}
	});

	for (const input of [el.address, el.shape, el.offset]) {
		input.addEventListener('keydown', function (event) {
			if (event.key === 'Enter') {
				requestRead();
			}
		});
	}

	window.addEventListener('message', function (event) {
		const message = event.data || {};
		switch (message.type) {
			case 'init':
				applySeed(message);
				break;
			case 'data':
				lastRaw = null;
				last = message;
				showMessage(message.note || '', 'info');
				renderStats(message);
				renderGrid(message);
				break;
			case 'raw':
				lastRaw = message;
				applyCustom(message);
				break;
			case 'error':
				showMessage(message.message || 'Read failed.');
				break;
			case 'busy':
				el.read.disabled = !!message.busy;
				el.read.textContent = message.busy ? 'Reading...' : 'Read';
				break;
			case 'stale':
				// The session changed underneath us; what is on screen is history.
				showMessage('The debug session changed - press Read to refresh.', 'info');
				break;
			default:
				break;
		}
	});

	/**
	 * Hand the raw window to the user's decoder - a snippet or a struct - and
	 * render whatever comes back.
	 *
	 * A bad decoder is an ordinary outcome here, not a crash: the message goes
	 * into the banner with the grid left as it was, so the previous good
	 * result stays on screen while it is being fixed.
	 */
	function applyCustom(raw) {
		const buffer = TensorScript.decodeBase64(raw.data);
		const struct = mode() === STRUCT_DTYPE;
		const result = struct
			? TensorStruct.decodeStructs(el.struct.value, buffer)
			: TensorScript.runScript(el.script.value, buffer, raw.shape || []);

		if (result.error) {
			showMessage(result.error);
			return;
		}
		if (!result.text.length) {
			showMessage('Nothing decoded from this window.', 'info');
			el.grid.innerHTML = '<p class="hint">Nothing to show.</p>';
			el.stats.hidden = true;
			return;
		}

		// A struct names its columns; a script only has however many cells the
		// widest row returned.
		const columns = result.columns
			? result.columns.length
			: result.text.reduce(function (widest, row) {
				return Math.max(widest, row.length);
			}, 0);

		// Flatten to the same payload shape the built-in decoders produce, so
		// there is one renderer rather than three.
		const flatText = [];
		const flatValues = [];
		for (let r = 0; r < result.text.length; r++) {
			for (let c = 0; c < columns; c++) {
				const has = c < result.text[r].length;
				flatText.push(has ? result.text[r][c] : undefined);
				flatValues.push(has ? result.values[r][c] : null);
			}
		}

		const notes = [];
		if (struct) {
			notes.push(result.count + ' x ' + result.name + ', ' + result.size + ' bytes each' +
				(result.packed ? ' (packed)' : ''));
		}
		if (raw.note) {
			notes.push(raw.note);
		}

		const payload = {
			address: raw.address,
			dtype: mode(),
			shape: raw.shape,
			rows: result.text.length,
			columns: columns,
			headers: result.columns,
			text: flatText,
			values: flatValues,
			stats: TensorScript.statsFromCells(result.values),
		};

		last = payload;
		showMessage(notes.join(' - '), 'info');
		renderStats(payload);
		renderGrid(payload);
	}

	function applySeed(seed) {
		if (seed.address) {
			el.address.value = seed.address;
		}
		if (seed.dtype) {
			el.dtype.value = seed.dtype;
		}
		if (seed.shape) {
			el.shape.value = seed.shape;
		}
		syncMode();
		// A seeded address means the user picked a specific buffer: read it
		// straight away rather than making them press the button again.
		if (seed.address) {
			requestRead();
		}
	}

	function showMessage(text, kind) {
		el.message.textContent = text || '';
		el.message.hidden = !text;
		el.message.className = 'message' + (kind === 'info' ? ' info' : '');
	}

	function renderStats(data) {
		const stats = data.stats || {};
		const parts = [
			span('address', data.address),
			span('shape', (data.shape || []).join(' x ') + ' ' + data.dtype),
			span('grid', data.rows + ' x ' + data.columns),
			span('min', format(stats.min)),
			span('max', format(stats.max)),
			span('mean', format(stats.mean)),
		];
		if (stats.nan) {
			parts.push(span('NaN', String(stats.nan), true));
		}
		if (stats.infinite) {
			parts.push(span('inf', String(stats.infinite), true));
		}
		el.stats.innerHTML = parts.join('');
		el.stats.hidden = false;
	}

	function span(label, value, warn) {
		return '<span class="' + (warn ? 'warn' : '') + '">' + escapeHtml(label) +
			' <b>' + escapeHtml(String(value)) + '</b></span>';
	}

	function format(value) {
		if (typeof value !== 'number' || !isFinite(value)) {
			return '-';
		}
		const magnitude = Math.abs(value);
		if (value === 0) {
			return '0';
		}
		return magnitude >= 1e-4 && magnitude < 1e6
			? String(Math.round(value * 10000) / 10000)
			: value.toExponential(3);
	}

	/*
	 * Built as one HTML string rather than node by node: a 256x256 tensor is
	 * 65k cells, and appending them individually is the difference between an
	 * instant redraw and a visible stall.
	 */
	function renderGrid(data) {
		const rows = data.rows | 0;
		const columns = data.columns | 0;
		if (!rows || !columns) {
			el.grid.innerHTML = '<p class="hint">Nothing to show for this shape.</p>';
			return;
		}

		const heat = el.heatmap.checked ? scale(data.stats) : null;
		const html = [];

		html.push('<table class="tensor"><thead><tr><th></th>');
		for (let c = 0; c < columns; c++) {
			// A struct labels its columns by field name; everything else by index.
			html.push('<th>' + escapeHtml(data.headers ? data.headers[c] : c) + '</th>');
		}
		html.push('</tr></thead><tbody>');

		for (let r = 0; r < rows; r++) {
			html.push('<tr><th>' + r + '</th>');
			for (let c = 0; c < columns; c++) {
				const index = r * columns + c;
				const text = data.text[index];
				if (text === undefined) {
					html.push('<td class="missing">--</td>');
					continue;
				}
				const value = data.values[index];
				if (value === null) {
					// NaN or +/-inf: worth spotting, never worth colouring.
					html.push('<td class="special">' + escapeHtml(text) + '</td>');
					continue;
				}
				const style = heat ? ' style="background:' + heat(value) + '"' : '';
				html.push('<td class="hot"' + style + '>' + escapeHtml(text) + '</td>');
			}
			html.push('</tr>');
		}
		html.push('</tbody></table>');

		el.grid.innerHTML = html.join('');
	}

	/**
	 * Map a value onto a translucent tint. Signed data gets a diverging scale
	 * around zero - negative one way, positive the other - because in a tensor
	 * the sign is usually the thing you are scanning for. Unsigned data gets a
	 * single ramp. Translucency keeps it readable in light and dark themes.
	 */
	function scale(stats) {
		if (!stats || !stats.finite) {
			return null;
		}
		const min = stats.min;
		const max = stats.max;
		if (min === max) {
			return function () { return 'transparent'; };
		}
		if (min < 0 && max > 0) {
			const extent = Math.max(Math.abs(min), Math.abs(max));
			return function (value) {
				const weight = Math.abs(value) / extent * 0.55;
				return value < 0
					? 'rgba(80, 140, 255, ' + weight.toFixed(3) + ')'
					: 'rgba(255, 120, 80, ' + weight.toFixed(3) + ')';
			};
		}
		const span = max - min;
		return function (value) {
			const weight = ((value - min) / span) * 0.55;
			return 'rgba(120, 170, 255, ' + weight.toFixed(3) + ')';
		};
	}

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	vscode.postMessage({ type: 'ready' });
}());
