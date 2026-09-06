# Ascend C / CANN Debugger for VS Code

A Debug Adapter Protocol implementation that drives the CANN debugger from a
VS Code window running on Windows, aimed at bare-metal Ascend C operator tests.
The debugger can live in a WSL 2 distribution or inside a running Docker
container; both `ascend-gdb`/GDB and CANN 8.5's `msdebug-mi` are supported.

What you get:

- **GDB/MI transport** — the adapter speaks the machine interface over
  stdin/stdout with token-matched replies. No screen-scraping of console text.
- **Three execution modes** — `native`, `wsl`, `docker`. Docker composes
  *through* WSL when the engine lives in the distro rather than on Windows.
- **Arbitrary path mapping** — a bind mount is not `/mnt/<drive>`, so
  `sourceFileMap` maps any container root: `/tests` ⇄
  `D:\Projects\vllm-ascend\csrc\tests`.
- **Locals, arguments and registers** — built on GDB variable objects, so
  structs expand, large tensors page, and every value carries an `evaluateName`.
- **Native Hex Editor support** — variables and a synthetic *NPU Memory* scope
  carry a `memoryReference`, and `readMemory`/`writeMemory` are served from
  `-data-read-memory-bytes` / `-data-write-memory-bytes`.
- Conditional / function / instruction / data breakpoints, stepping by
  instruction, and a disassembly view.

## Quick start: CANN 8.5 container

This is the path verified end to end against `csrc/tests` in vllm-ascend.

**1. Build the tests with debug symbols.** The normal build is `Release` and
emits no DWARF at all, so nothing can be stepped. `scripts/build_tests_x86_debug.sh`
configures `-DCMAKE_BUILD_TYPE=Debug -g3 -O0` into a separate `/build-debug`
tree and installs to `~/simwork/out-debug`, leaving the Release artifacts alone:

```bash
wsl -d Ubuntu-22.04 -e bash ~/simwork/build_tests_x86_debug.sh
```

**2. Start a container that can actually be debugged.** Two flags matter:
without `SYS_PTRACE` and a relaxed seccomp profile the debugger cannot attach
to its own child, and the launch fails with `'A' packet returned an error: 8`.

```bash
wsl -d Ubuntu-22.04 -e docker run -d --name ascend-suites --cap-add=SYS_PTRACE --security-opt seccomp=unconfined -v "$HOME/simwork:/wsl:ro" -v "$HOME/simwork/accept:/out" -v /mnt/d/Projects/vllm-ascend/csrc/tests:/tests:ro cann85-cross-310p:latest sleep infinity
```

**3. Debug.** Open `D:\Projects\vllm-ascend` and run the
*Ascend: test_rmsnorm_310p (container)* configuration.

The debugger is CANN's `msdebug-mi`, an MI driver over LLDB 15 that reports
itself as "GNU gdb (GDB) 7.4". Every MI command this adapter uses is
implemented except `-data-write-memory-bytes`, which falls back to byte-wise
expression writes.

## Prerequisites

| Where | What |
| --- | --- |
| Windows host | VS Code 1.86+, Node 18+ (only to build the extension) |
| WSL 2 guest | Docker, or a CANN toolkit installed directly |
| Container | CANN toolkit with `msdebug-mi`, or any GDB build |

> On this machine the WSL distribution is `Ubuntu-22.04`, the Docker engine
> lives **inside** it (`/usr/bin/docker`, not on the Windows PATH), and the
> distro itself has neither CANN nor gdb — the toolkit exists only in the
> container image. That is why `execution.docker.viaWsl` defaults to true.

Check the debugger is reachable; this should print a version banner:

```bash
wsl -d Ubuntu-22.04 -e docker exec -i ascend-suites /usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi --version
```

## Build and run the extension

```bash
npm install && npm run compile
```

Press **F5** (*Run Extension*) to open an Extension Development Host on
`D:\Projects\vllm-ascend`, then start a configuration of type `ascend-gdb`.

```bash
npm test
```

Runs 44 tests: the MI grammar, the path mapper, the Docker/WSL command
builders, and an end-to-end pass that spawns the real adapter process, speaks
real DAP over stdio, and answers it with a fake MI debugger
(`src/test/fakeGdb.ts`).

## launch.json

