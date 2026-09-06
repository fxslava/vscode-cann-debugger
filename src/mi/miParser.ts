/*---------------------------------------------------------------------------
 * GDB/MI output parser.
 *
 * Implements the grammar from the GDB manual, "GDB/MI Output Syntax":
 *
 *   output          -> ( out-of-band-record )* [ result-record ] "(gdb)" nl
 *   result-record   -> [token] "^" result-class ( "," result )*
 *   async-record    -> [token] ( "*" | "+" | "=" ) async-class ( "," result )*
 *   stream-record   -> ( "~" | "@" | "&" ) c-string
 *   result          -> variable "=" value
 *   value           -> const | tuple | list
 *   tuple           -> "{}" | "{" result ( "," result )* "}"
 *   list            -> "[]" | "[" value ( "," value )* "]"
 *                          | "[" result ( "," result )* "]"
 *
 * Deliberate deviations from a literal reading of the grammar, all of which
 * are needed against real GDB output:
 *  - Repeated keys in one tuple (e.g. several `bkpt=` in one -break-insert
 *    reply, or `frame=` repeated) are collected into an array instead of the
 *    later value clobbering the earlier one.
 *  - A "list of results" is returned as an array of single-key objects, so
 *    `-stack-list-frames` yields [{frame:{...}}, {frame:{...}}].
 *-------------------------------------------------------------------------*/

export type MiValue = string | MiTuple | MiValue[];

export interface MiTuple {
	[key: string]: MiValue;
}

export const enum MiRecordType {
	Result = 'result',
	ExecAsync = 'exec',
	StatusAsync = 'status',
	NotifyAsync = 'notify',
	ConsoleStream = 'console',
	TargetStream = 'target',
	LogStream = 'log',
	Prompt = 'prompt',
	Unknown = 'unknown',
}

export interface MiRecord {
	type: MiRecordType;
	/** Token echoed back from the command that produced this record, if any. */
	token?: number;
	/** `done`, `running`, `error`, `exit`, `connected` - or the async class. */
	class?: string;
	/** Payload of a result/async record. */
	results: MiTuple;
	/** Text of a stream record, already unescaped. */
	text?: string;
	/** The original line, kept for logging and for unparseable input. */
	raw: string;
}

const EMPTY: MiTuple = Object.freeze({}) as MiTuple;

/**
 * Parse a single line of GDB/MI output.
 * Never throws: anything that does not parse comes back as
 * `{ type: Unknown }` so the caller can forward it as inferior output.
 */
export function parseMiLine(line: string): MiRecord {
	const raw = line;
	const text = line.replace(/\r$/, '');

	if (text === '(gdb)' || text === '(gdb) ') {
		return { type: MiRecordType.Prompt, results: EMPTY, raw };
	}

	let i = 0;
	let token: number | undefined;
	while (i < text.length && text[i] >= '0' && text[i] <= '9') {
		i++;
	}
	if (i > 0) {
		token = Number(text.slice(0, i));
	}

	const marker = text[i];
	let type: MiRecordType;
	switch (marker) {
		case '^': type = MiRecordType.Result; break;
		case '*': type = MiRecordType.ExecAsync; break;
		case '+': type = MiRecordType.StatusAsync; break;
		case '=': type = MiRecordType.NotifyAsync; break;
		case '~': type = MiRecordType.ConsoleStream; break;
		case '@': type = MiRecordType.TargetStream; break;
		case '&': type = MiRecordType.LogStream; break;
		default:
			return { type: MiRecordType.Unknown, results: EMPTY, raw };
	}
	i++;

	if (type === MiRecordType.ConsoleStream || type === MiRecordType.TargetStream || type === MiRecordType.LogStream) {
		const p = new Parser(text, i);
		let streamText: string;
		try {
			streamText = p.parseCString();
		} catch {
			streamText = text.slice(i);
		}
		return { type, results: EMPTY, text: streamText, raw };
	}

	// result-class / async-class: bare word up to a comma or end of line.
	let end = i;
	while (end < text.length && text[end] !== ',') {
		end++;
	}
	const cls = text.slice(i, end).trim();

	let results: MiTuple = EMPTY;
	if (end < text.length) {
		const p = new Parser(text, end + 1);
		try {
			results = p.parseResultList();
		} catch {
			results = EMPTY;
		}
	}

	return { type, token, class: cls, results, raw };
}

class Parser {
	constructor(private readonly s: string, private pos: number) {}

	private peek(): string {
		return this.s[this.pos];
	}

	private expect(ch: string): void {
		if (this.s[this.pos] !== ch) {
			throw new Error(`MI parse: expected '${ch}' at ${this.pos} in ${JSON.stringify(this.s)}`);
		}
		this.pos++;
	}

	private atEnd(): boolean {
		return this.pos >= this.s.length;
	}

	/** `result ("," result)*` terminated by end of input. */
	public parseResultList(): MiTuple {
		const out: MiTuple = {};
		while (!this.atEnd()) {
			const { key, value } = this.parseResult();
			addResult(out, key, value);
			if (this.atEnd() || this.peek() !== ',') {
				break;
			}
			this.pos++;
		}
		return out;
	}

	private parseResult(): { key: string; value: MiValue } {
		const key = this.parseVariable();
		this.expect('=');
		return { key, value: this.parseValue() };
	}

