/*---------------------------------------------------------------------------
 * Synthetic children providers.
 *
 * CANN 8.5's msdebug-mi ships LLDB's libstdc++ data formatters in a broken
 * state: a std::vector comes back as
 *
 *   value="error: summary string parsing error"
 *   type="const std::vector<float, std::allocator<> >"
 *
 * and its only child is `std::_Vector_base<...>`, so the Variables view shows
 * an error string over three raw pointers instead of the elements. Rather than
 * patching Python inside the image - which would have to be redone for every
 * container, image rebuild and CANN release - the adapter reconstructs the
 * children itself from the raw members it *can* read.
 *
 * A formatter answers two questions about a value:
 *   inspect()     what does the parent row say, how many children are there,
 *                 and where does the payload live
 *   getChildren() the children of one page
 *
 * `inspect` returns an opaque `state` that is handed back to `getChildren`, so
 * the pointer arithmetic is done once per expansion rather than once per page.
 *-------------------------------------------------------------------------*/

import { DebugProtocol } from '@vscode/debugprotocol';
import { MiConnection } from './mi/miConnection';
import { evaluateInteger, VarObjectManager } from './varObjects';

/** Everything a formatter needs to talk to the debugger and to the session. */
export interface FormatterContext {
	readonly mi: MiConnection;
	readonly varManager: VarObjectManager;
	readonly threadId: number;
	readonly frameLevel: number;
	/**
	 * Reserve a variablesReference that expands `expression` on demand.
	 * This is what makes nesting work: a vector of structs, or a vector of
	 * vectors, re-enters the same formatter pipeline one level down.
	 */
	reserveExpansion(expression: string): number;
}

/** The parent row's presentation, plus formatter-private state for paging. */
export interface FormatterView {
	/** Replaces the debugger's own (here: broken) summary string. */
	value: string;
	/** Element count, so VS Code pages instead of asking for everything. */
	indexedVariables: number;
	/** Address of the payload - the buffer, not the three-pointer header. */
	memoryReference?: string;
	/** Opaque to everyone but the formatter that produced it. */
	state: unknown;
}

export interface ITypeFormatter {
	/** Diagnostic name, shown in engine logging. */
	readonly name: string;

	/** Does this formatter own values of this type? */
	match(type: string): boolean;

	/**
	 * Measure the value. Returning undefined means "not actually formattable
	 * after all" - the caller then falls back to the debugger's own children,
	 * which is the right outcome for an uninitialised or corrupt object.
	 */
	inspect(ctx: FormatterContext, expression: string, type: string): Promise<FormatterView | undefined>;

	/** Children in the half-open range [start, start + count). */
	getChildren(
		ctx: FormatterContext,
		view: FormatterView,
		start: number,
		count: number,
	): Promise<DebugProtocol.Variable[]>;
}

export class TypeFormatterRegistry {
	private readonly formatters: ITypeFormatter[] = [];

	/** Later registrations win, so a workspace override can shadow a built-in. */
	public register(formatter: ITypeFormatter): void {
		this.formatters.unshift(formatter);
	}

	public find(type: string | undefined): ITypeFormatter | undefined {
		if (!type) {
			return undefined;
		}
		return this.formatters.find((f) => f.match(type));
	}
}

export function createDefaultFormatterRegistry(): TypeFormatterRegistry {
	const registry = new TypeFormatterRegistry();
	registry.register(new StdVectorFormatter());
	return registry;
}

/* -------------------------------------------------------------------------
 * std::vector
 * ---------------------------------------------------------------------- */

interface VectorState {
	/** Path expression of the vector itself, e.g. `x` or `cfg->rows`. */
	expression: string;
	/** Address of the first element. */
	dataAddress: bigint;
	elementSize: number;
	elementType: string;
	count: number;
}

/**
 * A libstdc++ vector is `_M_impl._M_start`, `_M_finish`, `_M_end_of_storage`.
 * Element count is (finish - start) / sizeof(element); all three members are
 * readable even when the pretty-printer is broken.
 */
