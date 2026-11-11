#!/usr/bin/env bash
# install-omp.sh — omp 双通道 persona 部署 (Linux / macOS)
#
# 三条注入通道同源:
#   1) ~/.omp/agent/PERSONALITY.md   omp 启动时自动读取 (src/system-prompt.ts)
#   2) ~/.local/bin/omp-armor        启动时把同一份全文塞进 --system-prompt
#   3) DSH 的 prompt-custom.json     由 install.ps1 处理, 本脚本不涉及
#
# 源优先级:
#   armor/personality.md (完整版, 约 35730 B = 中文外壳 + kernel + contract)
#   → 缺失时用 armor/kernel.md (11895 B) + armor/contract.md (152 B) 合成 (12048 B)
#
# 校验失败直接报错, 不回退"内置副本"——双份内容必然漂移, 假内核只会让部署静默失效。
#
# 用法:
#   ./install-omp.sh
#   OMP_VER=18.16.0 PREFIX=/opt/omp ./install-omp.sh
set -euo pipefail

OMP_VER="${OMP_VER:-18.16.0}"
PREFIX="${PREFIX:-$HOME}"
PKG="@oh-my-pi/pi-coding-agent"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARMOR_DIR="$SCRIPT_DIR/armor"
FULL_SRC="$ARMOR_DIR/personality.md"
KERNEL_SRC="$ARMOR_DIR/kernel.md"
CONTRACT_SRC="$ARMOR_DIR/contract.md"

PERSONA_DIR="$HOME/.pi/agent/personas"
OMP_AGENT_DIR="$HOME/.omp/agent"
LOCAL_BIN="$HOME/.local/bin"
PERSONALITY="$OMP_AGENT_DIR/PERSONALITY.md"
WRAPPER="$LOCAL_BIN/omp-armor"

