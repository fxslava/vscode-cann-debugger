/*---------------------------------------------------------------------------
 * The Tensor Inspector: a structured 2-D view of NPU memory.
 *
 * The Hex Editor answers "what bytes are here". This answers the question a
 * kernel author actually has - "what values are here, laid out the way my
 * tensor is laid out" - by reading a window of memory over DAP readMemory,
 * decoding it as FP16/BF16/FP32/INT8/... and rendering it as a grid.
 *
 * The extension host does the reading and decoding; the webview only draws.
 * That split keeps every decision about what bytes mean in tensorDecode.ts,
 * where it is unit tested, and keeps the webview free of debug-adapter
 * knowledge - it never sees a session, only numbers.
 *-------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
	decodeTensor,
	DTYPES,
	dtypeInfo,
	formatValue,
	gridShape,
	guessDType,
	isTensorDType,
	MAX_ELEMENTS,
	MAX_SCRIPT_BYTES,
	parseByteCount,
	parseShape,
	isRawDType,
	SCRIPT_DTYPE,
	shapeElements,
	STRUCT_DTYPE,
	TensorDType,
	tensorStats,
} from './tensorDecode';

const DEBUG_TYPE = 'ascend-gdb';

/** What the inspector opens with, from a right-clicked variable or a prompt. */
export interface TensorSeed {
	address?: string;
	dtype?: TensorDType;
	shape?: string;
	label?: string;
}

/**
 * How the bytes are to be turned into cells: by one of the built-in decoders,
 * or by the user's own script in the webview. The two differ in who sizes the
 * window - a dtype implies a stride, a script does not - and in what crosses
 * back, decoded values or raw bytes.
 */
type TensorMode =
	| { kind: 'decode'; dtype: TensorDType }
	| { kind: 'raw'; bytes: number };

/** One fully-specified read. */
interface TensorRequest {
	address: string;
	shape: number[];
	offset: number;
	mode: TensorMode;
}

export class TensorInspectorPanel {
	public static readonly viewType = 'ascend-gdb.tensorInspector';

	/** One inspector, reused: a second panel would just fight for the column. */
	private static current: TensorInspectorPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private seed: TensorSeed;

	public static show(context: vscode.ExtensionContext, seed: TensorSeed = {}): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (TensorInspectorPanel.current) {
			TensorInspectorPanel.current.reseed(seed);
			TensorInspectorPanel.current.panel.reveal(column, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			TensorInspectorPanel.viewType,
			'Tensor Inspector',
			{ viewColumn: column, preserveFocus: true },
			{
				enableScripts: true,
				// The decoded grid is expensive to rebuild; keep it while the
				// user tabs away to look at the source.
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			},
		);

		TensorInspectorPanel.current = new TensorInspectorPanel(context, panel, seed);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		seed: TensorSeed,
	) {
		this.seed = seed;
		this.panel.webview.html = this.render(this.panel.webview);

		this.panel.webview.onDidReceiveMessage(
			(message) => this.onMessage(message), undefined, this.disposables);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

		// A new stop means new memory; nudge the view so it does not sit there
		// showing values from two breakpoints ago.
		this.disposables.push(
			vscode.debug.onDidChangeActiveDebugSession(() => this.post({ type: 'stale' })));
	}

	private reseed(seed: TensorSeed): void {
		this.seed = { ...this.seed, ...seed };
		this.post({ type: 'init', ...this.seed });
	}

	private dispose(): void {
		TensorInspectorPanel.current = undefined;
		for (const item of this.disposables) {
			item.dispose();
		}
		this.disposables.length = 0;
		this.panel.dispose();
	}

	private post(message: unknown): void {
		void this.panel.webview.postMessage(message);
	}

	/* --------------------------- messages ---------------------------- */

	private async onMessage(message: unknown): Promise<void> {
		const body = (message ?? {}) as Record<string, unknown>;
		switch (body['type']) {
			case 'ready':
				this.post({ type: 'init', ...this.seed, dtypes: DTYPES });
				return;
			case 'read':
				await this.read(body);
				return;
			default:
				return;
		}
	}

