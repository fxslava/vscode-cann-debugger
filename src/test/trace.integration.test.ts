/*---------------------------------------------------------------------------
 * The other half of the console policy: with `trace: true`, the MI dialogue
 * comes back.
 *
 * Runs its own adapter process, because the flag is a launch option and the
 * default-off behaviour is asserted next door in adapter.integration.test.ts.
 *-------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { closeFixture, DapClient, Fixture, launchFixture } from './dapClient';

let fixture: Fixture;
let client: DapClient;

before(async () => {
	fixture = await launchFixture({ trace: true });
	client = fixture.client;
});

after(() => closeFixture(fixture));

test('trace mirrors the commands the adapter sends', () => {
	const consoleText = client.output('console');
	// Outbound, with the MI token the reply will carry.
	assert.match(consoleText, /--> \d+-exec-run/);
	assert.match(consoleText, /--> \d+-break-insert/);
	// Inbound, including the result records.
	assert.match(consoleText, /<-- \d+\^done/);
});

test('trace mirrors GDB\'s own console and log streams', () => {
	const consoleText = client.output('console');
	// The & log stream: GDB echoing a command back at us.
	assert.match(consoleText, /-stack-list-variables --thread 1/);
	// The ~ console stream: GDB talking about its own state.
	assert.match(consoleText, /New Thread 0x7ffd/);
});

test('tracing does not divert the program output', () => {
	// The debuggee's own output stays on stdout where the user expects it,
	// rather than being folded into the trace.
	const stdout = client.output('stdout');
	assert.match(stdout, /AddCustom: tile 0 of 8/);
	assert.match(stdout, /kernel printf via shared stdout/);
});

test('the older logging.engineLogging spelling still turns tracing on', async () => {
	const legacy = await launchFixture({ logging: { engineLogging: true } });
	try {
		assert.match(legacy.client.output('console'), /--> \d+-exec-run/);
	} finally {
		await closeFixture(legacy);
	}
});
