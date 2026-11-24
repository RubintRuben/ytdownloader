"""Wallpaper Engine "scene" wallpapers rebuilt for the app's own WebGL renderer.

scene.pkg is unpacked, the main image layer and its flow map are decoded from the
engine's .tex format, and the common effects (water flow, shine) and particle
presets (fog, dust, light shafts, leaves, shooting stars, rain, snow) are mapped to
the app's built-in versions. Everything is pure Python, so it also works in the EXE.
"""
from __future__ import annotations

import json
import shutil
import struct
import zlib
from pathlib import Path

FREEIMAGE_EXT = {0: ".bmp", 2: ".jpg", 13: ".png", 17: ".tga", 25: ".gif", 35: ".webp"}
PARTICLE_KINDS = [
    ("shootingstar", "stars"), ("trail", "trails"), ("light_shaft", "shafts"), ("lightshaft", "shafts"),
    ("godray", "shafts"), ("fog", "fog"), ("mist", "fog"), ("smoke", "fog"), ("dust", "dust"), ("mote", "dust"),
    ("firefl", "dust"), ("leaves", "leaves"), ("leaf", "leaves"), ("petal", "leaves"), ("rain", "rain"),
    ("snow", "snow"), ("spark", "dust"), ("star", "stars"),
]


# --- containers ----------------------------------------------------------------

def read_pkg(path: Path) -> dict[str, bytes]:
    data = path.read_bytes()
    pos = 0

    def u32():
        nonlocal pos
        value = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        return value

    def text():
        nonlocal pos
        size = u32()
        value = data[pos:pos + size].decode("utf-8", "replace")
        pos += size
        return value

    text()  # PKGV version
    entries = [(text(), u32(), u32()) for _ in range(u32())]
    base = pos
    return {name: data[base + offset: base + offset + length] for name, offset, length in entries}


def lz4_block(src: bytes, size: int) -> bytes:
    """Minimal LZ4 block decoder (the .tex payload compression)."""
    out = bytearray()
    i = 0
    n = len(src)
    while i < n:
        token = src[i]
        i += 1
        literal = token >> 4
        if literal == 15:
            while True:
                extra = src[i]
                i += 1
                literal += extra
                if extra != 255:
                    break
        out += src[i:i + literal]
        i += literal
        if i >= n:
            break
        offset = src[i] | src[i + 1] << 8
        i += 2
        match = token & 15
        if match == 15:
            while True:
                extra = src[i]
                i += 1
                match += extra
                if extra != 255:
                    break
        match += 4
        start = len(out) - offset
        if offset >= match:
            out += out[start:start + match]
        else:
            for k in range(match):
                out.append(out[start + k])
    return bytes(out[:size])


def png_bytes(width: int, height: int, rgba: bytes, channels: int = 4) -> bytes:
    color_type = {1: 0, 2: 4, 3: 2, 4: 6}[channels]
    stride = width * channels
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(tag, payload):
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def decode_tex(blob: bytes) -> tuple[str, bytes, tuple[int, int]] | None:
    """.tex → (extension, file bytes, (image width, image height)); None for GPU-compressed formats."""
    if not blob.startswith(b"TEXV"):
        return None
    pos = blob.index(b"TEXI") + 9
    fmt, _flags, _tw, _th, iw, ih, _unk = struct.unpack_from("<7i", blob, pos)
    pos += 28
    container = blob[pos:pos + 8].decode("ascii", "replace")
    pos += 9
    count = struct.unpack_from("<i", blob, pos)[0]
    pos += 4
    free_image = -1
    if container in ("TEXB0003", "TEXB0004"):
        free_image = struct.unpack_from("<i", blob, pos)[0]
        pos += 4
        if container == "TEXB0004":
            pos += 4
    if count < 1:
        return None
    mips = struct.unpack_from("<i", blob, pos)[0]
    pos += 4
    width, height = struct.unpack_from("<2i", blob, pos)
    pos += 8
    compressed, raw_size = 0, 0
    if container != "TEXB0001":
        compressed, raw_size = struct.unpack_from("<2i", blob, pos)
        pos += 8
    size = struct.unpack_from("<i", blob, pos)[0]
    pos += 4
    payload = blob[pos:pos + size]
    if compressed:
        payload = lz4_block(payload, raw_size)
    del mips
    if free_image in FREEIMAGE_EXT:
        return FREEIMAGE_EXT[free_image], payload, (iw or width, ih or height)
    channels = {0: 4, 8: 2, 9: 1}.get(fmt)
    if not channels or len(payload) < width * height * channels:
        return None   # DXT and other GPU formats are not decoded here
    if channels == 2:  # RG88 → RGB so the browser keeps both channels
        rgb = bytearray(width * height * 3)
        rgb[0::3], rgb[1::3] = payload[0::2][:width * height], payload[1::2][:width * height]
        return ".png", png_bytes(width, height, bytes(rgb), 3), (iw or width, ih or height)
    return ".png", png_bytes(width, height, payload[:width * height * channels], channels), (iw or width, ih or height)


# --- conversion ------------------------------------------------------------------

def _vec(value, default=(0.0, 0.0, 0.0)):
    try:
        parts = [float(x) for x in str(value).split()]
        return (parts + list(default))[:3]
    except ValueError:
        return list(default)


def _particle_kind(path: str) -> str | None:
    name = path.lower()
    return next((kind for needle, kind in PARTICLE_KINDS if needle in name), None)


