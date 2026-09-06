/*---------------------------------------------------------------------------
 * Register grouping and variable mapping.
 *
 * A stopped AI core reports a hundred-odd registers, and a flat list of them
 * is a wall. Splitting them into vector / scalar / system folders is the
 * Atmel Studio and Visual Studio treatment: the group you want is one click,
 * and the ones you do not care about stay collapsed.
 *
 * The second half is the interesting one. A local variable that lives in a
 * register has no address, so it never appears in the memory viewer and the
 * connection between `v0` and `myTensor` is invisible. GDB knows the binding
 * and will say so if asked; this parses the answer.
 *
 * Pure, so the classification and the parsing are unit tested without a
 * debugger anywhere near them.
 *-------------------------------------------------------------------------*/

export type RegisterGroup = 'vector' | 'scalar' | 'system';

export interface RegisterGroupInfo {
	id: RegisterGroup;
	label: string;
}

/** Display order: the ones a kernel author looks at first come first. */
export const REGISTER_GROUPS: readonly RegisterGroupInfo[] = [
	{ id: 'vector', label: 'Vector Registers' },
	{ id: 'scalar', label: 'Scalar Registers' },
	{ id: 'system', label: 'System Registers' },
];

/** v0..v31, plus the q and z spellings of the same file. */
const VECTOR_NUMBERED = /^(?:v|q|z)\d+$/i;

/** x0.., w0.., s0.., r0.. - the general-purpose and scalar float files. */
const SCALAR_NUMBERED = /^(?:x|w|s|r)\d+$/i;

/**
 * Named registers that are general-purpose in everything but spelling. The
 * stack and frame pointers belong beside the registers a kernel actually
 * indexes off, not in with the status words.
 */
const SCALAR_NAMED = new Set(['sp', 'fp', 'lr', 'xzr', 'wzr', 'ra']);

/**
 * Which folder a register belongs in.
 *
 * Anything unrecognised lands in "System", which is the honest default: an
 * Ascend-specific register this build has never heard of should still be
 * visible, just not filed under a guess.
 */
export function categorizeRegister(name: string): RegisterGroup {
	const bare = (name || '').trim();
	if (VECTOR_NUMBERED.test(bare)) {
		return 'vector';
	}
	if (SCALAR_NUMBERED.test(bare) || SCALAR_NAMED.has(bare.toLowerCase())) {
		return 'scalar';
	}
	return 'system';
}

/**
 * Split register names into their groups, keeping the debugger's own order
 * within each - that order is the register number, which is what someone
 * reading disassembly expects.
 */
export function groupRegisters(names: readonly string[]): Map<RegisterGroup, string[]> {
	const groups = new Map<RegisterGroup, string[]>();
	for (const info of REGISTER_GROUPS) {
		groups.set(info.id, []);
	}
	for (const name of names) {
		if (!name) {
			continue;
		}
		groups.get(categorizeRegister(name))!.push(name);
	}
	return groups;
}

export interface RegisterBinding {
	symbol: string;
	register: string;
}

/**
 * Read one `info address <symbol>` answer.
 *
 * The only case that counts is a variable that *lives in* a register:
 *
 *   Symbol "acc" is a variable in register $v0.
 *
 * Deliberately not matched is the far commoner stack case, which also names a
 * register but means something else entirely:
 *
 *   Symbol "n" is a variable at frame base reg $x29 offset 20.
 *
 * Treating that as a binding would label x29 with every local in the frame.
 */
export function parseRegisterBinding(text: string): RegisterBinding | undefined {
	const match = /Symbol\s+"([^"]+)"\s+is\s+(?:a\s+variable\s+)?in\s+register\s+\$?([A-Za-z_]\w*)/
		.exec(text || '');
	if (!match) {
		return undefined;
	}
	return { symbol: match[1], register: match[2] };
}

/**
 * Annotate a register's value with the locals held in it, in the format the
 * Variables view has room for:
 *
 *   0x2000 [mapped to: myLocalTensor]
 */
export function annotateRegisterValue(value: string, symbols: readonly string[]): string {
	if (!symbols.length) {
		return value;
	}
	return `${value} [mapped to: ${symbols.join(', ')}]`;
}

/**
 * Show a register as both hex and decimal: `0x0000002A (42)`.
 *
 * GDB reports registers in hex, which is right for an address and useless for
 * a loop counter. The hex is zero-padded to 32 or 64 bits so a column of them
 * lines up, and the decimal is *unsigned* - the literal value of the bits.
 * Signed would need the register's width, which MI does not report, and a
 * guess that is wrong turns a large address into a negative number.
 *
 * Values that are not a plain scalar are left exactly as they came: a vector
 * lane dump (`{s = {...}}`) or a float has nothing to gain from this.
 */
export function formatRegisterValue(raw: string): string {
	const text = (raw || '').trim();
	const match = /^0x([0-9a-fA-F]+)$/.exec(text);
	if (!match) {
		return text;
	}

	const digits = match[1];
	if (digits.length > 16) {
		// Wider than 64 bits: a vector register's full contents. A 128-bit
		// decimal is not something anyone reads, so leave it in hex.
		return `0x${digits.toUpperCase()}`;
	}

	const width = digits.length > 8 ? 16 : 8;
	return `0x${digits.toUpperCase().padStart(width, '0')} (${BigInt(text).toString()})`;
}

/**
 * The full value string for one register: formatted, marked with what it last
 * held, and annotated with any locals living in it.
 *
 *   0x0000002A (42) [was 0x28] [mapped to: count]
 *
 * `was` is the last *different* value, not the value at the previous stop -
 * and that distinction is the whole point. VS Code decides what to highlight
 * by diffing the rendered string against the last one, so a marker that
 * appeared on the stop a register changed and vanished on the next would
 * itself look like a change, highlighting a register that had held still.
 * Keeping the last different value pinned means the string stops changing
 * exactly when the register does.
 *
 * The marker comes before the mapping because when stepping it is the thing
 * being looked for. The old value is shown raw, as the debugger reported it:
 * the interest is in what it was, not in reading it padded a second time.
 */
export function renderRegisterValue(
	raw: string,
	was: string | undefined,
	symbols: readonly string[] = [],
): string {
	let out = formatRegisterValue(raw);
	if (was !== undefined && was !== raw) {
		out += ` [was ${was}]`;
	}
	return annotateRegisterValue(out, symbols);
}
