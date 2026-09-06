// @ts-check
/*
 * Ascend NPU Target Manager - webview side.
 *
 * Holds no state of its own beyond the form: the extension owns the target and
 * the secret. The password box is write-only - it is posted once, stored in
 * SecretStorage, and then cleared. The extension never sends a password back,
 * only whether one exists.
 */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	/** Fields whose value maps 1:1 onto an AscendTarget property. */
	const FIELDS = [
		['mode', 'string'],
		['program', 'string'],
		['args', 'string'],
		['stopAtEntry', 'boolean'],
		['host', 'string'],
		['port', 'number'],
		['username', 'string'],
		['deployPath', 'string'],
		['identityFile', 'string'],
		['containerName', 'string'],
		['dockerViaWsl', 'boolean'],
		['wslDistro', 'string'],
		['gdbPath', 'string'],
		['setupScript', 'string'],
		['updateLaunchJson', 'boolean'],
	];

	const el = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
	const statusEl = document.getElementById('status');
	const passwordEl = el('password');
	const secretStateEl = document.getElementById('secretState');

	let busy = false;

	function readForm() {
		const target = {};
		for (const [name, kind] of FIELDS) {
			const node = el(name);
			if (!node) {
				continue;
			}
			if (kind === 'boolean') {
				target[name] = node.checked;
			} else if (kind === 'number') {
				const n = parseInt(node.value, 10);
				target[name] = Number.isFinite(n) ? n : 0;
			} else {
				target[name] = node.value;
			}
		}
		return target;
	}

	function writeForm(target) {
		for (const [name, kind] of FIELDS) {
			const node = el(name);
			if (!node || !(name in target)) {
				continue;
			}
			if (kind === 'boolean') {
				node.checked = !!target[name];
			} else {
				node.value = String(target[name] ?? '');
			}
		}
		applyMode();
	}

	/** Show only the group that the selected execution mode can use. */
	function applyMode() {
		const hardware = el('mode').value === 'hardware';
		document.getElementById('hardwareGroup').hidden = !hardware;
		document.getElementById('dockerGroup').hidden = hardware;
		el('deployAndDebug').textContent = hardware ? 'Deploy & Debug' : 'Debug in Simulator';
	}

	function setSecretState(hasPassword) {
		secretStateEl.textContent = hasPassword
			? 'A password is stored for this account.'
			: 'No password stored. Leave blank to use key authentication.';
		secretStateEl.classList.toggle('stored', !!hasPassword);
		el('clearPassword').disabled = !hasPassword;
	}

	function setStatus(level, text) {
		if (!text) {
			statusEl.hidden = true;
			return;
		}
		statusEl.hidden = false;
		statusEl.className = level || '';
		statusEl.textContent = text;
	}

	function setBusy(value) {
		busy = value;
		for (const id of ['deployAndDebug', 'save', 'testConnection', 'clearPassword']) {
			el(id).disabled = value;
		}
		if (!value) {
			// Re-derive rather than blanket-enable: the clear button stays off
			// when there is nothing stored to clear.
			setSecretState(secretStateEl.classList.contains('stored'));
		}
	}

	/**
	 * Post the form plus, if the box is non-empty, the password. Sending it
	 * separately from the target keeps it out of anything that gets persisted.
	 */
	function post(type) {
		if (busy) {
			return;
		}
		const message = { type, target: readForm() };
		if (passwordEl.value) {
			message.password = passwordEl.value;
			passwordEl.value = '';
		}
		vscode.setState({ target: message.target });
		vscode.postMessage(message);
	}

	document.getElementById('mode').addEventListener('change', applyMode);

	el('deployAndDebug').addEventListener('click', () => post('deployAndDebug'));
	el('save').addEventListener('click', () => post('save'));
	el('testConnection').addEventListener('click', () => post('testConnection'));
	el('clearPassword').addEventListener('click', () => {
		passwordEl.value = '';
		vscode.postMessage({ type: 'clearPassword', target: readForm() });
	});
	el('browseProgram').addEventListener('click', () =>
		vscode.postMessage({ type: 'browseProgram' }));
	el('browseIdentityFile').addEventListener('click', () =>
		vscode.postMessage({ type: 'browseIdentityFile' }));

	// Enter anywhere in the form is the primary action, as in a native dialog.
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			post('deployAndDebug');
		}
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'init':
				writeForm(message.target);
				setSecretState(message.hasPassword);
				setStatus(message.level, message.text);
				setBusy(false);
				break;
			case 'patch':
				writeForm({ ...readForm(), ...message.target });
				break;
			case 'secretState':
				setSecretState(message.hasPassword);
				break;
			case 'status':
				setStatus(message.level, message.text);
				break;
			case 'busy':
				setBusy(message.value);
				break;
		}
	});

	// Restore the in-flight edits when the view is re-created after being
	// hidden, then ask the extension for the authoritative state.
	const previous = vscode.getState();
	if (previous && previous.target) {
		writeForm(previous.target);
	}
	vscode.postMessage({ type: 'ready' });
})();