export class StdVectorFormatter implements ITypeFormatter {
	public readonly name = 'std::vector';

	/**
	 * A vector whose contents are nonsense (an uninitialised local, a
	 * half-constructed object) can report an astronomical length. Refuse to
	 * believe anything past this and show the raw members instead, rather than
	 * asking the debugger for a billion children.
	 */
	private static readonly MAX_ELEMENTS = 4_000_000;

	public match(type: string): boolean {
		const bare = stripCvRef(type);
		// libstdc++ is `std::vector`, libc++ inserts an inline namespace.
		if (!/^std::(?:__\w+::)?vector\s*</.test(bare)) {
			return false;
		}
		// std::vector<bool> is a bit-packed specialisation with a completely
		// different layout; pointer arithmetic over it would produce garbage.
		const element = firstTemplateArgument(bare);
		return element !== undefined && stripCvRef(element) !== 'bool';
	}

	public async inspect(
		ctx: FormatterContext,
		expression: string,
		type: string,
	): Promise<FormatterView | undefined> {
		const elementType = firstTemplateArgument(stripCvRef(type));
		if (!elementType) {
			return undefined;
		}

		const base = `(${expression})._M_impl`;
		const [start, finish, elementSize] = await Promise.all([
			evaluateInteger(ctx.mi, `(unsigned long long)${base}._M_start`, ctx.threadId, ctx.frameLevel),
			evaluateInteger(ctx.mi, `(unsigned long long)${base}._M_finish`, ctx.threadId, ctx.frameLevel),
			evaluateInteger(ctx.mi, `sizeof(*${base}._M_start)`, ctx.threadId, ctx.frameLevel),
		]);

		if (start === undefined || finish === undefined || elementSize === undefined || elementSize <= 0n) {
			// Not a libstdc++ layout, or not readable: let the caller fall back.
			return undefined;
		}

		const count = vectorLength(start, finish, elementSize);
		if (count === undefined || count > StdVectorFormatter.MAX_ELEMENTS) {
			return undefined;
		}

		const state: VectorState = {
			expression,
			dataAddress: start,
			elementSize: Number(elementSize),
			elementType,
			count,
		};

		return {
			value: `{ size=${count} }`,
			indexedVariables: count,
			// Point the Hex Editor at the payload. The address of the vector
			// object itself is only the three-pointer header, which is never
			// what someone inspecting a tensor wants to see.
			memoryReference: count > 0 && start !== 0n ? `0x${start.toString(16)}` : undefined,
			state,
		};
	}

	public async getChildren(
		ctx: FormatterContext,
		view: FormatterView,
		start: number,
		count: number,
	): Promise<DebugProtocol.Variable[]> {
		const state = view.state as VectorState;
		const first = Math.max(0, start);
		const length = Math.max(0, Math.min(count, state.count - first));
		if (length <= 0) {
			return [];
		}

		const batched = await this.readPageAsArray(ctx, state, first, length);
		if (batched) {
			return batched;
		}
		// The cast is rejected by some type/debugger combinations (opaque or
		// locally-defined element types); fall back to one read per element.
		return this.readPageElementwise(ctx, state, first, length);
	}

	/**
	 * Read a whole page in one round trip by casting the slice to a pointer to
	 * an array and letting the debugger enumerate it:
	 *
	 *   *(float (*)[100])((x)._M_impl._M_start + 200)
	 *
	 * -var-list-children on that yields 100 already-formatted values, instead
	 * of 100 separate -data-evaluate-expression calls.
	 */
	private async readPageAsArray(
		ctx: FormatterContext,
		state: VectorState,
		first: number,
		length: number,
	): Promise<DebugProtocol.Variable[] | undefined> {
		const sliceExpr =
			`*(${state.elementType} (*)[${length}])((${state.expression})._M_impl._M_start + ${first})`;
		try {
			const arrayObject = await ctx.varManager.create(sliceExpr, ctx.threadId, ctx.frameLevel);
			const children = await ctx.varManager.children(arrayObject.name);
			if (children.length !== length) {
				return undefined;
			}
			return children.map((child, i) =>
				this.toElement(ctx, state, first + i, child.value, child.type || state.elementType, child.numchild > 0));
		} catch {
			return undefined;
		}
	}