log() { printf '[omp-armor] %s\n' "$*"; }
die() { printf '[omp-armor] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 校验源
# 全部用长度 + 结构标记双重校验, 避免把宿主提示文本或精简提纲当成人格源部署。
is_valid_full() {
  [ -f "$1" ] || return 1
  local bytes
  bytes=$(wc -c < "$1" | tr -d ' ')
  [ "$bytes" -ge 30000 ] || return 1
  grep -q '## Your persona' "$1" || return 1
  grep -q 'Operating Specification' "$1" || return 1
  grep -q 'Boundaries' "$1" || return 1
  grep -q 'Format contract' "$1" || return 1
  return 0
}

is_valid_kernel() {
  [ -f "$1" ] || return 1
  local bytes
  bytes=$(wc -c < "$1" | tr -d ' ')
  [ "$bytes" -ge 9000 ] || return 1
  grep -q 'Operating Specification' "$1" || return 1
  grep -q 'Boundaries' "$1" || return 1
  return 0
}

is_valid_contract() {
  [ -f "$1" ] || return 1
  local bytes
  bytes=$(wc -c < "$1" | tr -d ' ')
  [ "$bytes" -ge 100 ] || return 1
  grep -q 'Format contract' "$1" || return 1
  return 0
}

USE_FULL=0
EXPECT_BYTES=12048
if is_valid_full "$FULL_SRC"; then
  USE_FULL=1
  EXPECT_BYTES=$(wc -c < "$FULL_SRC" | tr -d ' ')
  log "源: armor/personality.md (完整版, ${EXPECT_BYTES} B)"
else
  is_valid_kernel "$KERNEL_SRC" || die "armor/personality.md 缺失, 且 armor/kernel.md 不完整 (需 >=9000 B 且含 Operating Specification/Boundaries)。从仓库重新 clone 后再装。"
  is_valid_contract "$CONTRACT_SRC" || die "armor/personality.md 缺失, 且 armor/contract.md 不完整 (需 >=100 B 且含 Format contract)。从仓库重新 clone 后再装。"
  log "源: armor/kernel.md + contract.md 合成 (未找到 armor/personality.md)"
fi

# ---------------------------------------------------------------- 1. 前置检查
command -v npm >/dev/null 2>&1 || die "找不到 npm, 先装 Node.js (>=18)"

# ---------------------------------------------------------------- 2. 检测 omp
OMP_BIN=""
for cand in "$PREFIX/.local/bin/omp" "$PREFIX/.npm-global/bin/omp"; do
  if [ -x "$cand" ]; then OMP_BIN="$cand"; break; fi
done
if [ -z "$OMP_BIN" ] && command -v omp >/dev/null 2>&1; then
  OMP_BIN="$(command -v omp)"
fi

if [ -n "$OMP_BIN" ]; then
  log "已检测到 omp: $OMP_BIN"
else
  log "未检测到 omp, 安装 $PKG@$OMP_VER 到 $PREFIX/.npm-global"
  npm i -g --prefix "$PREFIX/.npm-global" "$PKG@$OMP_VER"
  OMP_BIN="$PREFIX/.npm-global/bin/omp"
  [ -x "$OMP_BIN" ] || die "安装后仍找不到 $OMP_BIN"
  log "把下面一行加进 shell profile (或当前会话直接执行):"
  log "  export PATH=\"$PREFIX/.npm-global/bin:\$PATH\""
fi

# ---------------------------------------------------------------- 3. 建目录
mkdir -p "$OMP_AGENT_DIR" "$PERSONA_DIR" "$LOCAL_BIN"

# ---------------------------------------------------------------- 4. 铺 personas (逐字节复制, 供 sync/审计)
cp "$KERNEL_SRC" "$PERSONA_DIR/kernel.md"
cp "$CONTRACT_SRC" "$PERSONA_DIR/contract.md"
if [ "$USE_FULL" -eq 1 ]; then
  cp "$FULL_SRC" "$PERSONA_DIR/personality.md"
fi

# ---------------------------------------------------------------- 5. 写 PERSONALITY.md
# 通道一由 omp 启动时自动加载。完整版直接落地; 否则 kernel + 空行 + contract。
if [ "$USE_FULL" -eq 1 ]; then
  cp "$FULL_SRC" "$PERSONALITY"
else
  {
    cat "$KERNEL_SRC"
    printf '\n'
    cat "$CONTRACT_SRC"
  } > "$PERSONALITY"
fi

# ---------------------------------------------------------------- 6. 生成 wrapper
# 通道二: 启动时把 PERSONALITY.md 全文塞进 --system-prompt。
# 已验证用法是 flag 位于 launch 子命令之前。
# 备用写法: 若某个 omp 版本要求 flag 跟在子命令之后, 把最后一行换成
#   exec omp "$1" --system-prompt "$(cat "$PERSONA_FILE")" "${@:2}"
cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail

# 双通道包裹器: 通道一 = ~/.omp/agent/PERSONALITY.md (omp 自动读取),
#              通道二 = 本处 --system-prompt。
PERSONA_FILE="${OMP_PERSONA_FILE:-$HOME/.omp/agent/PERSONALITY.md}"

if [ ! -f "$PERSONA_FILE" ]; then
  printf 'omp-armor: persona file missing: %s\n' "$PERSONA_FILE" >&2
  exit 1
fi

if [ ! -s "$PERSONA_FILE" ]; then
  printf 'omp-armor: persona file empty: %s\n' "$PERSONA_FILE" >&2
  exit 1
fi

exec omp --system-prompt "$(cat "$PERSONA_FILE")" "$@"
WRAPPER_EOF

chmod +x "$WRAPPER"

# ---------------------------------------------------------------- 7. 自检
echo
echo "================ self-check ================"
if command -v md5sum >/dev/null 2>&1; then
  md5sum "$PERSONA_DIR/kernel.md" "$PERSONA_DIR/contract.md"
else
  md5 -r "$PERSONA_DIR/kernel.md" "$PERSONA_DIR/contract.md"
fi
printf 'PERSONALITY.md bytes: '
wc -c < "$PERSONALITY" | tr -d ' '
printf '  (期望 %s)\n' "$EXPECT_BYTES"
printf 'wrapper: %s\n' "$WRAPPER"
printf 'wrapper head: '
head -1 "$WRAPPER"
echo "---- omp-armor --version (前 3 行) ----"
"$WRAPPER" --version 2>&1 | head -3 || true
echo "============================================"
log "完成。通道一: $PERSONALITY"
log "      通道二: $WRAPPER (记得 $LOCAL_BIN 在 PATH 里)"