def _particle_motion(files, path, kind, origin, scale, override, width, height) -> dict:
    preset = json.loads(files.get(path, b"{}"))
    emitter = (preset.get("emitter") or [{}])[0]
    initial = {item["name"]: item for item in (preset.get("initializer") or [])}
    defaults = (9, 5, 72) if kind == "leaves" else (14, .2, 925)
    life = initial.get("lifetimerandom", {})
    size = initial.get("sizerandom", {})
    velocity = initial.get("velocityrandom", {})
    minimum, maximum = _vec(velocity.get("min")), _vec(velocity.get("max"))
    offset = _vec(emitter.get("origin"))
    return {
        "position": [(origin[0] + offset[0] * scale[0]) / width, (origin[1] + offset[1] * scale[1]) / height],
        "velocity": [(minimum[i] + maximum[i]) * scale[i] / (2 * span)
                     for i, span in enumerate((width, height))],
        "lifetime": (float(life.get("min", defaults[0])) + float(life.get("max", defaults[0]))) / 2,
        "rate": float(emitter.get("rate", defaults[1])) * float(override.get("rate", 1)) * float(override.get("count", 1)),
        "size": (float(size.get("min", defaults[2])) + float(size.get("max", defaults[2]))) / 2 / height,
        "start": float(preset.get("starttime") or 0),
    }


def convert(project_dir: Path, out_dir: Path) -> dict:
    """Write the decoded layer images and a scene.json descriptor for the renderer."""
    project = json.loads((project_dir / "project.json").read_text(encoding="utf-8-sig"))
    pkg = project_dir / "scene.pkg"
    files = read_pkg(pkg) if pkg.is_file() else {
        str(p.relative_to(project_dir)).replace("\\", "/"): p.read_bytes() for p in project_dir.rglob("*") if p.is_file()}
    scene = json.loads(files["scene.json"].decode("utf-8-sig"))
    ortho = (scene.get("general") or {}).get("orthogonalprojection") or {}
    width, height = float(ortho.get("width") or 1920), float(ortho.get("height") or 1080)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    def texture(name: str, target: str) -> str | None:
        blob = files.get(f"materials/{name}.tex")
        decoded = decode_tex(blob) if blob else None
        if not decoded:
            return None
        ext, data, _size = decoded
        (out_dir / (target + ext)).write_bytes(data)
        return target + ext

    layers, particles = [], []
    for obj in scene.get("objects") or []:
        if obj.get("visible") is False:
            continue
        origin = _vec(obj.get("origin"))
        scale = _vec(obj.get("scale"), (1, 1, 1))
        if obj.get("image"):
            model = json.loads(files.get(obj["image"], b"{}").decode("utf-8-sig") or "{}")
            material = json.loads(files.get(model.get("material", ""), b"{}").decode("utf-8-sig") or "{}")
            textures = ((material.get("passes") or [{}])[0].get("textures") or [])
            if not textures:
                continue
            index = len(layers)
            image = texture(textures[0], f"layer{index}")
            if not image:
                continue
            layer = {"image": image, "x": origin[0] / width, "y": origin[1] / height,
                     "scale": scale[:2], "alpha": float(obj.get("alpha", 1))}
            for effect in obj.get("effects") or []:
                if effect.get("visible") is False:
                    continue
                name = effect.get("file", "")
                passes = effect.get("passes") or [{}]
                values = passes[0].get("constantshadervalues") or {}
                if "waterflow" in name:
                    tex = passes[0].get("textures") or []
                    mask = texture(tex[1], f"flow{index}") if len(tex) > 1 and tex[1] else None
                    phase = texture(tex[2], f"phase{index}") if len(tex) > 2 and tex[2] else None
                    if mask:
                        layer["flow"] = {"mask": mask, "phase": phase, "speed": float(values.get("speed", 1)),
                                         "strength": float(values.get("strength", 1)),
                                         "phasescale": float(values.get("phasescale", 2))}
                elif "shine" in name or "godray" in name:
                    ray = (passes[1].get("constantshadervalues") if len(passes) > 1 else {}) or {}
                    layer["shine"] = {"intensity": float(ray.get("rayintensity", .5)), "length": float(ray.get("raylength", .1)),
                                      "threshold": float(values.get("raythreshold", .85)),
                                      "direction": float(ray.get("direction", 0))}
            layers.append(layer)
        elif obj.get("particle"):
            kind = _particle_kind(obj["particle"])
            if not kind:
                continue
            override = obj.get("instanceoverride") or {}
            color = _vec(override.get("colorn"), (1, 1, 1))
            particle = {"type": kind, "x": origin[0] / width, "y": origin[1] / height,
                              "scale": [abs(scale[0]), abs(scale[1])],
                              "rate": float(override.get("rate", 1)), "speed": float(override.get("speed", 1)),
                              "count": float(override.get("count", 1)), "size": float(override.get("size", 1)),
                              "alpha": float(override.get("alpha", 1)), "color": color}
            if kind in ("leaves", "shafts"):
                try:
                    particle["motion"] = _particle_motion(files, obj["particle"], kind, origin, scale, override, width, height)
                except (ValueError, TypeError, KeyError):
                    pass
            particles.append(particle)
    if not layers:
        raise ValueError("A scene nem tartalmaz megjeleníthető képréteget.")
    descriptor = {"title": project.get("title") or project_dir.name, "aspect": width / height,
                  "layers": layers[:3], "particles": particles[:24]}
    (out_dir / "scene.json").write_text(json.dumps(descriptor, ensure_ascii=False, indent=1), encoding="utf-8")
    return descriptor
