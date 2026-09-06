/*---------------------------------------------------------------------------
 * GDB variable objects ("varobjs") - the mechanism behind the Variables view.
 *
 * Reading locals with `-stack-list-variables --all-values` would be one round
 * trip, but it returns flat, pre-rendered strings: no children, no type
 * information, no path expression, and therefore no way to compute an address
 * for the memory viewer. Varobjs cost one `-var-create` per visible variable
 * and give all of that back, plus range-limited child listing, which is what
 * keeps a 1M-element tensor from being serialised into the sidebar.
 *
 * Lifetime: varobjs are anchored to a frame, so every one created while the
 * target is stopped is deleted before the target resumes. `releaseAll` is the
 * only cleanup path; leaking them makes GDB slower on every subsequent stop.
 *-------------------------------------------------------------------------*/

import { MiConnection, quoteMiString } from './mi/miConnection';
import { miNumber, miString, miTuple, miArray, MiTuple } from './mi/miParser';

export interface VarObject {
	/** GDB-assigned handle, e.g. "var12". */
	name: string;
	/** Display name: the member/element name for children, the expression for roots. */
	expression: string;
	value: string;
	type: string;
	numchild: number;
	/** Pretty-printers report `has_more` instead of a child count. */
	hasMore: boolean;
	/** True when a Python pretty-printer is supplying the value. */
	dynamic: boolean;
	threadId?: number;
	frameLevel?: number;
}

export interface TypeShape {
	isPointer: boolean;
	isArray: boolean;
	isAggregate: boolean;
	/** Element count parsed out of the innermost `[N]`, when present. */
	arrayLength?: number;
}

export class VarObjectManager {
	private readonly live = new Set<string>();

	constructor(private readonly mi: MiConnection) {}

	public async create(expression: string, threadId: number, frameLevel: number): Promise<VarObject> {
		const record = await this.mi.sendCommand(
			`-var-create --thread ${threadId} --frame ${frameLevel} - * ${quoteMiString(expression)}`);
		const r = record.results;
		const name = miString(r['name']);
		if (name) {
			this.live.add(name);
		}
		return {
			name,
			expression,
			value: miString(r['value']),
			type: miString(r['type']),
			numchild: miNumber(r['numchild']),
			hasMore: miString(r['has_more']) === '1',
			dynamic: miString(r['dynamic']) === '1',
			threadId,
			frameLevel,
		};
	}

	/**
	 * List children, optionally a slice. `-var-list-children NAME FROM TO` uses
	 * a half-open range, matching DAP's start/count.
	 */
	public async children(name: string, start?: number, count?: number): Promise<VarObject[]> {
		let command = `-var-list-children --all-values ${quoteMiString(name)}`;
		if (start !== undefined && count !== undefined && count > 0) {
			command += ` ${start} ${start + count}`;
		}
		const record = await this.mi.sendCommand(command);
		const out: VarObject[] = [];
		for (const entry of miArray(record.results['children'])) {
			const wrapper = miTuple(entry);
			if (!wrapper) {
				continue;
			}
			// Entries arrive as `child={...}`; a bare tuple is tolerated too.
			const candidates = wrapper['child'] !== undefined ? miArray(wrapper['child']) : [wrapper];
			for (const c of candidates) {
				const child = miTuple(c);
				if (!child) {
					continue;
				}
				out.push(this.toVarObject(child));
			}
		}
		return out;
	}

	private toVarObject(t: MiTuple): VarObject {
		const name = miString(t['name']);
		if (name) {
			this.live.add(name);
		}
		return {
			name,
			expression: miString(t['exp'], name),
			value: miString(t['value']),
			type: miString(t['type']),
			numchild: miNumber(t['numchild']),
			hasMore: miString(t['has_more']) === '1',
			dynamic: miString(t['dynamic']) === '1',
			threadId: miNumber(t['thread-id']) || undefined,
		};
	}

