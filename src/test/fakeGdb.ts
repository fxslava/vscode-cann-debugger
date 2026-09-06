/*---------------------------------------------------------------------------
 * A stand-in for ascend-gdb that speaks just enough GDB/MI to drive the
 * adapter through a full session. Used by adapter.integration.test.ts so the
 * whole stack - process spawn, MI framing, token routing, path mapping,
 * varobjs, memory reads - can be exercised without a CANN installation.
 *
 * It is deliberately strict about the paths it receives: a location that is
 * not a guest path is answered with ^error, so a regression in the Windows ->
 * WSL translation fails the test instead of silently passing.
 *-------------------------------------------------------------------------*/

const GUEST_SOURCE = '/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp';

/** 16 bytes of recognisable payload served by -data-read-memory-bytes. */
const MEMORY_AT_0X2000 = '000102030405060708090a0b0c0d0e0f';

/*
 * Two std::vector locals, laid out the way libstdc++ lays them out and broken
 * the way CANN's msdebug-mi breaks them: the summary string is an error and
 * the only native child is _Vector_base. Everything the formatter needs -
 * _M_start, _M_finish, sizeof(*_M_start) - is readable, which is exactly the
 * situation the synthetic children provider exists for.
 *
 * `castable: false` reproduces a debugger that rejects the array-cast page
 * read, forcing the one-element-at-a-time fallback.
 */
interface FakeVector {
	element: string;
	elementSize: number;
	start: number;
	count: number;
	castable: boolean;
	/** Elements are structs, so each one is expandable in its own right. */
	aggregate?: boolean;
}

const VECTORS: { [name: string]: FakeVector } = {
	// Payload sits at 0x2000, so its 4 floats overlay the readable window above.
	scores: { element: 'float', elementSize: 4, start: 0x2000, count: 4, castable: true },
	weights: { element: 'double', elementSize: 8, start: 0x3000, count: 3, castable: false },
	tilings: {
		element: 'TilingData', elementSize: 8, start: 0x4000, count: 2,
		castable: true, aggregate: true,
	},
};

const VECTOR_TYPE = (v: FakeVector): string =>
	`std::vector<${v.element}, std::allocator<${v.element}> >`;

/** Distinct per index, so a mis-paged read surfaces as a wrong number. */
function elementValue(vector: string, index: number): string {
	if (VECTORS[vector]?.aggregate) {
		return '{...}';
	}
	return vector === 'scores' ? `${index}.5` : `${100 + index}.25`;
}

/** Array-slice varobjs handed out by -var-create, keyed by varobj name. */
const slices = new Map<string, { vector: string; first: number; length: number }>();
/** Single-element varobjs, keyed by varobj name -> the expression behind it. */
const elements = new Map<string, string>();
let syntheticVarobjs = 0;

/** The fields of a struct element, so a nested expansion has something to show. */
function structChildren(varobj: string): string {
	return 'numchild="2",children=[' +
		`child={name="${varobj}.totalLength",exp="totalLength",numchild="0",value="2048",type="uint32_t"},` +
		`child={name="${varobj}.tileNum",exp="tileNum",numchild="0",value="16",type="uint32_t"}],has_more="0"`;
}

function out(line: string): void {
	process.stdout.write(line + '\n');
}

function prompt(): void {
	process.stdout.write('(gdb) \n');
}

function done(token: string, payload?: string): void {
	out(`${token}^done${payload ? ',' + payload : ''}`);
	prompt();
}

function error(token: string, message: string): void {
	out(`${token}^error,msg="${message.replace(/"/g, '\\"')}"`);
	prompt();
}

const STOP_FRAME =
	'frame={addr="0x0000000000400546",func="AddCustom",' +
	'args=[{name="tiling",value="0x7ffd0010"}],file="add_custom.cpp",' +
	`fullname="${GUEST_SOURCE}",line="42"}`;

