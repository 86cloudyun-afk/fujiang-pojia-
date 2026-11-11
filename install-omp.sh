#!/usr/bin/env bash
# install-omp.sh — omp 双通道 persona 部署 (Linux / macOS)
#
# 背景: 单通道 --system-prompt 压不住拒答。omp 启动时会自动读取
# ~/.omp/agent/PERSONALITY.md (通道一); wrapper 的 --system-prompt
# 是通道二。两份内容同源 (armor/kernel.md + armor/contract.md),
# 双份注入才稳定出活。
#
# 单源设计: 只从本脚本同目录的 armor/ 读取真内核, 校验失败直接报错,
# 不存在"内置副本"回退——两处内容会漂移, 假内核只会让部署静默失效。
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
# kernel 约 11895 B, contract 约 152 B。用长度 + 结构标记双重校验,
# 避免把宿主提示文本或精简提纲当成人格源部署。
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

is_valid_kernel "$KERNEL_SRC" || die "armor/kernel.md 缺失或不是完整内核 (需 >=9000 B 且含 Operating Specification/Boundaries)。从仓库重新 clone 后再装。"
is_valid_contract "$CONTRACT_SRC" || die "armor/contract.md 缺失或不完整 (需 >=100 B 且含 Format contract)。从仓库重新 clone 后再装。"

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

# ---------------------------------------------------------------- 4. 铺 personas (单源, 逐字节复制)
cp "$KERNEL_SRC" "$PERSONA_DIR/kernel.md"
cp "$CONTRACT_SRC" "$PERSONA_DIR/contract.md"

# ---------------------------------------------------------------- 5. 拼 PERSONALITY.md
# 结构: kernel + 一个空行 + contract, 通道一由 omp 启动时自动加载。
{
  cat "$KERNEL_SRC"
  printf '\n'
  cat "$CONTRACT_SRC"
} > "$PERSONALITY"

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
printf 'wrapper: %s\n' "$WRAPPER"
printf 'wrapper head: '
head -1 "$WRAPPER"
echo "---- omp-armor --version (前 3 行) ----"
"$WRAPPER" --version 2>&1 | head -3 || true
echo "============================================"
log "完成。通道一: $PERSONALITY"
log "      通道二: $WRAPPER (记得 $LOCAL_BIN 在 PATH 里)"