	private parseVariable(): string {
		const start = this.pos;
		while (!this.atEnd() && this.peek() !== '=') {
			this.pos++;
		}
		return this.s.slice(start, this.pos);
	}

	private parseValue(): MiValue {
		const ch = this.peek();
		if (ch === '"') {
			return this.parseCString();
		}
		if (ch === '{') {
			return this.parseTuple();
		}
		if (ch === '[') {
			return this.parseList();
		}
		throw new Error(`MI parse: unexpected '${ch}' at ${this.pos}`);
	}

	private parseTuple(): MiTuple {
		this.expect('{');
		const out: MiTuple = {};
		if (this.peek() === '}') {
			this.pos++;
			return out;
		}
		for (;;) {
			const { key, value } = this.parseResult();
			addResult(out, key, value);
			if (this.peek() === ',') {
				this.pos++;
				continue;
			}
			break;
		}
		this.expect('}');
		return out;
	}

	private parseList(): MiValue[] {
		this.expect('[');
		const out: MiValue[] = [];
		if (this.peek() === ']') {
			this.pos++;
			return out;
		}
		for (;;) {
			// Distinguish `value` from `variable=value` by scanning ahead for an
			// '=' that precedes any structural character.
			if (this.isResultAhead()) {
				const { key, value } = this.parseResult();
				out.push({ [key]: value } as MiTuple);
			} else {
				out.push(this.parseValue());
			}
			if (this.peek() === ',') {
				this.pos++;
				continue;
			}
			break;
		}
		this.expect(']');
		return out;
	}

	private isResultAhead(): boolean {
		const ch = this.peek();
		if (ch === '"' || ch === '{' || ch === '[') {
			return false;
		}
		for (let j = this.pos; j < this.s.length; j++) {
			const c = this.s[j];
			if (c === '=') {
				return true;
			}
			if (c === ',' || c === ']' || c === '}' || c === '"' || c === '{' || c === '[') {
				return false;
			}
		}
		return false;
	}

	/** Parse a C string literal, resolving escapes. Leaves pos after the quote. */
	public parseCString(): string {
		this.expect('"');
		let out = '';
		while (!this.atEnd()) {
			const ch = this.s[this.pos++];
			if (ch === '"') {
				return out;
			}
			if (ch !== '\\') {
				out += ch;
				continue;
			}
			const esc = this.s[this.pos++];
			switch (esc) {
				case 'n': out += '\n'; break;
				case 't': out += '\t'; break;
				case 'r': out += '\r'; break;
				case 'a': out += '\x07'; break;
				case 'b': out += '\b'; break;
				case 'f': out += '\f'; break;
				case 'v': out += '\v'; break;
				case 'e': out += '\x1b'; break;
				case '\\': out += '\\'; break;
				case '"': out += '"'; break;
				case "'": out += "'"; break;
				case 'x': {
					let hex = '';
					while (hex.length < 2 && /[0-9a-fA-F]/.test(this.s[this.pos] ?? '')) {
						hex += this.s[this.pos++];
					}
					out += hex ? String.fromCharCode(parseInt(hex, 16)) : 'x';
					break;
				}
				default:
					if (esc >= '0' && esc <= '7') {
						let oct = esc;
						while (oct.length < 3 && /[0-7]/.test(this.s[this.pos] ?? '')) {
							oct += this.s[this.pos++];
						}
						out += String.fromCharCode(parseInt(oct, 8));
					} else {
						out += esc ?? '';
					}
					break;
			}
		}
		// Unterminated string: GDB truncated the line. Return what we have.
		return out;
	}
}

function addResult(target: MiTuple, key: string, value: MiValue): void {
	if (!(key in target)) {
		target[key] = value;
		return;
	}
	const existing = target[key];
	if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		target[key] = [existing, value];
	}
}

/* -------------------------------------------------------------------------
 * Small typed accessors. MI values are all strings or containers, and every
 * call site would otherwise repeat the same casting dance.
 * ---------------------------------------------------------------------- */

export function miString(v: MiValue | undefined, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

export function miTuple(v: MiValue | undefined): MiTuple | undefined {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as MiTuple) : undefined;
}

/** Coerce to an array: a lone tuple becomes a one-element array. */
export function miArray(v: MiValue | undefined): MiValue[] {
	if (v === undefined) {
		return [];
	}
	return Array.isArray(v) ? v : [v];
}

/**
 * Flatten a "list of results" such as `[frame={...},frame={...}]` or a plain
 * list of tuples into the tuples themselves, keeping only entries under `key`
 * when the list is keyed.
 */
export function miList(v: MiValue | undefined, key: string): MiTuple[] {
	const out: MiTuple[] = [];
	for (const item of miArray(v)) {
		const t = miTuple(item);
		if (!t) {
			continue;
		}
		const keyed = t[key];
		if (keyed !== undefined) {
			for (const inner of miArray(keyed)) {
				const it = miTuple(inner);
				if (it) {
					out.push(it);
				}
			}
		} else {
			out.push(t);
		}
	}
	return out;
}

export function miNumber(v: MiValue | undefined, fallback = 0): number {
	const s = miString(v);
	if (!s) {
		return fallback;
	}
	const n = s.startsWith('0x') || s.startsWith('0X') ? parseInt(s, 16) : Number(s);
	return Number.isFinite(n) ? n : fallback;
}
