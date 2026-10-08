#!/usr/bin/env bash
# Compare a converted video with the original recording.
#
#   scripts/compare_quality.sh ORIGINAL.MOV CONVERTED.mp4
#
# Prints the sizes, then PSNR and SSIM (higher is closer; PSNR above ~40 dB and SSIM above
# ~0.98 look the same to most people), and VMAF when your ffmpeg has libvmaf (above ~93 is
# generally indistinguishable). Both files are compared in display orientation.
set -u

if [ "$#" -ne 2 ]; then
  echo "usage: $0 ORIGINAL CONVERTED" >&2
  exit 2
fi
ORIG=$1
CONV=$2
FFMPEG=${FFMPEG_BIN:-ffmpeg}
for f in "$ORIG" "$CONV"; do
  [ -f "$f" ] || { echo "not a file: $f" >&2; exit 1; }
done

orig_bytes=$(wc -c < "$ORIG" | tr -d ' ')
conv_bytes=$(wc -c < "$CONV" | tr -d ' ')
awk -v a="$orig_bytes" -v b="$conv_bytes" 'BEGIN {
  printf "Original : %.1f MB\n", a / 1000000
  printf "Converted: %.1f MB (%.0f%% smaller)\n", b / 1000000, (1 - b / a) * 100
}'

align='[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]'
psnr=$("$FFMPEG" -hide_banner -nostdin -i "$CONV" -i "$ORIG" -lavfi "${align}psnr" -f null - 2>&1 \
  | grep -o 'average:[0-9.inf]*' | tail -1)
ssim=$("$FFMPEG" -hide_banner -nostdin -i "$CONV" -i "$ORIG" -lavfi "${align}ssim" -f null - 2>&1 \
  | grep -o 'All:[0-9.]*' | tail -1)
vmaf=$("$FFMPEG" -hide_banner -nostdin -i "$CONV" -i "$ORIG" -lavfi "${align}libvmaf" -f null - 2>&1 \
  | grep -o 'VMAF score: [0-9.]*' | tail -1)

[ -n "$psnr" ] && printf 'PSNR     : %.2f dB\n' "${psnr#average:}"
[ -n "$ssim" ] && printf 'SSIM     : %.4f\n' "${ssim#All:}"
if [ -n "$vmaf" ]; then
  printf 'VMAF     : %.2f\n' "${vmaf#VMAF score: }"
else
  echo "VMAF     : not available (needs an ffmpeg built with libvmaf; PSNR and SSIM are still valid)"
fi