	/**
	 * Validate what the form sent, read the window, decode it, and hand the
	 * webview numbers. Every failure path reports a sentence the user can act
	 * on rather than an empty grid.
	 */
	private async read(body: Record<string, unknown>): Promise<void> {
		const request = this.parseRequest(body);
		if (typeof request === 'string') {
			this.post({ type: 'error', message: request });
			return;
		}

		const session = vscode.debug.activeDebugSession;
		if (!session || session.type !== DEBUG_TYPE) {
			this.post({ type: 'error', message: 'Start an Ascend debug session and stop at a breakpoint first.' });
			return;
		}

		const elements = shapeElements(request.shape);
		const count = request.mode.kind === 'raw'
			? request.mode.bytes
			: elements * dtypeInfo(request.mode.dtype).size;

		this.post({ type: 'busy', busy: true });
		try {
			const response = await session.customRequest('readMemory', {
				memoryReference: request.address,
				offset: request.offset,
				count,
			}) as { address?: string; data?: string; unreadableBytes?: number } | undefined;

			const bytes = Buffer.from(response?.data ?? '', 'base64');
			const address = response?.address ?? request.address;
			const unreadable = response?.unreadableBytes ?? 0;

			if (request.mode.kind === 'raw') {
				// The window goes over untouched: the script is the decoder,
				// so this side has no business deciding what the bytes mean.
				this.post({
					type: 'raw',
					address,
					shape: request.shape,
					data: bytes.toString('base64'),
					byteLength: bytes.length,
					note: bytes.length < count
						? `${(count - bytes.length).toLocaleString()} of ${count.toLocaleString()} bytes were not readable.`
						: undefined,
				});
				return;
			}

			const dtype = request.mode.dtype;
			const values = decodeTensor(bytes, dtype, elements);
			const { rows, columns } = gridShape(request.shape);

			this.post({
				type: 'data',
				address,
				dtype,
				shape: request.shape,
				rows,
				columns,
				text: values.map((value) => formatValue(value, dtype)),
				// JSON has no NaN or Infinity: they would arrive as null anyway,
				// so send null deliberately and let the colour scale skip them.
				// `text` still carries the real value for display.
				values: values.map((value) => (Number.isFinite(value) ? value : null)),
				stats: tensorStats(values),
				note: this.describeShortfall(values.length, elements, unreadable),
			});
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		} finally {
			this.post({ type: 'busy', busy: false });
		}
	}

	private parseRequest(body: Record<string, unknown>): TensorRequest | string {
		const address = String(body['address'] ?? '').trim();
		if (!address) {
			return 'Enter an address, or an expression that evaluates to one.';
		}

		const shape = parseShape(String(body['shape'] ?? ''));
		if (!shape) {
			return 'Shape must be positive whole numbers, for example 16x16 or 2x3x4.';
		}

		const elements = shapeElements(shape);
		if (elements > MAX_ELEMENTS) {
			return `${elements.toLocaleString()} elements is more than this view will render ` +
				`(${MAX_ELEMENTS.toLocaleString()}). Narrow the shape, or step through it with the offset.`;
		}

		const offsetText = String(body['offset'] ?? '0').trim() || '0';
		const offset = /^-?(0[xX][0-9a-fA-F]+|\d+)$/.test(offsetText) ? Number(offsetText) : NaN;
		if (!Number.isSafeInteger(offset)) {
			return `Offset must be a whole number of bytes: ${offsetText}`;
		}

		const dtype = body['dtype'];
		if (isRawDType(dtype)) {
			// No stride to multiply out, so the window is sized in bytes.
			const bytes = parseByteCount(String(body['bytes'] ?? ''));
			if (bytes === undefined) {
				return `Bytes must be a whole number from 1 to ${MAX_SCRIPT_BYTES.toLocaleString()}.`;
			}
			return { address, shape, offset, mode: { kind: 'raw', bytes } };
		}
		if (!isTensorDType(dtype)) {
			return `Unknown data type: ${String(dtype)}.`;
		}

		return { address, shape, offset, mode: { kind: 'decode', dtype } };
	}

	/** Say plainly when the window was only partly readable. */
	private describeShortfall(decoded: number, wanted: number, unreadable: number): string | undefined {
		if (decoded >= wanted) {
			return undefined;
		}
		const missing = wanted - decoded;
		return unreadable > 0
			? `${missing.toLocaleString()} of ${wanted.toLocaleString()} elements were not readable ` +
				`(${unreadable.toLocaleString()} bytes unmapped).`
			: `Only ${decoded.toLocaleString()} of ${wanted.toLocaleString()} elements were returned.`;
	}

