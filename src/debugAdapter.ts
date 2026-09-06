/*---------------------------------------------------------------------------
 * Standalone debug adapter entry point.
 *
 * VS Code launches this file as its own Node process (`debuggers.program` in
 * package.json) and speaks DAP over stdin/stdout. Keeping the adapter out of
 * the extension host means a crash in the adapter cannot take the window with
 * it, and it can be driven directly for testing:
 *
 *   node out/debugAdapter.js --server=4711
 *-------------------------------------------------------------------------*/

import * as net from 'net';
import { AscendDebugSession } from './ascendDebugSession';

const serverArg = process.argv.find((a) => a.startsWith('--server='));

if (serverArg) {
	const port = Number(serverArg.split('=')[1]);
	net.createServer((socket) => {
		const session = new AscendDebugSession();
		session.setRunAsServer(true);
		session.start(socket, socket);
	}).listen(port, () => {
		process.stderr.write(`Ascend debug adapter listening on port ${port}\n`);
	});
} else {
	AscendDebugSession.run(AscendDebugSession);
}