```jsonc
{
  "type": "ascend-gdb",
  "request": "launch",
  "name": "Ascend: test_rmsnorm_310p (container)",

  "program": "/wsl/out-debug/test_rmsnorm_310p",
  "cwd": "/out",

  "execution": {
    "mode": "docker",
    "docker": { "containerName": "ascend-suites", "viaWsl": true }
  },
  "wsl": { "distro": "Ubuntu-22.04" },

  "gdbPath": "/usr/local/Ascend/cann-8.5.0/tools/msdebug/bin/msdebug-mi",
  "setupScript": "/usr/local/Ascend/ascend-toolkit/set_env.sh",

  "environment": [
    { "name": "ASCEND_HOME_PATH", "value": "/usr/local/Ascend/ascend-toolkit/latest" },
    { "name": "LD_LIBRARY_PATH",  "value": "/usr/local/Ascend/ascend-toolkit/latest/tools/simulator/Ascend310P3/lib:/usr/local/Ascend/ascend-toolkit/latest/lib64:/usr/local/Ascend/ascend-toolkit/latest/devlib" }
  ],

  "sourceFileMap": { "/tests": "D:\\Projects\\vllm-ascend\\csrc\\tests" },
  "stopAtEntry": true,
  "logging": { "engineLogging": true }
}
```

Key attributes:

| Attribute | Meaning |
| --- | --- |
| `program` | Binary to debug, as the guest sees it. |
| `execution.mode` | `wsl`, `docker` or `native`. Defaults to `wsl` (`native` when `wsl.enabled` is false). |
| `execution.docker.containerName` | Container to `docker exec` into. |
| `execution.docker.viaWsl` | Reach the docker CLI through `wsl.exe`. Required when the engine lives in the distro; `false` for Docker Desktop. |
| `wsl.distro` / `wsl.user` | Passed as `-d` / `-u`. |
| `wsl.enabled` | Legacy switch, still honoured: `false` means `native`. |
| `gdbPath` | Debugger inside the guest. Use an absolute path: `set_env.sh` rewrites `PATH`. |
| `setupScript` | Sourced in a login shell before the debugger starts. |
| `setupCommands` | MI (leading `-`) or console commands run before the program loads. |
| `miDebuggerServerAddress` | `host:port` of a gdbserver or simulator stub; switches to `-target-select remote`. |
| `sourceFileMap` | Guest prefix → host prefix. Longest match wins; falls back to `/mnt/<drive>`. |
| `pathTranslation` | `auto` (default), `on`, `off`. `auto` translates in every mode except plain `native`. |
| `memoryReferences` | `auto` (pointers/arrays/aggregates), `all`, `off`. |
| `npuMemoryRegions` | Named windows published in the *NPU Memory* scope. |
| `logging.engineLogging` | Echo the MI dialogue to the Debug Console. |
| `logging.trace` | Echo every DAP message. Only for working on the adapter itself. |

## Architecture

```
VS Code UI  ──DAP over stdio──▶  debugAdapter.js (own Node process)
                                        │
                                 AscendDebugSession
                                 ├── PathMapper          D:\…\tests ⇄ /tests
                                 ├── VarObjectManager    -var-create / -var-list-children
                                 └── MiConnection        token-matched MI commands
                                        │
                    wsl.exe -d Ubuntu-22.04 -e            ← host boundary
                      docker exec -i ascend-suites        ← container boundary
                        /bin/bash -lc ". set_env.sh; exec msdebug-mi --interpreter=mi2"
                                        │
                                msdebug-mi ⇄ test binary ⇄ CANN simulator
```

Each boundary is crossed with `-e` / `exec` rather than an intermediate shell,
so argv elements survive intact and need no quoting. The guest script is the
only place a shell is involved, and it exists to source `set_env.sh` and then
`exec` the debugger — which keeps the shell's PID as the debugger's PID, so
Pause has something to signal.

| Module | Responsibility |
| --- | --- |
| `src/debugAdapter.ts` | Process entry point. Also supports `--server=<port>` for debugging the adapter itself. |
| `src/extension.ts` | Extension-host side only: configuration defaults, WSL distro validation, two commands. Never touches the debugger. |
| `src/ascendDebugSession.ts` | The DAP implementation: lifecycle, breakpoints, execution, stack, variables, memory, disassembly. |
| `src/mi/miParser.ts` | Recursive-descent parser for the MI output grammar. Pure, no I/O. |
| `src/mi/miConnection.ts` | Spawns the debugger, frames stdout into records, routes replies back to the awaiting command by token. |
| `src/pathMapper.ts` | Pure string translation between host and guest paths. |
| `src/varObjects.ts` | Variable-object lifecycle and address resolution. |
| `src/wslLauncher.ts` | Command line for every execution mode, plus the guest shell wrapper. |
| `src/dockerLauncher.ts` | `docker exec` argv and its composition with the WSL hop. |

### Why variable objects rather than `-stack-list-variables --all-values`

