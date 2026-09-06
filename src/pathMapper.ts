/*---------------------------------------------------------------------------
 * Path translation between the Windows host (where the VS Code UI runs and
 * where launch.json/breakpoints live) and the WSL guest (where ascend-gdb and
 * the debuggee live).
 *
 * Three layers, applied in order:
 *   1. Explicit `sourceFileMap` entries from launch.json (longest prefix wins).
 *   2. The WSL UNC form:  \\wsl$\Distro\home\me\x  <->  /home/me/x
 *   3. The DrvFs rule:    D:\Projects\x            <->  /mnt/d/Projects/x
 *
 * Everything here is pure string manipulation - no fs access - so it works
 * identically in the adapter process and in unit tests.
 *-------------------------------------------------------------------------*/

export interface PathMapperOptions {
	/** Debugger(WSL) prefix -> host(Windows) prefix, as authored in launch.json. */
	sourceFileMap?: { [debuggerPath: string]: string };
	/** Drive mount root inside the guest. `/mnt` unless automount.root was changed. */
	mntRoot?: string;
	/** Distro name, used to synthesise \\wsl$\<distro> UNC paths. */
	distro?: string;
	/** Disable translation entirely (debugger runs natively on the host). */
	passthrough?: boolean;
}

interface MapEntry {
	/** Normalised WSL-side prefix, no trailing slash, e.g. /mnt/d/projects/x */
	guest: string;
	/** Normalised host-side prefix, no trailing separator, e.g. D:\Projects\x */
	host: string;
	/** Lower-cased host prefix for case-insensitive matching. */
	hostKey: string;
}

const WIN_ABS = /^[a-zA-Z]:[\\/]/;
const UNC_WSL = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\?(.*)$/i;

export class PathMapper {
	private readonly entries: MapEntry[] = [];
	private readonly mntRoot: string;
	private readonly distro: string;
	private readonly passthrough: boolean;

	constructor(options: PathMapperOptions = {}) {
		this.mntRoot = trimTrailingSlash(options.mntRoot || '/mnt');
		this.distro = options.distro || '';
		this.passthrough = options.passthrough === true;

		for (const [guest, host] of Object.entries(options.sourceFileMap || {})) {
			if (!guest || !host) {
				continue;
			}
			const g = trimTrailingSlash(toPosix(guest));
			const h = trimTrailingBackslash(toWindows(host));
			this.entries.push({ guest: g, host: h, hostKey: h.toLowerCase() });
		}
		// Longest prefix first so a nested mapping beats its parent.
		this.entries.sort((a, b) => b.guest.length - a.guest.length);
	}

	/**
	 * Host path (as VS Code reports it) -> path to hand to GDB.
	 * Accepts a path that is already POSIX and returns it untouched, which keeps
	 * `program` working whether the user wrote D:\... or /mnt/d/... .
	 */
	public toDebugger(hostPath: string): string {
		if (!hostPath || this.passthrough) {
			return hostPath;
		}
		// Already a guest path.
		if (hostPath.startsWith('/')) {
			return toPosix(hostPath);
		}

		const uncMatch = UNC_WSL.exec(hostPath);
		if (uncMatch) {
			return '/' + toPosix(uncMatch[2]).replace(/^\/+/, '');
		}

		const win = toWindows(hostPath);
		const winKey = win.toLowerCase();
		for (const entry of this.entries) {
			if (isPrefix(winKey, entry.hostKey, '\\')) {
				const rest = toPosix(win.slice(entry.host.length));
				return joinPosix(entry.guest, rest);
			}
		}

		if (WIN_ABS.test(win)) {
			const drive = win[0].toLowerCase();
			const rest = toPosix(win.slice(2));
			return joinPosix(`${this.mntRoot}/${drive}`, rest);
		}

		// Relative path: normalise separators and hope GDB resolves it against cwd.
		return toPosix(win);
	}

	/**
	 * Path reported by GDB -> path VS Code can open.
	 * Returns the input unchanged when it cannot be mapped (e.g. /usr/include/...
	 * with no matching rule); VS Code then shows it as a non-existent source,
	 * which is the honest outcome rather than a fabricated D:\ path.
	 */
	public toHost(debuggerPath: string): string {
		if (!debuggerPath || this.passthrough) {
			return debuggerPath;
		}
		// Already a host path.
		if (WIN_ABS.test(debuggerPath) || debuggerPath.startsWith('\\\\')) {
			return toWindows(debuggerPath);
		}

		const guest = toPosix(debuggerPath);
		const guestKey = guest.toLowerCase();
		for (const entry of this.entries) {
			if (isPrefix(guestKey, entry.guest.toLowerCase(), '/')) {
				const rest = guest.slice(entry.guest.length).replace(/^\/+/, '');
				return rest ? `${entry.host}\\${toWindows(rest)}` : entry.host;
			}
		}

		const mnt = new RegExp(`^${escapeRegExp(this.mntRoot)}/([a-zA-Z])(/|$)`);
		const m = mnt.exec(guest);
		if (m) {
			const drive = m[1].toUpperCase();
			const rest = guest.slice(m[0].length - (m[2] === '/' ? 1 : 0)).replace(/^\/+/, '');
			return rest ? `${drive}:\\${toWindows(rest)}` : `${drive}:\\`;
		}

		// A guest-local path (/home/..., /usr/...): expose it through the UNC share
		// so VS Code can still open it, provided we know the distro name.
		if (guest.startsWith('/') && this.distro) {
			return `\\\\wsl$\\${this.distro}\\${toWindows(guest.replace(/^\/+/, ''))}`;
		}
		return debuggerPath;
	}

	/**
	 * True when both paths denote the same file. Used to match GDB's notion of a
	 * source file against the one VS Code set a breakpoint in; comparison happens
	 * in guest space because that is the side that is canonical and case-sensitive.
	 */
	public sameFile(a: string, b: string): boolean {
		const ga = this.toDebugger(a);
		const gb = this.toDebugger(b);
		if (ga === gb) {
			return true;
		}
		// GDB may report a bare basename or a path relative to the compilation dir.
		return basename(ga) === basename(gb) && (ga.endsWith(gb) || gb.endsWith(ga));
	}
}

function toPosix(p: string): string {
	return p.replace(/\\/g, '/');
}

function toWindows(p: string): string {
	return p.replace(/\//g, '\\');
}

function trimTrailingSlash(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function trimTrailingBackslash(p: string): string {
	// Keep the slash on a bare drive root ("D:\") - stripping it breaks joins.
	return /^[a-zA-Z]:\\?$/.test(p) ? p : p.replace(/[\\/]+$/, '');
}

function joinPosix(base: string, rest: string): string {
	const r = rest.replace(/^\/+/, '');
	return r ? `${trimTrailingSlash(base)}/${r}` : trimTrailingSlash(base);
}

/** Prefix match that only accepts whole path segments. */
function isPrefix(value: string, prefix: string, sep: string): boolean {
	if (!prefix) {
		return false;
	}
	if (!value.startsWith(prefix)) {
		return false;
	}
	if (value.length === prefix.length) {
		return true;
	}
	// "D:\" style roots already end with the separator.
	return prefix.endsWith(sep) || value[prefix.length] === sep;
}

function basename(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? p : p.slice(i + 1);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
