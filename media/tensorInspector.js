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
	};

	/** The last payload, so toggling the heat map does not re-read memory. */
	let last = null;

	function requestRead() {
		showMessage('');
		vscode.postMessage({
			type: 'read',
			address: el.address.value,
			dtype: el.dtype.value,
			shape: el.shape.value,
			offset: el.offset.value,
		});
	}

	el.read.addEventListener('click', requestRead);
	el.heatmap.addEventListener('change', function () {
		if (last) {
			renderGrid(last);
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
				last = message;
				showMessage(message.note || '', 'info');
				renderStats(message);
				renderGrid(message);
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
			html.push('<th>' + c + '</th>');
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