	/* ----------------------------- html ------------------------------ */

	private render(webview: vscode.Webview): string {
		const asset = (name: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
		const nonce = crypto.randomBytes(16).toString('base64');

		const options = DTYPES
			.map((d) => `<option value="${d.id}">${d.label}</option>`)
			.concat(
				`<option value="${STRUCT_DTYPE}">C struct...</option>`,
				`<option value="${SCRIPT_DTYPE}">Custom script...</option>`)
			.join('\n\t\t\t');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-eval';">
<link rel="stylesheet" href="${asset('tensorInspector.css')}">
<title>Tensor Inspector</title>
</head>
<body>
	<div class="toolbar">
		<div class="field grow">
			<label for="address">Address or expression</label>
			<input type="text" id="address" spellcheck="false" autocomplete="off" placeholder="0x2000">
		</div>
		<div class="field">
			<label for="dtype">Type</label>
			<select id="dtype">
			${options}
			</select>
		</div>
		<div class="field narrow">
			<label for="shape">Shape</label>
			<input type="text" id="shape" spellcheck="false" autocomplete="off" placeholder="16x16" value="16x16">
		</div>
		<div class="field narrow">
			<label for="offset">Offset</label>
			<input type="text" id="offset" spellcheck="false" autocomplete="off" value="0">
		</div>
		<div class="field">
			<label>&nbsp;</label>
			<button id="read">Read</button>
		</div>
	</div>

	<div id="customPanel" hidden>
		<div class="toolbar">
			<div class="field narrow">
				<label for="bytes">Bytes</label>
				<input type="text" id="bytes" spellcheck="false" autocomplete="off" value="1024">
			</div>
			<p class="hint grow" id="scriptHint">
				Body of a function of <code>(buffer, shape)</code>. <code>buffer</code> is a
				<code>Uint8Array</code> of the window above; return a 2-D array of numbers or
				strings, one array per row. A flat array counts as a single row.
			</p>
			<p class="hint grow" id="structHint" hidden>
				One row per struct in the window. Little-endian, LP64, natural alignment -
				add <code>__attribute__((packed))</code> for none. Bitfields, fixed arrays
				and <code>__fp16</code>/<code>__bf16</code> are understood.
			</p>
		</div>
		<textarea id="script" spellcheck="false" rows="14"></textarea>
		<textarea id="struct" spellcheck="false" rows="10" hidden></textarea>
	</div>

	<div class="field checkbox">
		<input type="checkbox" id="heatmap" checked>
		<label for="heatmap">Colour by magnitude</label>
	</div>

	<div id="message" class="message" hidden></div>
	<div id="stats" class="stats" hidden></div>
	<div id="grid" class="grid-host">
		<p class="hint">Stop at a breakpoint, point this at a buffer, and press Read.</p>
	</div>

	<script nonce="${nonce}" src="${asset('tensorScript.js')}"></script>
	<script nonce="${nonce}" src="${asset('tensorStruct.js')}"></script>
	<script nonce="${nonce}" src="${asset('tensorInspector.js')}"></script>
</body>
</html>`;
	}
}

/**
 * Pull what we can out of whatever the Variables view handed the command.
 *
 * VS Code passes `{ container, variable, sessionId }` for a context-menu
 * click, but the shape has changed across versions and the command is also
 * reachable from the palette with no argument at all, so nothing here is
 * assumed - a miss just means the form opens empty.
 */
export function seedFromContext(arg: unknown): TensorSeed {
	const container = (arg ?? {}) as Record<string, unknown>;
	const variable = (container['variable'] ?? container) as Record<string, unknown>;

	const address = typeof variable['memoryReference'] === 'string'
		? variable['memoryReference']
		: typeof variable['evaluateName'] === 'string'
			? variable['evaluateName']
			: undefined;

	const type = typeof variable['type'] === 'string' ? variable['type'] : undefined;
	const name = typeof variable['name'] === 'string' ? variable['name'] : undefined;

	return {
		address,
		dtype: guessDType(type),
		label: name,
	};
}