	/**
	 * Full expression for a varobj, e.g. `tiling->coreNum` for a nested child.
	 * Needed both for Copy Value / watch expressions and to take an address.
	 */
	public async pathExpression(name: string): Promise<string> {
		try {
			const record = await this.mi.sendCommand(`-var-info-path-expression ${quoteMiString(name)}`);
			return miString(record.results['path_expr']);
		} catch {
			// Pretty-printer children and registers have no path expression.
			return '';
		}
	}

	public async assign(name: string, value: string): Promise<string> {
		const record = await this.mi.sendCommand(
			`-var-assign ${quoteMiString(name)} ${quoteMiString(value)}`);
		return miString(record.results['value']);
	}

	public async setFormat(name: string, format: 'natural' | 'hexadecimal' | 'decimal' | 'binary' | 'octal'): Promise<void> {
		await this.mi.sendCommandIgnoringErrors(`-var-set-format ${quoteMiString(name)} ${format}`);
	}

	/** Delete every varobj created since the last release. Never throws. */
	public async releaseAll(): Promise<void> {
		if (!this.live.size || !this.mi.isRunning) {
			this.live.clear();
			return;
		}
		const names = [...this.live];
		this.live.clear();
		// Deleting a root deletes its children, and children may already be gone;
		// errors here are expected and uninteresting.
		await Promise.all(names.map((n) =>
			this.mi.sendCommandIgnoringErrors(`-var-delete ${quoteMiString(n)}`)));
	}
}

/** Classify a GDB type string well enough to decide how to take its address. */
export function classifyType(type: string): TypeShape {
	const t = (type || '').trim();
	// Strip a trailing function-pointer/reference decoration for the tests below.
	const isArray = /\[\s*\d*\s*\]\s*$/.test(t);
	const isPointer = !isArray && /\*\s*(const|volatile)?\s*$/.test(t);
	const isAggregate = !isPointer && !isArray &&
		(/^(const\s+|volatile\s+)*(struct|class|union)\b/.test(t) || /\b(__gm__|__ubuf__|__cbuf__)\b/.test(t));

	let arrayLength: number | undefined;
	if (isArray) {
		const m = /\[\s*(\d+)\s*\]\s*$/.exec(t);
		if (m) {
			arrayLength = Number(m[1]);
		}
	}
	return { isPointer, isArray, isAggregate, arrayLength };
}

/**
 * Resolve the address to show in the memory viewer for `expression`.
 *
 * Pointers and arrays resolve to what they point at - that is what someone
 * inspecting a tensor or a __gm__ buffer wants to see. Everything else
 * resolves to the address of the variable itself.
 *
 * Returns undefined for values with no address (registers, optimized-out
 * locals, pretty-printer synthetics); callers omit memoryReference then.
 */
export async function resolveMemoryAddress(
	mi: MiConnection,
	expression: string,
	shape: TypeShape,
	threadId: number,
	frameLevel: number,
): Promise<string | undefined> {
	if (!expression) {
		return undefined;
	}
	const target = shape.isPointer || shape.isArray
		? `(unsigned long long)(${expression})`
		: `(unsigned long long)&(${expression})`;
	try {
		const record = await mi.sendCommand(
			`-data-evaluate-expression --thread ${threadId} --frame ${frameLevel} ${quoteMiString(target)}`);
		const raw = miString(record.results['value']).trim();
		if (!raw) {
			return undefined;
		}
		// GDB may append a symbol: "4198400 <main>". Take the leading number.
		const m = /^(0x[0-9a-fA-F]+|\d+)/.exec(raw);
		if (!m) {
			return undefined;
		}
		const value = BigInt(m[1]);
		if (value === 0n) {
			// A null pointer has no memory to show; a variable at address 0 does
			// not happen in practice, so treating both as "no reference" is safe.
			return undefined;
		}
		return `0x${value.toString(16)}`;
	} catch {
		return undefined;
	}
}
