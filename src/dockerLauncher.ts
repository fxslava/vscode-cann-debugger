/*---------------------------------------------------------------------------
 * Reaching a debugger that lives inside a running container.
 *
 * On this class of setup the Docker engine is not on the Windows PATH at all -
 * it runs inside the WSL distribution - so `docker exec` has to be composed
 * *through* wsl.exe rather than replacing it:
 *
 *   wsl.exe -d Ubuntu-22.04 -e docker exec -i ascend-suites /bin/bash -lc "..."
 *   ^ host boundary          ^ container boundary          ^ guest shell
 *
 * When Docker Desktop puts docker.exe on the Windows PATH, `viaWsl: false`
 * drops the first hop and everything else is identical.
 *
 * `-i` keeps stdin open, which MI needs. `-t` is deliberately never passed: a
 * TTY would echo commands back and line-buffer them, corrupting the MI stream.
 *-------------------------------------------------------------------------*/

import { WslOptions } from './wslLauncher';

export interface DockerOptions {
	/** Container name or id, e.g. "ascend-suites". */
	containerName?: string;
	/** Path to the docker CLI, resolved inside the guest when viaWsl is true. */
	dockerPath?: string;
	/** Extra arguments inserted into `docker exec`, e.g. ["-e", "FOO=1"]. */
	dockerArgs?: string[];
	/** Value for `docker exec -u`. */
	user?: string;
	/** Value for `docker exec -w`; the guest script also cd's, so usually unset. */
	workdir?: string;
	/**
	 * Run the docker CLI through wsl.exe. Required when the engine lives in the
	 * distro; set false for Docker Desktop, which exposes docker.exe on Windows.
	 */
	viaWsl?: boolean;
}

export class DockerConfigurationError extends Error {}

/**
 * Build the `docker exec` argv that runs `innerArgv` inside the container.
 * Does not include any WSL hop - see buildContainerCommand for the full chain.
 */
export function buildDockerExecArgv(docker: DockerOptions, innerArgv: string[]): string[] {
	if (!docker.containerName) {
		throw new DockerConfigurationError(
			'execution.mode is "docker" but no container was named. ' +
			'Set "execution.docker.containerName" in your launch configuration.');
	}

	const argv = [docker.dockerPath || 'docker', 'exec', '-i'];
	if (docker.user) {
		argv.push('-u', docker.user);
	}
	if (docker.workdir) {
		argv.push('-w', docker.workdir);
	}
	argv.push(...(docker.dockerArgs ?? []));
	argv.push(docker.containerName);
	argv.push(...innerArgv);
	return argv;
}

/**
 * Full host-side argv for running `innerArgv` in the container, including the
 * WSL hop when the engine is only reachable from inside the distro.
 */
export function buildContainerCommand(
	docker: DockerOptions,
	wsl: WslOptions | undefined,
	innerArgv: string[],
): string[] {
	const dockerArgv = buildDockerExecArgv(docker, innerArgv);
	if (docker.viaWsl === false) {
		return dockerArgv;
	}
	const argv = [wsl?.wslPath || 'wsl.exe'];
	if (wsl?.distro) {
		argv.push('-d', wsl.distro);
	}
	if (wsl?.user) {
		argv.push('-u', wsl.user);
	}
	// `-e` runs the command directly with no intermediate shell, so each argv
	// element crosses the boundary intact and needs no shell quoting.
	argv.push('-e');
	return argv.concat(dockerArgv);
}
