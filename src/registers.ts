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
