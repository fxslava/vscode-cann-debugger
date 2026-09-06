import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MiRecordType, miList, miString, miTuple, parseMiLine } from '../mi/miParser';

test('parses a stop record with a nested frame tuple', () => {
	const record = parseMiLine(
		'*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x0000000000400546",' +
		'func="AddCustom",args=[{name="x",value="0x7fff0000"}],file="add_custom.cpp",' +
		'fullname="/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp",line="42"},thread-id="1",' +
		'stopped-threads="all",core="0"');

	assert.equal(record.type, MiRecordType.ExecAsync);
	assert.equal(record.class, 'stopped');
	assert.equal(miString(record.results['reason']), 'breakpoint-hit');

	const frame = miTuple(record.results['frame']);
	assert.ok(frame);
	assert.equal(miString(frame['func']), 'AddCustom');
	assert.equal(miString(frame['line']), '42');
	assert.equal(
		miString(frame['fullname']),
		'/mnt/d/Projects/vllm-ascend/csrc/tests/add_custom.cpp');

	const args = frame['args'];
	assert.ok(Array.isArray(args));
	assert.equal(miString(miTuple(args[0])!['name']), 'x');
});

test('routes result records by token', () => {
	const record = parseMiLine('42^done,value="0x1234"');
	assert.equal(record.type, MiRecordType.Result);
	assert.equal(record.token, 42);
	assert.equal(record.class, 'done');
	assert.equal(miString(record.results['value']), '0x1234');
});

test('surfaces GDB error messages', () => {
	const record = parseMiLine('7^error,msg="Cannot access memory at address 0x0"');
	assert.equal(record.class, 'error');
	assert.equal(miString(record.results['msg']), 'Cannot access memory at address 0x0');
});

test('flattens a keyed list of frames', () => {
	const record = parseMiLine(
		'^done,stack=[frame={level="0",addr="0x400546",func="Compute"},' +
		'frame={level="1",addr="0x400600",func="main"}]');
	const frames = miList(record.results['stack'], 'frame');
	assert.equal(frames.length, 2);
	assert.equal(miString(frames[0]['func']), 'Compute');
	assert.equal(miString(frames[1]['level']), '1');
});

test('parses -data-read-memory-bytes output including split blocks', () => {
	const record = parseMiLine(
		'^done,memory=[{begin="0x1000",offset="0x0",end="0x1004",contents="deadbeef"},' +
		'{begin="0x1008",offset="0x8",end="0x100c",contents="cafebabe"}]');
	const blocks = miList(record.results['memory'], 'memory');
	assert.equal(blocks.length, 2);
	assert.equal(miString(blocks[0]['contents']), 'deadbeef');
	assert.equal(miString(blocks[1]['begin']), '0x1008');
});

test('collects repeated keys instead of dropping them', () => {
	const record = parseMiLine('^done,bkpt={number="2",addr="0x1"},bkpt={number="3",addr="0x2"}');
	const bkpts = record.results['bkpt'];
	assert.ok(Array.isArray(bkpts));
	assert.equal(bkpts.length, 2);
});

test('unescapes C strings in stream records', () => {
	const record = parseMiLine('~"Breakpoint 1 at 0x400546: file \\"add_custom.cpp\\", line 42.\\n"');
	assert.equal(record.type, MiRecordType.ConsoleStream);
	assert.equal(record.text, 'Breakpoint 1 at 0x400546: file "add_custom.cpp", line 42.\n');
});

test('distinguishes the three stream records', () => {
	// ~ is GDB talking to the user, @ is the debuggee, & is GDB's own log.
	assert.equal(parseMiLine('~"symbols loaded\\n"').type, MiRecordType.ConsoleStream);
	assert.equal(parseMiLine('@"kernel output\\n"').type, MiRecordType.TargetStream);
	assert.equal(parseMiLine('&"-exec-run\\n"').type, MiRecordType.LogStream);

	assert.equal(parseMiLine('@"tile 0 of 8\\n"').text, 'tile 0 of 8\n');
	assert.equal(parseMiLine('&"-stack-list-variables\\n"').text, '-stack-list-variables\n');
});

test('unescapes the rest of the C escapes a stream record can carry', () => {
	// Tabs and carriage returns survive a printf-heavy kernel.
	assert.equal(parseMiLine('@"a\\tb\\r\\n"').text, 'a\tb\r\n');
	assert.equal(parseMiLine('@"back\\\\slash"').text, 'back\\slash');
	// Octal and hex escapes: GDB uses them for non-printable bytes.
	assert.equal(parseMiLine('@"\\033[31m"').text, '\x1b[31m');
	assert.equal(parseMiLine('@"\\x41\\x42"').text, 'AB');
	// An unterminated string means GDB truncated the line; keep what arrived.
	assert.equal(parseMiLine('@"half a line').text, 'half a line');
});

test('handles empty tuples, empty lists and the prompt', () => {
	assert.deepEqual(parseMiLine('^done,threads=[],groups={}').results['threads'], []);
	assert.equal(parseMiLine('(gdb)').type, MiRecordType.Prompt);
});

test('treats non-MI output as unknown rather than throwing', () => {
	const record = parseMiLine('kernel says hello');
	assert.equal(record.type, MiRecordType.Unknown);
	assert.equal(record.raw, 'kernel says hello');
});

test('parses register values', () => {
	const record = parseMiLine(
		'^done,register-values=[{number="0",value="0x0"},{number="1",value="0x7ffffffee0"}]');
	const values = miList(record.results['register-values'], 'register-values');
	assert.equal(values.length, 2);
	assert.equal(miString(values[1]['value']), '0x7ffffffee0');
});

test('parses varobj children', () => {
	const record = parseMiLine(
		'^done,numchild="2",children=[child={name="var1.x",exp="x",numchild="0",value="1",type="int"},' +
		'child={name="var1.buf",exp="buf",numchild="256",value="0x2000",type="__gm__ half *"}],has_more="0"');
	const children = miList(record.results['children'], 'child');
	assert.equal(children.length, 2);
	assert.equal(miString(children[1]['type']), '__gm__ half *');
});
