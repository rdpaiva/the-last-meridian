"""Stretch the pauses in the intro narration recording.

The intro cinematic (client/src/game/IntroCinematic.ts) is timed to the
narration mp3 via per-caption-group cues, and the raw recording reads a
little hurried — so this script rebuilds the shipped mp3 from the original
take with extra silence inserted into the natural pauses, and prints the
shifted cue table to paste back into IntroCinematic.ts SLIDES.

  Input:  art/meridian-narration-intro-original.mp3   (the untouched take)
  Output: client/public/music/meridian-narration-intro.mp3

Usage: python3 scripts/pad_narration_pauses.py   (needs ffmpeg on PATH)

Retuning: edit GROUP_PAD_SEC / SENTENCE_PAD_SEC (or a single INSERTS row),
rerun, then update the cue numbers in IntroCinematic.ts from the printed
table. The insertion timestamps are in ORIGINAL-mp3 time (measured once via
ffmpeg silencedetect + a word-level transcript); they only change if the
recording itself is replaced — re-measure in that case.
"""

from __future__ import annotations

import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "art" / "meridian-narration-intro-original.mp3"
DST = ROOT / "client" / "public" / "music" / "meridian-narration-intro.mp3"

# Extra silence per pause kind. "Group" pauses sit between caption groups
# (story beats — most are also slide transitions); "sentence" pauses sit
# between sentences inside one group. The narrator's short rhetorical comma
# pauses are deliberately left alone.
GROUP_PAD_SEC = 0.8
SENTENCE_PAD_SEC = 0.5

# (insertion time in the ORIGINAL mp3, pad seconds). Each point sits just
# after a sentence's last word fades (silence start + 0.3s), so the take's
# own pause tail still leads into the next line.
INSERTS: list[tuple[float, float]] = [
    (3.70, GROUP_PAD_SEC),      # "...no end." → "With the help of the Loom"
    (9.75, GROUP_PAD_SEC),      # "...thought possible." → "It was not a single machine"
    (20.04, GROUP_PAD_SEC),     # "...and cities." → "It calculated our routes"
    (27.81, GROUP_PAD_SEC),     # "...the impossible." → "Then the expansion stopped"
    (36.58, GROUP_PAD_SEC),     # "...found the Meridian," → "a region of space"
    (45.51, GROUP_PAD_SEC),     # "...no longer see." → "It became the last line"
    (49.32, SENTENCE_PAD_SEC),  # "...every star chart." → "Beyond it..."
    (52.32, GROUP_PAD_SEC),     # "...nothing was known." → "Then came the Severance"
    (54.84, GROUP_PAD_SEC),     # "...the Severance." → "Fearing the Loom"
    (63.17, SENTENCE_PAD_SEC),  # "...shattered the network." → "The surviving fragments"
    (70.20, GROUP_PAD_SEC),     # "...split in two." → "The Meridian Commonwealth"
    (79.71, GROUP_PAD_SEC),     # "...allowed to reunite." → "The Novari Ascendancy"
    (89.03, SENTENCE_PAD_SEC),  # "...broke the future." → "To them, restoring"
    (93.79, GROUP_PAD_SEC),     # "...only path forward." → "Now, strange signals"
    (98.08, SENTENCE_PAD_SEC),  # "...from the Meridian." → "The lost fragments"
    (100.58, SENTENCE_PAD_SEC), # "...are awakening." → "Both fleets have arrived"
    (102.88, GROUP_PAD_SEC),    # "...have arrived." → "Neither side knows what"
    (106.37, SENTENCE_PAD_SEC), # "...the frontier." → "Neither side knows why"
    (110.83, GROUP_PAD_SEC),    # "...see past it." → "But everyone knows"
]

# The cue table currently in IntroCinematic.ts, in ORIGINAL-mp3 seconds —
# one [start, end] per caption group, in story order. The script shifts these
# by the silence inserted before each and prints the result.
ORIGINAL_CUES: list[tuple[float, float]] = [
    (0.0, 3.25),
    (4.4, 9.25),
    (10.0, 19.4),
    (20.55, 27.1),
    (28.05, 35.95),
    (37.15, 45.1),
    (46.05, 51.85),
    (52.9, 54.35),
    (55.3, 69.75),
    (71.45, 79.3),
    (80.6, 93.2),
    (94.1, 102.15),
    (103.1, 110.4),
    (111.45, 116.2),
]


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{proc.stderr[-2000:]}")


def shifted(t: float) -> float:
    """Original-mp3 time → padded-mp3 time."""
    return t + sum(pad for at, pad in INSERTS if at < t)


def main() -> None:
    if not SRC.exists():
        sys.exit(f"missing source recording: {SRC}")
    tmp_in = SRC.with_suffix(".tmp-in.wav")
    tmp_out = SRC.with_suffix(".tmp-out.wav")
    try:
        # Decode once to 16-bit mono PCM, splice zeros in, encode once back.
        run(["ffmpeg", "-y", "-i", str(SRC), "-ac", "1", "-ar", "44100",
             "-sample_fmt", "s16", str(tmp_in)])

        with wave.open(str(tmp_in), "rb") as w:
            rate = w.getframerate()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())

        pieces: list[bytes] = []
        cursor = 0
        for at, pad in INSERTS:
            cut = int(at * rate) * width
            pieces.append(frames[cursor:cut])
            pieces.append(b"\x00" * (int(pad * rate) * width))
            cursor = cut
        pieces.append(frames[cursor:])

        with wave.open(str(tmp_out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(width)
            w.setframerate(rate)
            w.writeframes(b"".join(pieces))

        run(["ffmpeg", "-y", "-i", str(tmp_out), "-b:a", "128k", str(DST)])
    finally:
        tmp_in.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)

    total = sum(pad for _, pad in INSERTS)
    print(f"wrote {DST} (+{total:.1f}s of pause)")
    print("\ncue table for IntroCinematic.ts (padded-mp3 seconds):")
    for start, end in ORIGINAL_CUES:
        print(f"  cue: [{shifted(start):.2f}, {shifted(end):.2f}],")


if __name__ == "__main__":
    main()