The flat listing is one round trip, but it returns pre-rendered strings: no
children, no type, no path expression — and therefore no way to take an
address. Varobjs cost one `-var-create` per visible variable and give back
expandable structures, `-var-list-children` with a range (so a million-element
tensor is not serialised into the sidebar), and `-var-info-path-expression`,
which is what `memoryReference` is computed from. They are anchored to a frame,
so every varobj is deleted before the target resumes.

### How the memory viewer is wired

1. `initializeRequest` advertises `supportsReadMemoryRequest` and
   `supportsWriteMemoryRequest`.
2. Each variable gets a `memoryReference`. A pointer or array resolves to what
   it *points at* — inspecting a `__gm__ half *` should show the buffer, not the
   8 bytes holding the pointer — while anything else resolves to `&variable`.
   In `auto` mode only pointers, arrays and aggregates pay for the extra
   `-data-evaluate-expression` round trip.
3. Right-click the variable → **View Binary Data** opens VS Code's Hex Editor,
   which issues `readMemory`; the adapter answers from
   `-data-read-memory-bytes`, converting the hex blocks to base64.
4. The debugger returns one block per readable span. The adapter returns the
   contiguous run starting at the requested address and reports the remainder
   as `unreadableBytes`, so an unmapped hole in a UB window renders as `??`
   instead of failing the request.
5. Registers holding a non-zero address get a `memoryReference` too, and every
   entry in the *NPU Memory* scope is nothing but a name plus an address —
   which is what makes UB/L1/L0C openable without a variable to hang them on.

### Path mapping rules

Applied in order, longest match first:

1. Explicit `sourceFileMap` entries — the only rule that can express a bind
   mount such as `/tests`.
2. UNC form: `\\wsl$\Ubuntu-22.04\home\me\x` ⇄ `/home/me/x` (WSL mode only; a
   container path is not reachable through the distro's share).
3. DrvFs: `D:\Projects\x` ⇄ `/mnt/d/Projects/x`.

Host comparisons are case-insensitive (Windows semantics) and only whole path
segments match, so `D:\Projects\vllm-ascend-old` is never rewritten by a rule
for `D:\Projects\vllm-ascend`. A guest path with no matching rule is returned
unchanged rather than being invented into a `D:\` path that does not exist.

## Commands

| Command | Use |
| --- | --- |
| **Ascend: View NPU Memory Region…** | Resolve a configured region to a concrete address. |
| **Ascend: Send Raw GDB/MI Command…** | Talk to the debugger directly; `-`-prefixed input is raw MI. |

The Debug Console REPL takes the same input: plain text runs as a console
command, a leading `-` sends raw MI.

## Notes on msdebug-mi (CANN 8.5)

- It is lldb-mi, so some GDB behaviours differ. `-exec-run --start` means "stop
  at the loader's first instruction" rather than "stop at main", so
  `stopAtEntry` always uses a temporary breakpoint on `entryFunction` instead —
  which means the same thing to both debuggers.
- `-data-write-memory-bytes` is not implemented. `writeMemory` detects that
  once and falls back to byte-wise expression writes.
- Sourcing `set_env.sh` rewrites `PATH`, so `gdbPath` should be absolute.
- Debugging inside Docker needs `--cap-add=SYS_PTRACE` and a relaxed seccomp
  profile, or the launch fails with `'A' packet returned an error: 8`.

## Troubleshooting

**"The container … is not running"** — the adapter says so explicitly and
prints the `docker start` command. If the container was created with `--rm` it
no longer exists and must be re-created (see Quick start).

**Breakpoints stay hollow** — the binary has no DWARF, or the recorded source
root does not match `sourceFileMap`. Check both:

```bash
wsl -d Ubuntu-22.04 -e docker exec -i ascend-suites readelf --debug-dump=info /wsl/out-debug/test_rmsnorm_310p
```

`DW_AT_name` must be an absolute guest path such as
`/tests/kernels/test_rmsnorm_310p.cpp`; `sourceFileMap` maps its prefix.

**"Timed out waiting for the debugger prompt"** — turn on
`logging.engineLogging` to see the exact spawn line, then run it by hand.

**Pause does nothing** — Node cannot deliver SIGINT across the WSL or container
boundary, so the adapter falls back to `kill -INT` against the PID its shell
wrapper echoed, executed through the same `docker exec` chain.

## Limitations

- Device tests skip when no NPU is present (`aclInit` fails with `chipType=0`);
  the CPU reference tests still run and step normally.
- Disassembly assumes 4-byte fixed-width instructions when resolving a negative
  `instructionOffset`.
- Logpoints are not implemented (`supportsLogPoints: false`).
