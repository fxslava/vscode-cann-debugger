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

/*
 * std::string locals, in the libstdc++ C++11 ABI layout: a _M_p that points at
 * the characters, a length, and a 16-byte local buffer inside the object.
 */
interface FakeString {
	/** Address of the string object itself. */
	object: number;
	objectSize: number;
	/** _M_dataplus._M_p - inside the object under SSO, on the heap otherwise. */
	data: number;
	/** What is really at `data`. */
	text: string;
	/** What _M_string_length reports, which an uninitialised object may lie about. */
	length: number;
}

const STRINGS: { [name: string]: FakeString } = {
	// Short: _M_p points into the object's own local buffer.
	label: { object: 0x5000, objectSize: 32, data: 0x5010, text: 'hello ascend', length: 12 },
	// Long: _M_p points at the heap, well outside the object.
	banner: { object: 0x5100, objectSize: 32, data: 0x6000, text: 'Ascend C kernel: AddCustom', length: 26 },
	// Uninitialised: _M_p is inside the object, so the string is short, but the
	// length field claims far more than the local buffer can hold. A formatter
	// that trusts the length here invents 99 characters out of stack noise.
	scratch: { object: 0x5200, objectSize: 32, data: 0x5210, text: 'garbage', length: 99 },
};

const STRING_TYPE =
	'std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >';

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
	// A CLI command run through MI answers on the ~ console stream, which the
	// adapter captures to return as the evaluate result.
	if (command.startsWith('-interpreter-exec console')) {
		out('~"x0             0x2000              8192\\n"');
		done(token);
		return;
	}

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
			// GDB talking about itself. The & log stream is GDB echoing the
			// commands we sent it, which is what floods the Debug Console.
			out('&"-stack-list-variables --thread 1 --frame 0 --no-values\\n"');
			out('~"[New Thread 0x7ffd (LWP 4242)]\\n"');
			// The debuggee talking: the @ target stream, and - under WSL, where
			// the debuggee shares GDB\'s stdout - a plain non-MI line.
			out('@"AddCustom: tile 0 of 8\\n"');
			out('kernel printf via shared stdout');
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
			'{name="scores"},{name="weights"},{name="tilings"},' +
			'{name="label"},{name="banner"},{name="scratch"}]');
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

		if (STRINGS[expression]) {
			// Same breakage, different container.
			done(token,
				`name="var_${expression}",numchild="1",` +
				`value="error: summary string parsing error",` +
				`type="${STRING_TYPE}",has_more="0"`);
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
		// Locals are varobj'd as var_<expression>, so the path is the name back.
		if (name.startsWith('var_')) {
			done(token, `path_expr="${name.slice(4)}"`);
			return;
		}
		const map: { [k: string]: string } = { var1: 'xGm', var2: 'loopCount', var3: 'tiling' };
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
		// What the debugger offers when the formatter declines a string: the
		// raw members, which is the honest answer for an unreadable object.
		if (name.startsWith('var_') && STRINGS[name.slice(4)]) {
			done(token,
				`numchild="1",children=[child={name="${name}._M_dataplus",exp="_M_dataplus",` +
				'numchild="1",value="{...}",type="std::_Alloc_hider"}],has_more="0"');
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

		// std::string members. _M_p is readable even when the summary is not.
		const stringMember =
			/\((\w+)\)\._M_(dataplus\._M_p|string_length)$/.exec(expression);
		if (stringMember && STRINGS[stringMember[1]]) {
			const string = STRINGS[stringMember[1]];
			done(token, `value="${stringMember[2] === 'string_length' ? string.length : string.data}"`);
			return;
		}
		const objectAddress = /^\(unsigned long long\)&\((\w+)\)$/.exec(expression);
		if (objectAddress && STRINGS[objectAddress[1]]) {
			done(token, `value="${STRINGS[objectAddress[1]].object}"`);
			return;
		}
		const objectSize = /^sizeof\((\w+)\)$/.exec(expression);
		if (objectSize && STRINGS[objectSize[1]]) {
			done(token, `value="${STRINGS[objectSize[1]].objectSize}"`);
			return;
		}

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

		// String character buffers, wherever _M_p happens to point.
		const string = Object.values(STRINGS).find((s) => s.data === Number(address));
		if (string) {
			const bytes = Buffer.from(string.text, 'utf8').subarray(0, count);
			const end = `0x${(Number(address) + bytes.length).toString(16)}`;
			done(token,
				`memory=[{begin="${address}",offset="0x0",end="${end}",` +
				`contents="${bytes.toString('hex')}"}]`);
			return;
		}

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