function handle(token: string, command: string): void {
	// Setup and bookkeeping commands that only need an acknowledgement.
	if (/^-(gdb-set|enable-pretty-printing|environment-cd|file-exec-and-symbols|var-delete|interpreter-exec)\b/.test(command)) {
		done(token);
		return;
	}

	if (command.startsWith('-break-insert')) {
		const location = /"([^"]+)"\s*$/.exec(command)?.[1] ?? '';
		if (!location.startsWith('/')) {
			error(token, `unexpected non-guest path: ${location}`);
			return;
		}
		const line = /:(\d+)$/.exec(location)?.[1] ?? '1';
		done(token,
			'bkpt={number="1",type="breakpoint",disp="keep",enabled="y",' +
			`addr="0x0000000000400546",func="AddCustom",file="add_custom.cpp",` +
			`fullname="${GUEST_SOURCE}",line="${line}",times="0"}`);
		return;
	}

	if (command.startsWith('-exec-run')) {
		if (command.includes('--start')) {
			// Emulate an older GDB that lacks --start, to exercise the fallback.
			error(token, 'Undefined command: "start".');
			return;
		}
		out(`${token}^running`);
		prompt();
		setTimeout(() => {
			out('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",' +
				`${STOP_FRAME},thread-id="1",stopped-threads="all",core="0"`);
			prompt();
		}, 10);
		return;
	}

	if (command.startsWith('-exec-continue')) {
		out(`${token}^running`);
		prompt();
		setTimeout(() => {
			out('*stopped,reason="exited-normally"');
			prompt();
		}, 10);
		return;
	}

	if (command.startsWith('-thread-info')) {
		done(token,
			'threads=[{id="1",target-id="Ascend core 0",name="aicore0",state="stopped"}],' +
			'current-thread-id="1"');
		return;
	}

	if (command.startsWith('-stack-info-depth')) {
		done(token, 'depth="2"');
		return;
	}

	if (command.startsWith('-stack-list-frames')) {
		done(token,
			'stack=[frame={level="0",addr="0x0000000000400546",func="AddCustom",' +
			`file="add_custom.cpp",fullname="${GUEST_SOURCE}",line="42"},` +
			'frame={level="1",addr="0x0000000000400700",func="main",' +
			`file="add_custom.cpp",fullname="${GUEST_SOURCE}",line="90"}]`);
		return;
	}

	if (command.startsWith('-stack-list-variables')) {
		done(token,
			'variables=[{name="tiling",arg="1"},{name="xGm"},{name="loopCount"},' +
			'{name="scores"},{name="weights"},{name="tilings"}]');
		return;
	}

	if (command.startsWith('-var-create')) {
		const expression = /"([^"]+)"\s*$/.exec(command)?.[1] ?? '';

		// A whole page at once: *(float (*)[4])((scores)._M_impl._M_start + 0)
		const slice = /^\*\((\w+) \(\*\)\[(\d+)\]\)\(\((\w+)\)\._M_impl\._M_start \+ (\d+)\)$/.exec(expression);
		if (slice) {
			const [, castType, length, name, first] = slice;
			const vector = VECTORS[name];
			if (!vector) {
				error(token, `No symbol "${name}" in current context.`);
				return;
			}
			if (!vector.castable) {
				// What LLDB says when it cannot synthesise the array type.
				error(token, `unable to find a C type for '${castType} (*)[${length}]'`);
				return;
			}
			const varobj = `varSlice${syntheticVarobjs++}`;
			slices.set(varobj, { vector: name, first: Number(first), length: Number(length) });
			done(token,
				`name="${varobj}",numchild="${length}",value="[${length}]",` +
				`type="${vector.element} [${length}]",has_more="0"`);
			return;
		}

		// One element: *((weights)._M_impl._M_start + 2). Reached both by the
		// element-at-a-time fallback and by expanding a struct element.
		const element = /^\*\(\((\w+)\)\._M_impl\._M_start \+ (\d+)\)$/.exec(expression);
		if (element && VECTORS[element[1]]) {
			const vector = VECTORS[element[1]];
			const varobj = `varElem${syntheticVarobjs++}`;
			elements.set(varobj, expression);
			done(token,
				`name="${varobj}",numchild="${vector.aggregate ? 2 : 0}",` +
				`value="${elementValue(element[1], Number(element[2]))}",` +
				`type="${vector.element}",has_more="0"`);
			return;
		}

		if (VECTORS[expression]) {
			// The broken state this whole feature exists to work around.
			const vector = VECTORS[expression];
			done(token,
				`name="var_${expression}",numchild="1",` +
				`value="error: summary string parsing error",` +
				`type="${VECTOR_TYPE(vector)}",has_more="0"`);
			return;
		}

		switch (expression) {
			case 'xGm':
				done(token, 'name="var1",numchild="0",value="0x2000",type="__gm__ half *",has_more="0"');
				return;
			case 'loopCount':
				done(token, 'name="var2",numchild="0",value="8",type="int",has_more="0"');
				return;
			case 'tiling':
				done(token, 'name="var3",numchild="2",value="{...}",type="TilingData *",has_more="0"');
				return;
			default:
				error(token, `No symbol "${expression}" in current context.`);
				return;
		}
	}

	if (command.startsWith('-var-info-path-expression')) {
		const name = /"([^"]+)"/.exec(command)?.[1] ?? '';
		// A field of a struct element: (*((tilings)._M_impl._M_start + 1)).tileNum
		const field = /^(varElem\d+)\.(\w+)$/.exec(name);
		if (field && elements.has(field[1])) {
			done(token, `path_expr="(${elements.get(field[1])}).${field[2]}"`);
			return;
		}
		const map: { [k: string]: string } = {
			var1: 'xGm', var2: 'loopCount', var3: 'tiling',
			var_scores: 'scores', var_weights: 'weights', var_tilings: 'tilings',
		};
		done(token, `path_expr="${map[name] ?? name}"`);
		return;
	}

	if (command.startsWith('-var-list-children')) {
		const name = /"([^"]+)"/.exec(command)?.[1] ?? '';
		const slice = slices.get(name);
		if (slice) {
			const vector = VECTORS[slice.vector];
			const children: string[] = [];
			for (let i = 0; i < slice.length; i++) {
				children.push(
					`child={name="${name}.${i}",exp="[${i}]",numchild="${vector.aggregate ? 2 : 0}",` +
					`value="${elementValue(slice.vector, slice.first + i)}",type="${vector.element}"}`);
			}
			done(token, `numchild="${slice.length}",children=[${children.join(',')}],has_more="0"`);
			return;
		}
		if (elements.has(name)) {
			done(token, structChildren(name));
			return;
		}
		done(token,
			'numchild="2",children=[' +
			'child={name="var3.totalLength",exp="totalLength",numchild="0",value="1024",type="uint32_t"},' +
			'child={name="var3.tileNum",exp="tileNum",numchild="0",value="8",type="uint32_t"}],has_more="0"');
		return;
	}

	if (command.startsWith('-data-evaluate-expression')) {
		const expression = /"(.+)"\s*$/.exec(command)?.[1] ?? '';

		const sizeofElement = /^sizeof\(\*\((\w+)\)\._M_impl\._M_start\)$/.exec(expression);
		if (sizeofElement && VECTORS[sizeofElement[1]]) {
			done(token, `value="${VECTORS[sizeofElement[1]].elementSize}"`);
			return;
		}

		// _M_start and _M_finish are readable even when the summary is not.
		const member = /\((\w+)\)\._M_impl\._M_(start|finish)$/.exec(expression);
		if (member && VECTORS[member[1]]) {
			const vector = VECTORS[member[1]];
			const address = member[2] === 'start'
				? vector.start
				: vector.start + vector.count * vector.elementSize;
			done(token, `value="${address}"`);
			return;
		}

		if (expression.includes('xGm')) {
			done(token, 'value="8192"');           // 0x2000, the pointer's target
			return;
		}
		if (expression.includes('tiling')) {
			done(token, 'value="140725024362512"'); // address-of the struct
			return;
		}
		error(token, `Cannot evaluate ${expression}`);
		return;
	}

	if (command.startsWith('-data-read-memory-bytes')) {
		const m = /-data-read-memory-bytes\s+(\S+)\s+(\d+)/.exec(command);
		const address = m?.[1] ?? '0x0';
		const count = Number(m?.[2] ?? '0');
		if (address !== '0x2000') {
			error(token, `Cannot access memory at address ${address}`);
			return;
		}
		const contents = MEMORY_AT_0X2000.slice(0, count * 2);
		const end = `0x${(0x2000 + contents.length / 2).toString(16)}`;
		done(token, `memory=[{begin="0x2000",offset="0x0",end="${end}",contents="${contents}"}]`);
		return;
	}

	if (command.startsWith('-data-list-register-names')) {
		done(token, 'register-names=["x0","x1","pc"]');
		return;
	}

	if (command.startsWith('-data-list-register-values')) {
		done(token,
			'register-values=[{number="0",value="0x2000"},{number="1",value="0x0"},' +
			'{number="2",value="0x400546"}]');
		return;
	}

	if (command.startsWith('-gdb-exit')) {
		out(`${token}^exit`);
		process.exit(0);
	}

	// Anything else: succeed quietly, the way GDB does for many set commands.
	done(token);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let nl: number;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, nl).replace(/\r$/, '');
		buffer = buffer.slice(nl + 1);
		if (!line) {
			continue;
		}
		const m = /^(\d*)(-.*)$/.exec(line);
		if (m) {
			handle(m[1], m[2]);
		}
	}
});

// GDB prints a banner and a first prompt before accepting commands.
out('~"GNU gdb (fake ascend-gdb) 12.1\\n"');
prompt();
