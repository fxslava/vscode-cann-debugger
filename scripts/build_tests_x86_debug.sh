#!/usr/bin/env bash
# Debug build of csrc/tests: same pipeline as build_tests_x86.sh, but compiled
# with -g -O0 so the binaries carry DWARF and can be stepped in VS Code.
#
# Deliberately non-destructive: configures into /build-debug and installs to
# $HOME/simwork/out-debug, leaving the Release artifacts in out/ untouched.
# Inside a container that mounts $HOME/simwork at /wsl these appear as
# /wsl/out-debug.
set -euo pipefail

W="$HOME/simwork"
DEPS="$HOME/aarch64-offline/deps/builder-x86_64"
mkdir -p "$W/out-debug" "$W/probe"
tr -d '\r' < /mnt/d/Projects/docker-cann-cross-compile-toolkit-aarch64/common/patches/soc_shim.c \
    > "$W/probe/soc_shim.c"

cat > "$W/probe/build_inner_debug.sh" <<'INNER'
set -euo pipefail
TK=/usr/local/Ascend/ascend-toolkit/latest
SIM="$TK/tools/simulator/Ascend310P3/lib"

echo "############ 1. stage the 310P operator package into the toolkit"
cp -a /payload/kernels-310p/lib64/. "$TK/lib64/"
cp -a /payload/kernels-310p/opp/.   "$TK/opp/"
chmod 0755 "$TK"/lib64/libopapi*.so
ldconfig
test -f "$TK/lib64/libopapi.so"

echo
echo "############ 2. simulator wiring"
mkdir -p /opt/ascend-sim/lib
gcc -m64 -shared -fPIC -O2 -Wall -Wextra -Werror \
    -o /opt/ascend-sim/lib/libsocshim.so /work/soc_shim.c
ln -sf "$SIM/libruntime_camodel.so" /opt/ascend-sim/lib/libruntime.so

echo
echo "############ 3. configure csrc/tests (Debug, -g3 -O0)"
export ASCEND_HOME_PATH="$TK"
export LD_LIBRARY_PATH="$TK/lib64:$TK/devlib"
cmake -B /build-debug -S /tests \
    -DCMAKE_BUILD_TYPE=Debug \
    -DCMAKE_C_FLAGS_DEBUG="-g3 -O0 -fno-omit-frame-pointer" \
    -DCMAKE_CXX_FLAGS_DEBUG="-g3 -O0 -fno-omit-frame-pointer" \
    -DASCEND_HOME_PATH="$TK" \
    -DSOC_VERSION=Ascend310P3 \
    -DVLLM_ASCEND_TESTS_BUILD_BENCHMARKS=OFF \
    -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=/opt/googletest \
    2>&1 | tail -12

echo
echo "############ 4. build"
cmake --build /build-debug -j"$(nproc)" 2>&1 | tail -8

echo
echo "############ 5. install to /out BEFORE any verification"
# Ordering matters: an empty grep under `set -o pipefail` aborts the script,
# so nothing that can legitimately find nothing may run before this copy.
cp -a /build-debug/test_*310p /out/
cp -a /build-debug/test_benchmark_harness /out/ 2>/dev/null || true
ls -l /out | sed 's/^/  /'

echo
echo "############ 6. verify DWARF"
B=/build-debug/test_rmsnorm_310p
echo "  ELF:       $(file -b "$B" | cut -d, -f1-2)"
echo "  sections:  $(readelf -S "$B" | grep -c '\.debug_' || true) debug sections"
echo "  comp_dir:  $(readelf --debug-dump=info "$B" 2>/dev/null | grep -m1 DW_AT_comp_dir | sed 's/.*): *//' || true)"
echo "  test source in line table:"
readelf --debug-dump=decodedline "$B" 2>/dev/null \
    | grep -m3 -E 'test_rmsnorm_310p\.cpp' | sed 's/^/    /' || true
INNER

docker run --rm --name ascend-sim-build-debug \
    -v "$W/probe:/work:ro" \
    -v "$DEPS:/payload:ro" \
    -v /mnt/d/Projects/vllm-ascend/csrc/tests:/tests:ro \
    -v "$W/googletest:/opt/googletest:ro" \
    -v "$W/out-debug:/out" \
    cann85-cross-310p:latest bash /work/build_inner_debug.sh 2>&1
