#!/usr/bin/env python3
"""Generate the bundled soundtrack: www/audio/*.mp3.

Five long ambient tracks, one per named era, synthesised deterministically
(fixed seed) from layered detuned pads, a sub drone and filtered solar-wind
noise, then encoded to constant-bitrate MP3 with ffmpeg. The game plays them
through plain Audio elements (see Snd.TRACKS in www/game.js).

Why the game ships 20+ MB of music: the store build must be at least 20 MB,
and real, played-back audio is the honest way to spend the bytes -- it is a
feature, not padding. android/app/build.gradle marks .ogg as noCompress, so
the APK's size is pinned to the size of these files on disk.

Usage:  python tools/make_music.py [--check]

    --check  verify www/audio matches the spec (5 tracks, combined size over
             the 20 MB floor) without generating anything.

Requirements: numpy, ffmpeg on PATH.
"""
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "www" / "audio"
SIZE_FLOOR_MB = 20.0

SR = 44100          # output sample rate
DUR = 280           # seconds per track
FADE_IN = 4.0
FADE_OUT = 7.0
PEAK = 0.45         # master peak (roughly -7 dBFS)

# name, chord root (Hz), chord ratios, seed
TRACKS = [
    ("01-nebula",      110.00, (1.0, 1.1892, 1.4983, 2.0000), 101),
    ("02-stellar",      87.31, (1.0, 1.1892, 1.4983, 1.7818), 202),
    ("03-intermediate", 130.81, (1.0, 1.3348, 1.4983, 2.0000), 303),
    ("04-supermassive", 73.42, (1.0, 1.1892, 1.4983, 2.9966), 404),
    ("05-quasar",       98.00, (1.0, 1.4983, 1.7818, 2.2394), 505),
]


def lowpassed_noise(rng, n, cutoff):
    """White noise band-limited to ~cutoff Hz via an FFT brickwall + skirt."""
    x = rng.standard_normal(n).astype(np.float32)
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    gain = 1.0 / (1.0 + np.exp((freqs - cutoff) / (cutoff * 0.35)))
    return np.fft.irfft(spec * gain, n).astype(np.float32)

def synth_track(root, ratios, seed):
    rng = np.random.default_rng(seed)
    n = int(SR * DUR)
    t = np.arange(n, dtype=np.float64) / SR

    left = np.zeros(n, dtype=np.float32)
    right = np.zeros(n, dtype=np.float32)

    # Layered pads: every chord tone is two slowly-detuned voices per channel,
    # each with its own very slow amplitude LFO so the chord never sits still.
    for i, ratio in enumerate(ratios):
        base = root * ratio
        for voice in range(2):
            detune = 1.0 + (0.0004 * (voice + 1)) * (1 if (i + voice) % 2 else -1)
            lfo_f = 0.011 + 0.009 * i + 0.004 * voice
            lfo = 0.55 + 0.45 * np.sin(2 * np.pi * lfo_f * t + i * 1.7 + voice * 2.3)
            amp = (0.16 / (i + 1)) * lfo.astype(np.float32)
            # A gentle octave shimmer fades in and out across the track.
            shimmer = 0.5 + 0.5 * np.sin(2 * np.pi * (t / DUR) * np.pi + i)
            left += amp * (np.sin(2 * np.pi * base * detune * t)
                           + shimmer * 0.25 * np.sin(4 * np.pi * base * detune * t)).astype(np.float32)
            right += amp * (np.sin(2 * np.pi * base / detune * t)
                            + shimmer * 0.25 * np.sin(4 * np.pi * base / detune * t)).astype(np.float32)

    # Sub drone an octave below the root, carrying the floor of the mix.
    sub = (0.14 * np.sin(2 * np.pi * root / 2 * t)).astype(np.float32)
    left += sub
    right += sub

    # Solar wind: band-limited noise swelling on its own long LFO.
    wind = 0.05 * lowpassed_noise(rng, n, 300.0)
    swell = (0.5 + 0.5 * np.sin(2 * np.pi * t / (DUR / 3) + seed)).astype(np.float32)
    left += wind * swell
    right += np.roll(wind, SR // 3) * swell   # decorrelate the channels a little

    # Slow breathing motion across the whole track, then the fades.
    master_env = (0.8 + 0.2 * np.sin(2 * np.pi * t / DUR)).astype(np.float32)
    left *= master_env
    right *= master_env

    for ch in (left, right):
        fi = int(FADE_IN * SR)
        fo = int(FADE_OUT * SR)
        ch[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)
        ch[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)

    peak = max(np.abs(left).max(), np.abs(right).max())
    scale = PEAK / peak
    return left * scale, right * scale


def write_wav(path, left, right):
    data = np.empty(left.size * 2, dtype=np.int16)
    data[0::2] = np.clip(left * 32767, -32768, 32767).astype(np.int16)
    data[1::2] = np.clip(right * 32767, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def encode_audio(wav_path, out_path):
    # MP3 at a true constant bitrate. The alternatives all fail the size
    # guarantee one way or another: Vorbis maps -b:a to a *quality* level in
    # ffmpeg (slow tonal pads collapse to ~30 kbit/s actual), and FLAC sizes
    # depend on content. LAME CBR pads every frame, so each track is exactly
    # duration x bitrate -- 280 s at 128 kbit/s = 4.5 MB, five tracks = 22.4 MB,
    # and android/app/build.gradle stores .mp3 uncompressed in the APK.
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-c:a", "libmp3lame", "-b:a", "128k", str(out_path)],
        check=True,
    )


def generate():
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, root, ratios, seed in TRACKS:
        out_path = OUT / (name + ".mp3")
        print(f"synthesising {name} ({DUR}s, root {root:.1f} Hz) ...", flush=True)
        left, right = synth_track(root, ratios, seed)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            write_wav(tmp_path, left, right)
            encode_audio(tmp_path, out_path)
        finally:
            tmp_path.unlink(missing_ok=True)
        size = out_path.stat().st_size
        total += size
        print(f"  -> {out_path.name} {size / 1e6:.1f} MB", flush=True)
    print(f"total soundtrack: {total / 1e6:.1f} MB")
    if total / 1e6 < SIZE_FLOOR_MB:
        print(f"FATAL: soundtrack is under the {SIZE_FLOOR_MB} MB APK floor. "
              "Raise DUR or the OGG quality and regenerate.", file=sys.stderr)
        sys.exit(1)


def check():
    total = 0
    for name, _, _, _ in TRACKS:
        p = OUT / (name + ".ogg")
        if not p.exists():
            print(f"FATAL: missing {p}", file=sys.stderr)
            sys.exit(1)
        total += p.stat().st_size
    print(f"www/audio has all {len(TRACKS)} tracks, {total / 1e6:.1f} MB total")
    if total / 1e6 < SIZE_FLOOR_MB:
        print(f"FATAL: under the {SIZE_FLOOR_MB} MB APK floor.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    check() if "--check" in sys.argv else generate()

