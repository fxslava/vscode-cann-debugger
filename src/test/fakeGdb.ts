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
		done(token, 'variables=[{name="tiling",arg="1"},{name="xGm"},{name="loopCount"}]');
		return;
	}

	if (command.startsWith('-var-create')) {
		const expression = /"([^"]+)"\s*$/.exec(command)?.[1] ?? '';
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
		const map: { [k: string]: string } = { var1: 'xGm', var2: 'loopCount', var3: 'tiling' };
		done(token, `path_expr="${map[name] ?? name}"`);
		return;
	}

	if (command.startsWith('-var-list-children')) {
		done(token,
			'numchild="2",children=[' +
			'child={name="var3.totalLength",exp="totalLength",numchild="0",value="1024",type="uint32_t"},' +
			'child={name="var3.tileNum",exp="tileNum",numchild="0",value="8",type="uint32_t"}],has_more="0"');
		return;
	}

	if (command.startsWith('-data-evaluate-expression')) {
		const expression = /"(.+)"\s*$/.exec(command)?.[1] ?? '';
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