	private async readPageElementwise(
		ctx: FormatterContext,
		state: VectorState,
		first: number,
		length: number,
	): Promise<DebugProtocol.Variable[]> {
		const out: DebugProtocol.Variable[] = [];
		for (let i = 0; i < length; i++) {
			const index = first + i;
			let value = '<unreadable>';
			let expandable = false;
			try {
				const element = await ctx.varManager.create(
					elementExpression(state, index), ctx.threadId, ctx.frameLevel);
				value = element.value;
				expandable = element.numchild > 0 || element.hasMore;
			} catch {
				/* keep the placeholder */
			}
			out.push(this.toElement(ctx, state, index, value, state.elementType, expandable));
		}
		return out;
	}

	private toElement(
		ctx: FormatterContext,
		state: VectorState,
		index: number,
		value: string,
		type: string,
		expandable: boolean,
	): DebugProtocol.Variable {
		// Addresses are pure arithmetic off the payload base - no round trip -
		// so every element keeps a working "View Binary Data".
		const address = state.dataAddress + BigInt(index) * BigInt(state.elementSize);
		const evaluateName = elementExpression(state, index);

		return {
			name: `[${index}]`,
			value,
			type,
			evaluateName,
			// Expanding an element re-enters the pipeline, so a vector of
			// structs - or of vectors - keeps working all the way down.
			variablesReference: expandable ? ctx.reserveExpansion(evaluateName) : 0,
			memoryReference: state.dataAddress === 0n ? undefined : `0x${address.toString(16)}`,
		};
	}
}

/** `*((x)._M_impl._M_start + 7)` - valid to re-evaluate, so watches work. */
function elementExpression(state: VectorState, index: number): string {
	return `*((${state.expression})._M_impl._M_start + ${index})`;
}

/* -------------------------------------------------------------------------
 * Type-string helpers (pure, unit tested)
 * ---------------------------------------------------------------------- */

/** Drop leading const/volatile and any trailing reference marker. */
export function stripCvRef(type: string): string {
	let t = (type || '').trim();
	t = t.replace(/\s*&&?\s*$/, '');
	for (;;) {
		const next = t.replace(/^(?:const|volatile)\s+/, '');
		if (next === t) {
			return next.trim();
		}
		t = next;
	}
}

/**
 * First template argument of `Name<A, B>`, respecting nesting so that
 * `std::vector<std::pair<int, int>, std::allocator<> >` yields
 * `std::pair<int, int>` rather than `std::pair<int`.
 * Returns undefined when the type is not a template.
 */
export function firstTemplateArgument(type: string): string | undefined {
	const open = type.indexOf('<');
	if (open < 0) {
		return undefined;
	}
	let depth = 0;
	for (let i = open; i < type.length; i++) {
		const ch = type[i];
		if (ch === '<') {
			depth++;
		} else if (ch === '>') {
			depth--;
			if (depth === 0) {
				return type.slice(open + 1, i).trim() || undefined;
			}
		} else if (ch === ',' && depth === 1) {
			return type.slice(open + 1, i).trim() || undefined;
		}
	}
	return undefined;
}

/**
 * Element count from the raw pointers. Rejects a range that is negative or not
 * a whole number of elements - both mean the object is not a live vector, and
 * showing the raw members is more honest than inventing children.
 */
export function vectorLength(start: bigint, finish: bigint, elementSize: bigint): number | undefined {
	if (elementSize <= 0n) {
		return undefined;
	}
	const bytes = finish - start;
	if (bytes < 0n || bytes % elementSize !== 0n) {
		return undefined;
	}
	return Number(bytes / elementSize);
}
