#!/usr/bin/env python3
"""
demo_photos.py — the source images for the built-in demo front page.

The demo snapshot in news_mock.c names three pictures, and something has to be
able to produce them or the one page an unconfigured board prints is the one
page whose photographs cannot be regenerated. A real edition gets real
photographs from its producer; the demo cannot, because it is committed to a
repository and a wire photograph is somebody's copyright.

So these are synthesised — and captioned DEMO IMAGE on the sheet, because a
reader is entitled to know that. They exist to exercise the path that matters:
tools/make_tile.py screens them, the tile goes through the byte-count check, the
palette proof and the blit, and sim/shots/ shows what a photograph actually
looks like on this glass.

WHY THERE IS A CAMERA IN HERE
-----------------------------
The first two versions of this file placed geometry with formulas fitted by eye
— a cabinet at `0.16 + 1.5*t**1.9`, a light strip at `0.08 + 0.40*t**1.6` — and
the tiles came back as a drift of grey rectangles. The failure is not that the
formulas were wrong; it is that there was no single thing for them to be right
about. Every edge was placed by its own curve, so no two edges agreed on where
the camera was, and a frame in which nothing agrees about the camera does not
read as a place no matter how good its noise is.

So the scenes are now actual 3D geometry projected through an actual pinhole
camera: world -> camera -> perspective divide -> raster, with a depth buffer and
near-plane clipping. It is about two hundred lines and it buys the one property
that cannot be faked: every edge in the frame is consistent with every other
edge, because they all went through the same matrix. Convergence, foreshortening
and occlusion then come out right for free, and the eye reads a room.

WHY SHADING IS BY NORMAL AND NOT BY DEPTH
-----------------------------------------
Depth-only shading — near dark, far pale — gives a flat frame with a gradient on
it. What the eye reads as three-dimensional is the RATIO between a face turned
toward the light and a face turned away from it, seen on the same object at the
same distance. So every surface carries its own normal, and `base_shade()` is a
key light plus a wrap-around fill: about 0.16 for a face pointing away from
everything, about 1.0 for one square to the key. Nothing is ever fully black,
because a fill of zero puts a hole in the sheet where the halftone has nothing
to screen.

WHERE THE WHITE POINT COMES FROM
--------------------------------
A fab ceiling is mostly lamps and a wafer is mostly specular, so stretching a
frame between its extremes puts the top of the range in the six brightest strips
and squeezes everything a reader is looking at into the bottom third. That is
how the earliest tiles came out so dark. Reaching for a fixed high percentile of
the whole frame instead fails the other way as soon as the subject is small: the
wafer plate was 60% flat dark surround, the 92nd percentile landed just above
that pile and INSIDE the disc, and the disc clipped to paper and screened as a
dinner plate.

So `fill_histogram()` splits the frame at its median and reads the white point
from the brighter half. A flat dark surround does not get a vote; a lamp
covering three per cent of the frame is still a small minority of the upper half
and still clips, which is what a photographer does with a fitting in shot. The
gamma is then solved, not guessed, to land the mean on 0.5. A photograph that
halftones well is one that is mostly mid-grey, and the diagnostic printed next
to the byte count is the fraction of the frame between 0.25 and 0.75.

AND WHAT IS HANDED TO make_tile.py
----------------------------------
Not its defaults. Those exist to lift a camera file's shadows clear of a 5:1
panel, and these plates have already been laid out on the full range — running
the default curve over them lifts a second time and a mid-grey source screens
out at eighty-five per cent paper. `TONE` below is a straight line placed so
that the source's mid-grey lands on the midpoint of the panel's two inks. The
arithmetic is written out there, and `--preview` is how it was checked: the
source is not the deliverable, the screened tile is.

WHAT THE NOISE IS STILL FOR
---------------------------
A halftone screen is a multi-scale operation: it trades spatial resolution for
tonal resolution, and it has nothing to trade with in a surface that is flat.
Fill a wall with 50% grey and the screen returns a regular dot pattern that reads
as a moire artefact; fill it with 50% grey that has texture at four scales and
the screen returns something that reads as a surface. So every material still
carries fractal noise, the far field still hazes so it cannot crush to one ink,
and grain still goes on last at a size just above the screen's own cell.

The one thing added on that side is footprint awareness: `stripe()` widens and
fades a ruled line as its spacing falls below a pixel, and `mip()` fades a
texture the same way. A floor grid that keeps drawing 1 px lines into the
distance is a moire generator, and a moire pattern fed to a halftone comes back
as a plaid.

TONE, NOT COLOUR
----------------
The output is monochrome and make_tile.py is run with --halftone, because that
is what CLAUDE.md says a photograph on this panel is: black ink on white paper,
the way a broadsheet does it. Six-ink error diffusion was rendered and looked at
and it produces coloured speckle that reads as damage. Keeping the source
monochrome also means the tone curve here and the tone curve there are arguing
about the same numbers.

Usage
-----
    python3 -m venv /tmp/tileenv && /tmp/tileenv/bin/pip install Pillow numpy
    /tmp/tileenv/bin/python tools/demo_photos.py            # -> sim/tiles/*.bin
    /tmp/tileenv/bin/python tools/demo_photos.py --keep-src # also leave the PNGs
    /tmp/tileenv/bin/python tools/demo_photos.py --preview  # and what the panel prints
    /tmp/tileenv/bin/python tools/demo_photos.py --only sndk_fab   # one plate

The tiles are the deliverable and they are byte-identical run to run; the PNGs
and the screen previews are diagnostics and are not written unless asked for.
"""

import argparse
import math
import os
import subprocess
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow and numpy:\n"
             "  python3 -m venv /tmp/tileenv\n"
             "  /tmp/tileenv/bin/pip install Pillow numpy\n"
             "  /tmp/tileenv/bin/python tools/demo_photos.py")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, "sim", "tiles")
MAKE_TILE = os.path.join(ROOT, "tools", "make_tile.py")

# Rendered at 3x and box-filtered down. The screen is applied to the DOWNSAMPLED
# image, so every edge in the source needs to arrive already anti-aliased —
# a hard 1 px edge going into a halftone comes out as a staircase of dots. The
# rasteriser below does not anti-alias its own edges at all; this is where that
# is paid for, and it is why the factor is not 2.
SS = 3

# The demo's pictures. Width must be even (a tile packs two pixels to a
# byte); the lead is cut at the widest column span the compositor can hand it,
# and the page centre-crops when the day's layout is narrower. Cropping a
# screened tile is free — it is a memcpy at a different offset — where resizing
# one would put it through a second dither, which is the confetti make_tile.py's
# header warns about.
#
# There are two cameras on the fab because there are two shapes of hole to put a
# picture in. `sndk_fab` is a 3.6:1 strip and `sndk_fab_tall` a 2:1 banner, and
# the banner is not the strip with more sky over it — it is the other photograph
# taken on the same visit, of an operator at a load port. They are built from
# the same room; see the note above `fab_lights()`. Only the strip ships; see
# SHELVED below for why.
#
# The last column is the tone target: where `fill_histogram()` puts the mean.
# It is per-plate because these do not print at the same size, and a picture
# editor does not expose a half-page picture the way they expose a thumbnail.
# `fill_histogram()` pins the mean by construction, so total ink on the sheet is
# set HERE and nowhere else — lightening a scene only makes the gamma work less
# and leaves the ink fraction where it was. The banner is about a third of the
# sheet; at the 0.50 the small plates use it packs 56% ink and pulls the whole
# page toward it, so it is exposed a third of a stop lighter.
# name, width, height, plate, tone target, grain seed.
#
# The seed is explicit rather than derived from the row's position, because it
# used to be `100 + index * 13` and that made the ORDER of this list load-
# bearing: inserting a plate anywhere but the end silently regenerated every
# tile below it. A number in the row cannot be moved by accident.
PLATES = [
    ("sndk_fab",   1140, 320, "fab",   0.556, 100),
    ("sndk_wafer",  364, 204, "wafer", 0.50, 113),
    ("sndk_line",   364, 204, "line",  0.50, 126),
]

# Built by name only — `--only sndk_fab_tall` — and never by a plain run.
#
# `plate_fab_tall()` is a finished 2:1 banner of the same fab: its own camera,
# an operator at a load port, a depth ladder of three figures. It is not built
# because 560 px is the wrong number. Measured against PAGE HEIGHT rather than
# against its own frame, 560 is 35% of this sheet where the reference broadsheet
# gives its lead photograph about 32% — so it overshoots rather than matches.
# And the comparison flatters us anyway: the reference page has inside pages to
# turn to, where this sheet must also carry the dossier rail, the briefs, the
# industry table, a price chart, a revenue graphic and two thumbnails on the
# same side of the same piece of paper. Our lead photograph has to take a
# SMALLER share than the reference's, not an equal one. The page agrees: at
# 1140x320 the lead's legs already run six lines and stop mid-sentence.
#
# The camera is kept because it works and because 420 px — 26% of the page —
# becomes plausible if the compositor's h_min work frees the depth. Deleting a
# working camera to re-derive it later would be the waste. Change the height
# here and run with --only to look at it.
SHELVED = [
    ("sndk_fab_tall", 1140, 560, "fab_tall", 0.578, 139),
]

# The tone curve handed to make_tile.py, and the arithmetic behind it.
#
# make_tile's defaults — black point 60, white point 240, gamma 0.72 — exist to
# lift a CAMERA FILE's shadows clear of a panel whose contrast is about 5:1. A
# camera file arrives with its shadows in the bottom eighth of the range and
# needs that lift. These plates do not: `fill_histogram()` has already put them
# on the full range with their mean on 0.50, and running the default curve over
# that lifts a second time. Feed it 0.50 and it returns 60 + 0.5^0.72 * 180 =
# 169, and the panel's two inks are #1F2226 and #B9C7C9 — 31 and 185 — so 169 is
# eighty-five per cent paper. The whole plate screens out as a few dark specks
# on white, which is what the first halftone preview showed.
#
# So the curve here is a straight line placed to map the source's mid-grey onto
# the midpoint of the two inks: 20 + 0.50 * 180 = 110, against an ink midpoint
# of (31 + 185) / 2 = 108. A pixel at 0.50 comes out as a fifty-fifty dither,
# which is what a mid-grey is supposed to be, and the ends still land inside
# what the panel can print.
TONE = ["--black-point", "20", "--white-point", "200", "--gamma", "1.0"]


# --- the texture ----------------------------------------------------------

def _rng(seed):
    """A named generator, so a given plate is byte-identical run to run.

    The tiles are committed and test_news_mock compares fingerprints. A plate
    that resampled its noise from the system entropy pool every run would make
    every rebuild a diff.
    """
    return np.random.default_rng(seed)


def value_noise(h, w, cells, seed):
    """One octave: random values on a coarse lattice, smoothly interpolated.

    Bilinear would leave the lattice visible as a diamond grid under a screen,
    so the interpolant is the smoothstep 3t^2-2t^3, which lands with zero
    gradient at every lattice point and hides where the cells were.
    """
    g = _rng(seed)
    gh, gw = max(2, cells), max(2, int(cells * w / h))
    lat = g.random((gh + 1, gw + 1))

    yi = np.linspace(0, gh, h, endpoint=False)
    xi = np.linspace(0, gw, w, endpoint=False)
    y0, x0 = yi.astype(int), xi.astype(int)
    ty, tx = yi - y0, xi - x0
    ty = (ty * ty * (3 - 2 * ty))[:, None]
    tx = (tx * tx * (3 - 2 * tx))[None, :]

    a = lat[y0][:, x0]
    b = lat[y0][:, x0 + 1]
    c = lat[y0 + 1][:, x0]
    d = lat[y0 + 1][:, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def fractal(h, w, seed, octaves=5, base=3, gain=0.5):
    """Five octaves of value noise, each half the amplitude and twice the rate.

    Five is where it stops being worth it: the sixth octave's cells are smaller
    than the halftone's own, so it is averaged away by the screen and only costs
    time. Normalised to 0..1 so callers can treat it as a modulation depth.
    """
    out = np.zeros((h, w))
    amp, cells, norm = 1.0, base, 0.0
    for i in range(octaves):
        out += amp * value_noise(h, w, cells, seed + i * 977)
        norm += amp
        amp *= gain
        cells *= 2
    out /= norm
    return (out - out.min()) / max(1e-6, float(np.ptp(out)))


def grain(h, w, seed, amount):
    """Film grain, correlated over about two pixels.

    White noise at one pixel is invisible under a screen whose cell is four —
    it averages out inside a single dot. Two-pixel grain survives, and what it
    buys is broken edges between tonal steps in a smooth gradient. It is applied
    AFTER the downsample, because two pixels of the 3x frame is two thirds of an
    output pixel and the box filter would eat it.
    """
    g = _rng(seed)
    n = g.normal(0, 1, (h // 2 + 1, w // 2 + 1))
    n = np.repeat(np.repeat(n, 2, axis=0), 2, axis=1)[:h, :w]
    return n * amount


_TEXCACHE = {}


def texture(seed, n=256, base=3, octaves=5):
    """A square tile of fractal noise, memoised.

    Every material samples one of these by world coordinate, so the same wall
    seen from two distances gets the same grain at the same physical size —
    which is what stops a receding surface looking like it is made of a
    different substance at each end.
    """
    key = (seed, n, base, octaves)
    if key not in _TEXCACHE:
        _TEXCACHE[key] = fractal(n, n, seed, octaves=octaves, base=base)
    return _TEXCACHE[key]


def sample(arr, u, v):
    """Bilinear lookup with a MIRRORED wrap.

    Plain repetition would put a visible seam wherever the tile restarts, and a
    straight seam running down a wall is the one artefact a halftone renders
    perfectly. Mirroring makes the value continuous across every boundary; the
    gradient is not, but under five octaves of noise nobody has ever seen it.
    """
    n = arr.shape[0]
    fu = np.abs((np.asarray(u) % 2.0) - 1.0) * (n - 1)
    fv = np.abs((np.asarray(v) % 2.0) - 1.0) * (n - 1)
    x0 = fu.astype(np.int32)
    y0 = fv.astype(np.int32)
    x1 = np.minimum(x0 + 1, n - 1)
    y1 = np.minimum(y0 + 1, n - 1)
    tx, ty = fu - x0, fv - y0
    a, b = arr[y0, x0], arr[y0, x1]
    c, d = arr[y1, x0], arr[y1, x1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def mip(z, f, period):
    """How much of a texture of this period survives at this depth.

    One pixel spans about z/f world units, so a texture whose period is smaller
    than that is being asked to put more than one cycle inside a pixel. Drawing
    it anyway does not render detail, it renders aliasing — and aliasing fed to
    a halftone screen beats against the screen's own frequency and comes back as
    a plaid. Fading the amplitude instead is what a mip chain does.
    """
    return 1.0 / (1.0 + 3.0 * (z / f) / period)


def stripe(t, halfw, fw):
    """A ruled line at every integer `t`, box-filtered against its own footprint.

    `fw` is how much `t` changes across one pixel. When the line is wider than a
    pixel this is an ordinary soft-edged stripe; when the spacing collapses in
    the distance the coverage term takes over and the line fades to its average
    instead of flickering. A floor grid that keeps drawing crisp 1 px lines to
    the vanishing point is a moire generator.
    """
    e = np.maximum(fw, 1e-5)
    d = np.abs(((t + 0.5) % 1.0) - 0.5)
    cov = np.clip((halfw + 0.5 * e - d) / e, 0.0, 1.0)
    return cov * np.clip(2.0 * halfw / e, 0.0, 1.0)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- the camera and the rasteriser ----------------------------------------

def unit(v):
    v = np.asarray(v, float)
    return v / max(1e-12, float(np.linalg.norm(v)))


class Camera:
    """A pinhole. World -> camera by a rigid transform, then a divide by z.

    The basis is built from a look-at, which is the only way to aim one of these
    that a human can reason about: put the eye somewhere a photographer could
    stand and point it at the thing the picture is of.
    """

    def __init__(self, eye, target, w, h, hfov_deg, up=(0.0, 1.0, 0.0), znear=0.05):
        self.eye = np.asarray(eye, float)
        fwd = unit(np.asarray(target, float) - self.eye)
        # cross(up, fwd), not cross(fwd, up): with y up and z into the frame the
        # latter puts world +x on the LEFT of the image and quietly mirrors
        # every scene. Nothing looks broken when it happens — a mirrored room is
        # still a room — which is exactly why it is worth naming here. It was
        # caught by placing a figure at x < 0 and finding them on the right.
        right = unit(np.cross(np.asarray(up, float), fwd))
        upv = np.cross(fwd, right)
        # Rows are the camera axes in world coordinates, so `to_cam` is a
        # rotation by R and `from_cam` is the transpose. Keeping both here means
        # no other code has to remember which way round it goes.
        self.R = np.stack([right, upv, fwd])
        self.w, self.h = w, h
        self.f = (w * 0.5) / math.tan(math.radians(hfov_deg) * 0.5)
        self.cx, self.cy = (w - 1) * 0.5, (h - 1) * 0.5
        self.znear = znear

    def to_cam(self, P):
        return (np.asarray(P, float) - self.eye) @ self.R.T

    def from_cam(self, C):
        return self.eye + np.asarray(C, float) @ self.R

    def project(self, C):
        sx = self.cx + self.f * C[:, 0] / C[:, 2]
        sy = self.cy - self.f * C[:, 1] / C[:, 2]
        return np.stack([sx, sy], axis=1)


class Hit:
    """What a shader is handed: the surface coordinates of the covered pixels.

    `u`/`v` are in WORLD UNITS on the face rather than 0..1, so a texture period
    is a length in metres and two different faces of the same material agree
    about how big its grain is. `dst` is what is already in the framebuffer,
    which is how a shadow multiplies instead of painting.
    """

    __slots__ = ("u", "v", "z", "P", "dst")

    def __init__(self, u, v, z, P, dst):
        self.u, self.v, self.z, self.P, self.dst = u, v, z, P, dst


class Frame:
    def __init__(self, cam, sky):
        self.cam = cam
        self.lum = np.full((cam.h, cam.w), float(sky))
        # The background sits at a large but finite depth so the fog at the end
        # treats it as far away rather than as an error.
        self.z = np.full((cam.h, cam.w), 1.0e6)


def clip_near(C, A, znear):
    """Sutherland-Hodgman against z >= znear, carrying the uv attributes.

    Without this, a floor that runs under the camera has vertices behind the
    lens; those project to a point mirrored through the principal point and the
    triangle comes out inside out, painting the whole frame. It is four lines of
    protection against an entire class of frame-destroying bug.
    """
    out_c, out_a = [], []
    n = len(C)
    for i in range(n):
        j = (i + 1) % n
        di, dj = C[i][2] - znear, C[j][2] - znear
        if di >= 0:
            out_c.append(C[i])
            out_a.append(A[i])
        if (di >= 0) != (dj >= 0):
            t = di / (di - dj)
            out_c.append(C[i] + t * (C[j] - C[i]))
            out_a.append(A[i] + t * (A[j] - A[i]))
    if len(out_c) < 3:
        return None, None
    return np.array(out_c), np.array(out_a)


def _tri(fb, C, A, shader):
    cam = fb.cam
    s = cam.project(C)
    area = ((s[1, 0] - s[0, 0]) * (s[2, 1] - s[0, 1])
            - (s[2, 0] - s[0, 0]) * (s[1, 1] - s[0, 1]))
    if abs(area) < 1e-9:
        return

    x0 = max(0, int(math.floor(s[:, 0].min())))
    x1 = min(cam.w - 1, int(math.ceil(s[:, 0].max())))
    y0 = max(0, int(math.floor(s[:, 1].min())))
    y1 = min(cam.h - 1, int(math.ceil(s[:, 1].max())))
    if x1 < x0 or y1 < y0:
        return

    px = np.arange(x0, x1 + 1, dtype=float)[None, :]
    py = np.arange(y0, y1 + 1, dtype=float)[:, None]

    def edge(a, b):
        return (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])

    w0, w1, w2 = edge(s[1], s[2]), edge(s[2], s[0]), edge(s[0], s[1])
    if area < 0:
        w0, w1, w2, area = -w0, -w1, -w2, -area
    m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
    if not m.any():
        return

    iy, ix = np.nonzero(m)
    l0, l1, l2 = w0[m] / area, w1[m] / area, w2[m] / area

    # Perspective-correct interpolation: what is linear in screen space is 1/z,
    # not z. Interpolating z directly bows a flat floor into a saddle and the
    # depth test then lets far geometry punch through near geometry.
    iz = l0 / C[0, 2] + l1 / C[1, 2] + l2 / C[2, 2]
    z = 1.0 / iz

    yy, xx = y0 + iy, x0 + ix
    keep = z < fb.z[yy, xx]
    if not keep.any():
        return
    yy, xx, z = yy[keep], xx[keep], z[keep]
    l0, l1, l2 = l0[keep], l1[keep], l2[keep]

    u = (l0 * A[0, 0] / C[0, 2] + l1 * A[1, 0] / C[1, 2] + l2 * A[2, 0] / C[2, 2]) * z
    v = (l0 * A[0, 1] / C[0, 2] + l1 * A[1, 1] / C[1, 2] + l2 * A[2, 1] / C[2, 2]) * z

    # The world position comes back out of the screen coordinate and the depth
    # rather than being interpolated as three more attributes: it is exact, it
    # is free, and a specular highlight needs it.
    xc = (xx - cam.cx) * z / cam.f
    yc = -(yy - cam.cy) * z / cam.f
    P = cam.from_cam(np.stack([xc, yc, z], axis=1))

    out = shader(Hit(u, v, z, P, fb.lum[yy, xx]))
    if isinstance(out, tuple):
        val, alpha = out
    else:
        val, alpha = out, 1.0

    fb.lum[yy, xx] = alpha * val + (1 - alpha) * fb.lum[yy, xx]
    # A half-covered edge pixel does not own the depth buffer; letting it would
    # cut a notch out of whatever is drawn behind it next.
    if np.isscalar(alpha):
        if alpha > 0.5:
            fb.z[yy, xx] = z
    else:
        w = alpha > 0.5
        fb.z[yy[w], xx[w]] = z[w]


def poly(fb, pts, shader, uv=None):
    """One convex polygon, clipped, fan-triangulated and rasterised."""
    P = np.asarray(pts, float)
    A = np.zeros((len(P), 2)) if uv is None else np.asarray(uv, float)
    C, A = clip_near(fb.cam.to_cam(P), A, fb.cam.znear)
    if C is None:
        return
    for i in range(1, len(C) - 1):
        _tri(fb, C[[0, i, i + 1]], A[[0, i, i + 1]], shader)


def face_normal(pts, eye):
    """The plane normal, turned to face the camera.

    Authoring winding order consistently across three scenes is a bug farm and
    the scenes are all closed boxes and planes, so the normal is simply flipped
    toward the eye. That makes it impossible to light a wall from behind by
    typing its corners in the wrong order.
    """
    p = np.asarray(pts, float)
    n = unit(np.cross(p[1] - p[0], p[2] - p[0]))
    if float(np.dot(n, np.asarray(eye, float) - p.mean(axis=0))) < 0:
        n = -n
    return n


# --- light ----------------------------------------------------------------

# The key is up and to the left; the fill sits near the camera. Both are
# directions FROM a surface TOWARD the light.
KEY = unit([-0.40, 0.86, 0.31])
FILL = unit([0.55, 0.30, -0.78])
# Deliberately modest: most of a surface's light comes from `lamp_diffuse()`
# below, which is the term that varies across a face. These three only set the
# floor under it and the direction of the shading.
AMBIENT, K_KEY, K_FILL = 0.13, 0.34, 0.20


def base_shade(n):
    """Key plus wrap-around fill, from a face normal. About 0.15 to 1.03.

    The fill is wrapped (0.5 + 0.5*cos rather than max(0, cos)) so a face turned
    fully away still receives something. A true zero would put pure paper-white
    or pure black into the frame with no gradient on either side of it, and a
    halftone screen cannot make a surface out of that.
    """
    n = unit(n)
    lam = max(0.0, float(np.dot(n, KEY)))
    wrap = 0.5 + 0.5 * float(np.dot(n, FILL))
    return AMBIENT + K_KEY * lam + K_FILL * wrap


def base_shade_n(nrm):
    """`base_shade` for a surface whose normal varies from pixel to pixel.

    Same formula, evaluated row-wise. Kept separate rather than folded into
    `base_shade` for the same reason as `lamp_diffuse_n` below: the three
    committed plates are byte-compared on every regeneration, and a scalar
    `np.dot` and a row-wise `@` need not agree in the last bit. A halftone turns
    a last-bit disagreement into a moved dot.
    """
    nrm = nrm / np.maximum(1e-9, np.linalg.norm(nrm, axis=1))[:, None]
    lam = np.clip(nrm @ KEY, 0, None)
    wrap = 0.5 + 0.5 * (nrm @ FILL)
    return AMBIENT + K_KEY * lam + K_FILL * wrap


def specular(n, P, eye, lights, shine=48.0, falloff=0.05):
    """Blinn-Phong over a list of point lights, evaluated per pixel.

    This is what puts a receding row of soft highlights down a polished floor,
    and that row is worth more to the read of the frame than any amount of
    texture: it is the one cue that says the floor is a surface with a direction
    rather than a grey wash that happens to get paler.
    """
    n = unit(n)
    V = eye[None, :] - P
    V /= np.maximum(1e-9, np.linalg.norm(V, axis=1))[:, None]
    out = np.zeros(len(P))
    for L in lights:
        D = np.asarray(L, float)[None, :] - P
        d = np.maximum(1e-6, np.linalg.norm(D, axis=1))
        H = D / d[:, None] + V
        H /= np.maximum(1e-9, np.linalg.norm(H, axis=1))[:, None]
        out += np.clip(H @ n, 0, None) ** shine / (1.0 + falloff * d * d)
    return out


LAMPS = []          # the scene's point lamps in world space; a plate sets these
LAMP_GAIN = 0.42    # how much of a surface's light comes from them rather than
                    # from the directional key


LAMP_POWER = 1.0    # per-lamp intensity
LAMP_FALLOFF = 0.10  # the d^2 coefficient; see the note in set_lamps()


def set_lamps(pts, power=1.0, falloff=0.10):
    """Hand the shaders the lamps the scene actually draws.

    A module-level light list is how a fixed-function pipeline did this and it
    is the right shape here: every material wants the same lamps, the plates run
    one at a time, and threading a list through `abox`'s two-argument shader
    factory would put it in twenty call sites to say the same thing.

    `falloff` has to be set per scene and it is the knob that bit hardest. A fab
    aisle is tens of metres long, so d^2 runs to a hundred and a coefficient of
    0.10 puts the half-brightness distance around three metres, which is right.
    The wafer sits on a stage half a metre across, where d^2 is under 0.5 and
    that same coefficient means no falloff at all: nine lamps each contributing
    nearly their full cosine, summed, and the chuck top rendered at five times
    white. That is what put a bar of blown paper across the top of the plate.
    `power` exists for the same reason — a ring lamp sampled at eight points is
    one lamp, not eight.
    """
    global LAMPS, LAMP_POWER, LAMP_FALLOFF
    LAMPS = [np.asarray(p, float) for p in pts]
    LAMP_POWER, LAMP_FALLOFF = power, falloff


def lamp_diffuse(n, P):
    """Per-pixel diffuse from the lamps, with an inverse-square-ish falloff.

    This is the term that stops a large flat panel being one flat tone. A
    directional key gives a whole wall the same number no matter how far up it
    or how far down the room a pixel is, and a whole wall of one number is
    exactly the cardboard the first two versions of this file kept producing.
    Real lamps are a few metres away, so a machine face is brighter at the top
    than at the plinth and brighter under a fitting than between two — a
    gradient in two directions at once, on a surface with a single normal, which
    is the thing that reads as light in a room.
    """
    if not LAMPS:
        return 0.0
    n = unit(n)
    out = np.zeros(len(P))
    for L in LAMPS:
        D = L[None, :] - P
        d2 = np.maximum(1e-4, np.einsum("ij,ij->i", D, D))
        out += np.clip(D @ n, 0, None) / np.sqrt(d2) / (1.0 + LAMP_FALLOFF * d2)
    return out * LAMP_POWER


def lamp_diffuse_n(nrm, P):
    """`lamp_diffuse` for a surface whose normal varies from pixel to pixel.

    Every flat face in these scenes has one normal, so the version above takes
    one and the whole face is a single dot product. A billboard figure is the
    exception: it is one quad, but what it stands for is a body, and a body is
    round. Shading it with the quad's own normal gives a paper cut-out — which
    is exactly what the strip plate's figures are, and it does not matter there
    because they are eighty pixels tall. On a banner the near operator is half
    the height of the frame, and at that size the eye wants to see the light
    turn across them.

    Kept separate rather than folded into `lamp_diffuse` because the three
    committed plates are byte-compared on every regeneration, and `D @ n` and an
    einsum need not agree in the last bit. A halftone turns a last-bit
    disagreement into a moved dot.
    """
    if not LAMPS:
        return 0.0
    nrm = nrm / np.maximum(1e-9, np.linalg.norm(nrm, axis=1))[:, None]
    out = np.zeros(len(P))
    for L in LAMPS:
        D = L[None, :] - P
        d2 = np.maximum(1e-4, np.einsum("ij,ij->i", D, D))
        out += (np.clip(np.einsum("ij,ij->i", D, nrm), 0, None)
                / np.sqrt(d2) / (1.0 + LAMP_FALLOFF * d2))
    return out * LAMP_POWER


def matte(pts, eye, albedo, seed=None, amp=0.16, period=0.5, f=1.0, lamp=LAMP_GAIN):
    """The ordinary material: a normal, an albedo, the lamps and some grain."""
    n = face_normal(pts, eye)
    b = base_shade(n)
    tex = None if seed is None else texture(seed)

    def sh(s):
        v = albedo * (b + lamp * lamp_diffuse(n, s.P))
        if tex is not None:
            t = sample(tex, s.u / period, s.v / period)
            v = v * (1.0 + amp * (2 * t - 1) * mip(s.z, f, period))
        return v
    return sh


def quad(fb, p0, p1, p2, p3, shader, uv=None):
    poly(fb, [p0, p1, p2, p3], shader, uv)


def abox(fb, lo, hi, make_shader):
    """An axis-aligned box, drawing only the at most three faces the eye can see.

    Back faces are not merely wasted: with a depth buffer and no back-face cull
    they win the test wherever a near face is missing, which is how a box turns
    inside out. The visibility test here is a comparison, so there is nothing to
    get wrong.
    """
    (ax, ay, az), (bx, by, bz) = lo, hi
    e = fb.cam.eye
    faces = []
    if e[2] < az:
        faces.append((([ax, ay, az], [bx, ay, az], [bx, by, az], [ax, by, az]), (bx - ax, by - ay), "z"))
    elif e[2] > bz:
        faces.append((([bx, ay, bz], [ax, ay, bz], [ax, by, bz], [bx, by, bz]), (bx - ax, by - ay), "z"))
    if e[0] < ax:
        faces.append((([ax, ay, bz], [ax, ay, az], [ax, by, az], [ax, by, bz]), (bz - az, by - ay), "x"))
    elif e[0] > bx:
        faces.append((([bx, ay, az], [bx, ay, bz], [bx, by, bz], [bx, by, az]), (bz - az, by - ay), "x"))
    if e[1] > by:
        faces.append((([ax, by, az], [bx, by, az], [bx, by, bz], [ax, by, bz]), (bx - ax, bz - az), "y"))
    elif e[1] < ay:
        faces.append((([ax, ay, bz], [bx, ay, bz], [bx, ay, az], [ax, ay, az]), (bx - ax, bz - az), "y"))

    for pts, (su, sv), axis in faces:
        uv = [[0, 0], [su, 0], [su, sv], [0, sv]]
        quad(fb, *pts, make_shader(pts, axis), uv)


def fog(fb, value, half):
    """Atmospheric perspective, applied once over the finished depth buffer.

    Without it the far end of a long room crushes to a single ink and the frame
    loses its depth exactly where the depth was the point. `half` is the
    distance at which a surface is halfway to the haze; the background sits at a
    huge depth and therefore becomes the haze exactly, which is what a real lens
    does to a wall of diffused light.
    """
    t = 1.0 - np.exp(-np.log(2.0) * fb.z / half)
    fb.lum = fb.lum * (1 - t) + value * t


def blur(a, r):
    """A separable box blur by summed area, used for defocus only."""
    if r < 1:
        return a
    k = 2 * r + 1
    p = np.pad(a, ((0, 0), (r, r)), mode="edge")
    c = np.cumsum(p, axis=1)
    a = (c[:, k - 1:] - np.concatenate([np.zeros((a.shape[0], 1)), c[:, :-k]], axis=1)) / k
    p = np.pad(a, ((r, r), (0, 0)), mode="edge")
    c = np.cumsum(p, axis=0)
    return (c[k - 1:, :] - np.concatenate([np.zeros((1, a.shape[1])), c[:-k, :]], axis=0)) / k


def defocus(fb, focus, radius, gain=1.0):
    """Depth of field, by blending one blurred copy in by circle of confusion.

    Nobody photographs a production line at f/16. More to the point, a soft far
    field gives the screen a broad tonal wash to sit in behind a sharp subject,
    which is the contrast of detail against smoothness that makes a halftone
    read as a photograph rather than as an etching.
    """
    soft = blur(fb.lum, radius)
    coc = np.clip(np.abs(1.0 / np.minimum(fb.z, 1e4) - 1.0 / focus) * focus * gain, 0, 1)
    fb.lum = fb.lum * (1 - coc) + soft * coc


# --- plate: the fab -------------------------------------------------------

# --- the fab, once, so that two plates can photograph the same room ---------
#
# There are two pictures of this fab on the front page — a 3.6:1 strip across
# the top and a 2:1 banner — and a reader sees them within a hand's width of
# each other. Two hand-written scenes would drift: a ceiling 1.2 m in one and
# 1.3 m in the other, a different aisle width, lamps at a different pitch, and
# the page would quietly stop being a place. So the room is built once and
# photographed twice, and the only things the plates disagree about are where
# the camera stands and what it is pointed at, which is what "two photographs
# of somewhere" means.
#
# The split is also what makes the refactor checkable. The strip's tiles are
# committed and byte-compared on every regeneration, and the tool banks are laid
# out by a seeded generator, so moving that loop into a function is only safe if
# it consumes the generator in exactly the same order. It does — and the byte
# comparison is the proof, not the intention.


def fab_lights(ceil, back):
    """Troffers down the aisle and a row over each tool bank.

    These are the scene's real lights as well as its brightest geometry, so the
    specular on the floor lands under the lamp that caused it.
    """
    lights = [(0.0, ceil - 0.06, z) for z in np.arange(3.0, back - 2.0, 3.4)]
    lights += [(-3.6, ceil - 0.06, z) for z in np.arange(4.7, back - 2.0, 6.8)]
    lights += [(3.6, ceil - 0.06, z) for z in np.arange(4.7, back - 2.0, 6.8)]
    return lights


def fab_shell(fb, eye, f, lights, ceil, aisle, back, ceil_emit=0.0):
    """Floor, ceiling and the light fittings — everything the room is inside of."""

    # --- the floor. A raised access deck: 0.6 m panels, an aisle stripe down
    # each side, a wet-looking polish that carries the lamps.
    floor_pts = [(-26, 0, 1.0), (26, 0, 1.0), (26, 0, back), (-26, 0, back)]
    fn = face_normal(floor_pts, eye)
    ftex = texture(11)

    def floor_sh(s):
        fw = (s.z / f) / 0.6
        panel = np.maximum(stripe(s.u / 0.6, 0.030, fw), stripe(s.v / 0.6, 0.030, fw))
        v = 0.52 * (base_shade(fn) + LAMP_GAIN * lamp_diffuse(fn, s.P))
        v *= 1.0 - 0.30 * panel
        # Painted aisle lines. Two dark bands are worth more than any amount of
        # floor texture: they converge, and convergence is what says "depth".
        for xl in (-1.62, 1.62):
            band = np.clip(1.0 - np.abs(s.u - xl) / 0.075, 0, 1)
            v *= 1.0 - 0.44 * band ** 0.5
        # Contact occlusion where the tool banks meet the floor. Objects that do
        # not darken the ground under them float, and a floating object is the
        # single loudest tell that a frame was computed rather than seen.
        for xl in (-aisle, aisle):
            v *= 1.0 - 0.46 * np.exp(-np.abs(s.u - xl) / 0.55)
        t = sample(ftex, s.u / 1.7, s.v / 1.7)
        v *= 1.0 + 0.13 * (2 * t - 1) * mip(s.z, f, 1.7)
        v += 0.34 * specular(fn, s.P, eye, lights, shine=26.0, falloff=0.012)
        return v
    quad(fb, *floor_pts, floor_sh,
         uv=[(-26, 1.0), (26, 1.0), (26, back), (-26, back)])

    # --- the ceiling: fan filter units, 1.2 x 0.6, seen edge-on from below so
    # the grid runs almost to a line. It is mostly there to give the top of the
    # frame something with structure in it rather than a grey band.
    ceil_pts = [(-26, ceil, 1.0), (26, ceil, 1.0), (26, ceil, back), (-26, ceil, back)]
    cn = face_normal(ceil_pts, eye)
    ctex = texture(23, base=4)

    def ceil_sh(s):
        v = 0.74 * (base_shade(cn) + 0.55 * LAMP_GAIN * lamp_diffuse(cn, s.P))
        fu, fv = (s.z / f) / 1.2, (s.z / f) / 0.6
        frame_ = np.maximum(stripe(s.u / 1.2, 0.055, fu), stripe(s.v / 0.6, 0.075, fv))
        v *= 1.0 - 0.32 * frame_
        t = sample(ctex, s.u / 0.9, s.v / 0.9)
        v *= 1.0 + 0.10 * (2 * t - 1) * mip(s.z, f, 0.9)
        # The filter faces glow, and the grid between them does not.
        #
        # Everything above lights this ceiling badly, and the reason is worth
        # writing down. Its normal points DOWN, so the key — which is above it —
        # contributes nothing, and the lamps sit six centimetres below it in the
        # same plane, so their cosine against a downward normal is nothing too.
        # The surface therefore renders at about 0.15, darker than anything else
        # in the room, and on a frame with a lot of ceiling in it that is a
        # near-solid black bar across the top.
        #
        # It is also simply wrong. A fan filter unit's face is white HEPA media
        # in the plane of the luminaires; in any photograph of a cleanroom it is
        # one of the BRIGHTER surfaces, not the darkest. A large diffusing panel
        # that is part of the lighting plane is not something a key-plus-point-
        # lamp model can express, so it is added here as an emissive floor.
        #
        # It defaults to zero because `plate_fab`'s tiles are committed and
        # byte-compared, and adding 0.0 is exact. The strip has the same wrong
        # ceiling and would be improved by the same correction; it is a thin
        # band there rather than a third of the frame, so it was left alone
        # rather than moved without being asked.
        # The grid gets part of the glow, not none of it, and that fraction is
        # what actually fixed the top edge of the banner. Seen from below at a
        # grazing angle the frames cover most of the ceiling's PROJECTED area —
        # so with the glow masked entirely out of them, the near ceiling took
        # the frames' value rather than the filters', and stayed a dark bar at
        # exactly the height where the picture meets type. Anodised frame is
        # darker than HEPA media; it is not black, and at that angle you are
        # partly seeing its lit sides anyway.
        v += ceil_emit * (1.0 - 0.55 * frame_)
        return v
    quad(fb, *ceil_pts, ceil_sh,
         uv=[(-26, 1.0), (26, 1.0), (26, back), (-26, back)])

    # The troffers themselves, hung a hand's width below the ceiling so they
    # read as fittings in a plane rather than as bright bars in the air. That
    # distinction is the whole difference between a ceiling and a fault.
    for (lx, ly, lz) in lights:
        quad(fb,
             (lx - 0.55, ly, lz - 0.80), (lx + 0.55, ly, lz - 0.80),
             (lx + 0.55, ly, lz + 0.80), (lx - 0.55, ly, lz + 0.80),
             lambda s: 1.55 + 0.05 * np.sin(s.u * 9.0),
             uv=[(-0.55, -0.80), (0.55, -0.80), (0.55, 0.80), (-0.55, 0.80)])
        # The housing around each one, which is what gives the lamp an edge.
        quad(fb,
             (lx - 0.70, ly + 0.001, lz - 0.95), (lx + 0.70, ly + 0.001, lz - 0.95),
             (lx + 0.70, ly + 0.001, lz + 0.95), (lx - 0.70, ly + 0.001, lz + 0.95),
             lambda s: 0.34)


def fab_banks(fb, eye, f, g, aisle, back, depth=3.7, z0=2.0):
    """The tool banks down both sides, laid out by the seeded generator.

    Alternating heights: a fab aisle is not a wall, it is a run of different
    machines, and the low ones matter because their TOPS are visible from eye
    height. A top face is lit by the key at close to full strength where the
    front face is lit at a glance, and that ratio on one object at one distance
    is what the eye reads as solid.

    Every draw from `g` here is load-bearing: the order and count of the calls
    is the layout. Anything added to this loop moves every machine after it.
    """
    z = z0
    while z < back - 2.0:
        length = 2.1 + 0.5 * g.random()
        tall = g.random() < 0.45
        top = 2.15 + 0.25 * g.random() if tall else 1.16 + 0.30 * g.random()
        for side in (-1, 1):
            x_in = side * aisle
            lo = (min(x_in, x_in + side * depth), 0.0, z)
            hi = (max(x_in, x_in + side * depth), top, z + length)
            alb = 0.40 + 0.32 * g.random()
            wtex = int(g.integers(200, 260))
            seam = 0.42 + 0.34 * g.random()          # panel pitch, per machine
            has_screen = g.random() < 0.55
            scr_at = 0.30 + 0.40 * g.random()        # where along it the screen is

            def mk(pts, axis, alb=alb, wtex=wtex, top=top, ln=length,
                   seam=seam, has_screen=has_screen, scr_at=scr_at):
                n = face_normal(pts, eye)
                b = base_shade(n)
                t = texture(wtex, base=5)

                def sh(s):
                    v = alb * (b + LAMP_GAIN * lamp_diffuse(n, s.P))
                    ta = sample(t, s.u / 0.45, s.v / 0.45)
                    v *= 1.0 + 0.11 * (2 * ta - 1) * mip(s.z, f, 0.45)
                    e = np.maximum(s.z / f, 1e-4)
                    if axis == "x":
                        # Panel seams up the machine face, a dark plinth at the
                        # floor and a lighter service band at head height. Three
                        # horizontal tone changes at known heights read as a
                        # machine; one flat rectangle reads as cardboard. Each
                        # seam is a dark line with a light one beside it —
                        # a shadowed gap and the lit edge of the next panel —
                        # because a single dark rule reads as a drawn line.
                        sm = stripe(s.u / seam, 0.010, (s.z / f) / seam)
                        sl = stripe(s.u / seam - 0.030, 0.008, (s.z / f) / seam)
                        v *= 1.0 - 0.30 * sm + 0.16 * sl
                        v *= 1.0 - 0.34 * smoothstep(0.30, 0.09, s.v)
                        v *= 1.0 + 0.16 * (smoothstep(0.74, 0.86, s.v)
                                           - smoothstep(1.00, 1.16, s.v))
                        # The lit top edge of the cabinet, a couple of
                        # centimetres of it, where the ceiling lamps rake across
                        # the lip. It is the cheapest possible highlight and it
                        # is what separates one machine from the aisle behind.
                        v *= 1.0 + 0.55 * np.clip((0.035 - np.abs(s.v - top)) / 0.02, 0, 1)
                        if has_screen:
                            # A control screen in a dark bezel. The earlier
                            # version was a fifth of a metre across and read as
                            # a framed picture hung on a gallery wall; a real
                            # one is a hand span, and it is a panel on a machine
                            # rather than the subject of the photograph.
                            du = np.abs(s.u - ln * scr_at)
                            dv = np.abs(s.v - top * 0.62)
                            bez = (np.clip((0.115 - du) / e, 0, 1)
                                   * np.clip((0.085 - dv) / e, 0, 1))
                            scr = (np.clip((0.092 - du) / e, 0, 1)
                                   * np.clip((0.062 - dv) / e, 0, 1))
                            v = v * (1 - bez) + 0.26 * b * bez
                            v = v * (1 - scr) + (0.86 + 0.22 * ta) * scr
                    elif axis == "y":
                        v *= 1.0 - 0.20 * stripe(s.u / seam, 0.012, (s.z / f) / seam)
                        v *= 1.0 - 0.26 * np.clip((0.05 - s.v) / 0.05, 0, 1)
                    else:
                        # The face turned toward the camera, in the gap between
                        # one machine and the next. It is the darkest of the
                        # three and it is what makes them separate objects.
                        v *= 0.88
                    return v
                return sh
            abox(fb, lo, hi, mk)

            # Boxes on the low decks: pumps, controllers, a stack of trays. Each
            # one adds three more normals at mid depth, which is where the eye
            # goes looking for evidence that the frame has volume in it.
            if not tall:
                bz = z + 0.30
                while bz < z + length - 0.45:
                    bl = 0.30 + 0.35 * g.random()
                    bh = 0.22 + 0.34 * g.random()
                    bx = x_in + side * (0.30 + 1.1 * g.random())
                    alb2 = 0.48 + 0.30 * g.random()
                    abox(fb,
                         (min(bx, bx + side * 0.7), top, bz),
                         (max(bx, bx + side * 0.7), top + bh, bz + bl),
                         lambda pts, axis, a=alb2: matte(pts, eye, a, seed=131,
                                                         amp=0.20, period=0.22, f=f))
                    bz += bl + 0.25 + 0.5 * g.random()

            # Load ports on the tall tools, each with a carrier docked on it.
            # This is the detail that decides whether the frame is a fab or a
            # corridor of filing cabinets: a fab tool is not a smooth wall, it
            # has a waist-high shelf sticking into the aisle with a box on it,
            # and that shelf breaks the flat face with a lit top, a shadowed
            # underside and a cast shadow on the panel behind.
            if tall and g.random() < 0.72:
                pz = z + 0.35 + 0.6 * g.random() * max(0.0, length - 1.2)
                pw = 0.62
                px0 = x_in
                px1 = x_in - side * 0.34
                abox(fb, (min(px0, px1), 0.86, pz), (max(px0, px1), 1.02, pz + pw),
                     lambda pts, axis: matte(pts, eye, 0.50, seed=311,
                                             amp=0.12, period=0.2, f=f))
                cx0, cx1 = x_in - side * 0.05, x_in - side * 0.32
                abox(fb, (min(cx0, cx1), 1.02, pz + 0.06),
                     (max(cx0, cx1), 1.34, pz + pw - 0.06),
                     lambda pts, axis: matte(pts, eye, 0.66, seed=313,
                                             amp=0.10, period=0.12, f=f))

            # A stack lamp on the low decks. One bright dot at a known height,
            # repeated down the room at diminishing size, is a scale ruler the
            # eye reads without being told.
            if not tall and g.random() < 0.6:
                sz = z + 0.25
                sx = x_in - side * 0.12
                abox(fb, (min(sx, sx + side * 0.09), top, sz),
                     (max(sx, sx + side * 0.09), top + 0.30, sz + 0.09),
                     lambda pts, axis: matte(pts, eye, 0.30, seed=317,
                                             amp=0.10, period=0.05, f=f))
                quad(fb, (sx - 0.045, top + 0.30, sz), (sx + 0.045, top + 0.30, sz),
                     (sx + 0.045, top + 0.30, sz + 0.09), (sx - 0.045, top + 0.30, sz + 0.09),
                     lambda s: 1.30)
        z += length + 0.16


def fab_services(fb, eye, f, back):
    """Cable trays along the aisle and service runs across it."""
    # A cable tray running the length of the aisle just under the ceiling. It
    # crosses every lamp, which ties the ceiling to the walls.
    for side in (-1, 1):
        abox(fb, (side * 1.95 - 0.11, 2.72, 1.5), (side * 1.95 + 0.11, 2.86, back),
             lambda pts, axis: matte(pts, eye, 0.42, seed=307, amp=0.16, period=0.3, f=f))

    # Service runs crossing the aisle overhead. They are the only horizontals in
    # the upper half that are not part of the ceiling grid, so they read as
    # objects hung in the room rather than as more ceiling — and each one draws
    # a hard dark line across the lamps behind it, which is depth for free.
    for cz in np.arange(4.2, 40.0, 5.6):
        abox(fb, (-2.6, 2.90, cz), (2.6, 3.02, cz + 0.16),
             lambda pts, axis: matte(pts, eye, 0.34, seed=331, amp=0.14, period=0.25, f=f))


def fab_endwall(fb, eye, f, ceil, back):
    """The end wall, with a lit doorway. Something has to stop the aisle or the
    vanishing point is a hole."""
    quad(fb, (-26, 0, back), (26, 0, back), (26, ceil, back), (-26, ceil, back),
         matte([(-26, 0, back), (26, 0, back), (26, ceil, back)], eye, 0.66,
               seed=401, amp=0.14, period=0.8, f=f),
         uv=[(-26, 0), (26, 0), (26, ceil), (-26, ceil)])
    quad(fb, (-1.1, 0.02, back - 0.02), (0.5, 0.02, back - 0.02),
         (0.5, 2.25, back - 0.02), (-1.1, 2.25, back - 0.02),
         lambda s: 0.90)


def fab_cart(fb, eye, f, x0, z0):
    """A parts cart left in the aisle.

    Every fab photograph has one, and what it is doing here is breaking the
    regularity: a room built from a loop looks built from a loop until something
    in it is plainly where somebody put it.
    """
    abox(fb, (x0, 0.62, z0), (x0 + 0.73, 0.70, z0 + 0.9),
         lambda pts, axis: matte(pts, eye, 0.58, seed=337, amp=0.12, period=0.2, f=f))
    abox(fb, (x0, 0.20, z0), (x0 + 0.73, 0.26, z0 + 0.9),
         lambda pts, axis: matte(pts, eye, 0.44, seed=339, amp=0.12, period=0.2, f=f))
    for cx_ in (x0 + 0.05, x0 + 0.67):
        for cz_ in (z0 + 0.06, z0 + 0.82):
            abox(fb, (cx_ - 0.022, 0.0, cz_ - 0.022), (cx_ + 0.022, 0.62, cz_ + 0.022),
                 lambda pts, axis: matte(pts, eye, 0.36, seed=341, amp=0.10, period=0.1, f=f))
    abox(fb, (x0 + 0.09, 0.70, z0 + 0.12), (x0 + 0.61, 0.94, z0 + 0.76),
         lambda pts, axis: matte(pts, eye, 0.68, seed=343, amp=0.10, period=0.1, f=f))


def fab_person(fb, cam, eye, f, cx_, cz_, height, seed,
               rounded=False, visor_at=0.5, reach=0.0, albedo=0.33):
    """A gowned operator, as a camera-facing billboard with an analytic outline.

    Real geometry for a person is a week's work and would still look worse; what
    the frame needs from them is a familiar outline at a known height, because
    that is what tells a reader how big the room is.

    `rounded` is the banner's version. On the strip a figure is eighty pixels
    tall and a flat gradient across the gown is plenty; on the banner the near
    operator is more than half the height of the frame, and at that size a flat
    gradient reads as a paper cut-out. So the billboard is given a per-pixel
    normal — a body is a cylinder, near enough — and lit by the room's own lamps
    through `lamp_diffuse_n()`, so the light turns across them and falls off with
    their distance from the fittings overhead, which is what makes a large
    figure look like it is standing in the room rather than pasted onto it.
    """
    t = texture(seed, base=4)
    right = unit(np.cross(np.array([0.0, 1.0, 0.0]), cam.R[2]))
    toward = -cam.R[2]          # out of the billboard, back at the lens
    up = np.array([0.0, 1.0, 0.0])
    wid = height * 0.42
    c = np.array([cx_, 0.0, cz_])
    p0 = c - right * wid * 0.5
    p1 = c + right * wid * 0.5
    pts = [p0, p1, p1 + [0, height, 0], p0 + [0, height, 0]]

    def sh(s):
        u, v = s.u / wid, 1.0 - s.v / height   # 0..1, v down from the head
        # A hood, a neck, shoulders, then a gown that narrows to the boots.
        # The first attempt ran the head straight into the shoulders and the
        # result was a bowling pin; the two-vertex neck at v=0.16 is what
        # makes the outline read as a person at a glance.
        hw = np.interp(v, [0.00, 0.03, 0.09, 0.14, 0.17, 0.23, 0.33,
                           0.55, 0.66, 0.74, 0.90, 1.00],
                          [0.04, 0.10, 0.115, 0.10, 0.075, 0.27, 0.30,
                           0.29, 0.26, 0.235, 0.215, 0.205])
        # An arm put out toward the tool, on the low-u side because that is the
        # side the billboard's `right` points away from. A figure standing beside
        # a machine with both arms at their sides is waiting; one with an arm on
        # the load port is working, and the difference is four lines.
        # Narrow in v so it reads as an arm rather than as a cape, and long
        # enough in u to actually arrive: at 0.17 it stopped a quarter of a
        # metre short of the load port and the figure looked like it was
        # gesturing at the machine rather than working on it.
        hwl = hw + reach * np.exp(-((v - 0.41) / 0.075) ** 2)
        d = np.abs(u - 0.5)
        a = np.where(u < 0.5,
                     np.clip((hwl - (0.5 - u)) / 0.010, 0, 1),
                     np.clip((hw - (u - 0.5)) / 0.010, 0, 1))
        # The gap between the legs. A silhouette with no gap is a bollard.
        a *= 1.0 - np.clip((0.028 - d) / 0.009, 0, 1) * smoothstep(0.74, 0.80, v)

        # A bunny suit is white cloth, but a white subject rendered white
        # prints as a hole in the paper: there is no ink left to draw the
        # folds with. So it sits at about two thirds and gets its whiteness
        # from being lighter than everything around it, which is how a
        # photograph does it anyway.
        # Darker than the machine faces behind, and by a clear margin. In
        # the halftone the figure stands against a mid-grey panel, and a
        # mid-grey figure on a mid-grey panel is two areas of identical dot
        # density with a line between them — the screen loses it entirely.
        # Raising the gown to 0.62 was tried first and made it worse, since
        # that is exactly the panels' own value. A white bunny suit reading
        # as the DARKER shape looks wrong written down and is right on the
        # sheet: the aisle behind is lit floor, and against lit floor a
        # person is a silhouette in any photograph ever taken of one.
        if rounded:
            # The body as a cylinder: the surface turns away from the lens by up
            # to seventy degrees at the silhouette edge, and the head turns over
            # the top as well. Everything else about the figure is the same as
            # the strip's; only where the light comes from has changed.
            sx = np.clip((u - 0.5) / np.maximum(hw, 1e-4), -1.0, 1.0)
            ang = sx * 1.22
            sv = -0.55 * np.clip((0.10 - v) / 0.10, 0, 1)      # over the hood
            ch = np.sqrt(np.maximum(1e-6, 1.0 - sv * sv))
            nrm = (right[None, :] * (np.sin(ang) * ch)[:, None]
                   + up[None, :] * sv[:, None]
                   + toward[None, :] * (np.cos(ang) * ch)[:, None])
            sh = base_shade_n(nrm) + LAMP_GAIN * lamp_diffuse_n(nrm, s.P)
            # The gown ends up DARKER than the machine behind it, which is
            # the wrong way round for a white bunny suit and is nonetheless
            # what gets printed. Both alternatives were rendered and screened.
            # Lighter than the tool face, the figure lands on the tool face's
            # own value and the halftone loses it completely — twice, once at
            # 0.62 on the strip and once at 0.50 here. Equal to it, likewise.
            # Only the dark reading survives the screen, and a photograph in
            # which the subject cannot be seen is worse than one in which the
            # subject is a silhouette. Industrial photography is full of them.
            #
            # The constant is the bounce, and it is not a fudge. A troffer model
            # lights a horizontal surface well and a vertical one hardly at all,
            # because a lamp two metres overhead presents almost no cosine to a
            # person's chest. A cleanroom does not work like that: the aisle is
            # a white floor and two runs of lit machine faces, all of it
            # throwing light sideways, and that bounce is most of what falls on
            # somebody standing in it. Without the term the operator rendered as
            # a black cut-out with the top of their hood lit, which is what the
            # first banner came back as.
            lum = albedo * (0.44 + sh)
            lum *= 1.0 - 0.16 * v
            lum *= 1.0 + 0.13 * (2 * sample(t, u * 4.5, v * 9.0) - 1)
        else:
            # `albedo` scales this branch too, so a near figure can be carried
            # darker than a distant one. It matters after the ceiling was
            # lightened: the frame's whole upper mass came up, the tone curve
            # compensated by lifting everything, and the near operator — which
            # is the only object in the strip a reader can measure the room
            # against — went with it and lost its edge against the machine face.
            lum = albedo * (1.0 - 0.205 * v)
            lum *= 0.78 + 0.36 * (1.0 - u)                     # the key is left
            lum *= 1.0 + 0.20 * (2 * sample(t, u * 2.5, v * 5.0) - 1)
        # Folds — and note that the scale differs between the two branches
        # rather than sitting out here where it would apply to both. It was out
        # here for one render and it changed the strip's figures too, which the
        # byte comparison caught: the strip's tiles are committed and its
        # people are eighty pixels tall, where blobs this coarse are cloth. At
        # banner size the same blobs are three centimetres across on somebody's
        # chest and read as camouflage, so the rounded branch runs the noise at
        # nearly twice the frequency and half the depth.
        lum *= 1.0 + 0.26 * np.exp(-((v - 0.24) / 0.05) ** 2)       # shoulders
        lum *= 1.0 - 0.34 * np.exp(-((v - 0.19) / 0.035) ** 2)      # neck shadow
        lum *= 1.0 - 0.26 * smoothstep(0.93, 1.0, v)                # boots
        # The arms, as two soft creases down the gown. Without them the
        # torso is one unbroken tone and the figure prints as a bollard in a
        # hood; with them the outline acquires an inside.
        for au in (0.235, 0.765):
            lum *= 1.0 - 0.20 * (np.exp(-((u - au) / 0.028) ** 2)
                                 * smoothstep(0.26, 0.34, v)
                                 * (1 - smoothstep(0.62, 0.72, v)))
        # The visor. It is the one dark thing on the figure and it is what
        # tells a reader which way they are facing.
        visor = (np.clip((0.070 - np.abs(u - visor_at)) / 0.012, 0, 1)
                 * np.clip((0.042 - np.abs(v - 0.085)) / 0.012, 0, 1))
        if rounded:
            # Multiplicative, so it is always darker than whatever the gown is
            # doing locally. The flat branch paints an absolute 0.19, which was
            # fine while every figure sat near 0.44 and INVERTED the moment the
            # foreground one was carried down to 0.26 to hold the black end of
            # the range: the gown went darker than the visor and the head lost
            # the one feature that says which way somebody is facing.
            lum = lum * (1.0 - 0.45 * visor)
        else:
            lum = lum * (1 - visor) + 0.19 * visor
        return lum, a
    poly(fb, pts, sh, uv=[(0, 0), (wid, 0), (wid, height), (0, height)])

    # The shadow they cast. It multiplies what is already on the floor
    # rather than painting a grey ellipse, so it darkens the panel lines and
    # the specular alike, which is what a shadow does.
    r = height * 0.34
    quad(fb, (cx_ - r, 0.004, cz_ - r * 0.7), (cx_ + r, 0.004, cz_ - r * 0.7),
         (cx_ + r, 0.004, cz_ + r * 0.7), (cx_ - r, 0.004, cz_ + r * 0.7),
         lambda s: (s.dst * 0.52,
                    np.clip(1.25 - np.hypot(s.u / r, s.v / (r * 0.7)), 0, 1) * 0.85),
         uv=[(-r, -r * 0.7), (r, -r * 0.7), (r, r * 0.7), (-r, r * 0.7)])


# --- plate: the fab, the strip ---------------------------------------------

def plate_fab(h, w):
    """A cleanroom aisle, wide lens, from about where an operator would stand.

    The frame is 3.6:1, which is a corridor's proportions, so the picture is the
    aisle itself: raised floor below, filter ceiling above, process tools down
    both sides, a gowned figure at mid depth for scale. The camera sits right of
    the centreline and yaws left, because a symmetric corridor reads as a
    rendering and an asymmetric one reads as somewhere a person stood.
    """
    cam = Camera(eye=(0.85, 1.60, 0.0), target=(-0.55, 1.34, 16.0),
                 w=w, h=h, hfov_deg=78.0)
    fb = Frame(cam, 0.80)
    eye, f = cam.eye, cam.f
    g = _rng(4711)

    CEIL, AISLE, BACK = 3.15, 2.30, 46.0
    lights = fab_lights(CEIL, BACK)
    set_lamps(lights)

    fab_shell(fb, eye, f, lights, CEIL, AISLE, BACK, ceil_emit=0.26)
    fab_banks(fb, eye, f, g, AISLE, BACK)
    fab_services(fb, eye, f, BACK)
    fab_endwall(fb, eye, f, CEIL, BACK)

    # One near and cropped, one small and deep. The near one is what gives the
    # aisle its size — a reader knows how tall a person is and nothing else in
    # the frame carries that information.
    # Both stand where the AISLE is behind them rather than a machine face.
    # The near one was a metre and a third off the centreline and screened away
    # to nothing: it was a mid-grey shape in front of a mid-grey panel, and a
    # halftone has no way to draw that edge. Half a metre further in and the
    # background behind it is lit floor all the way to the far end.
    fab_person(fb, cam, eye, f, -0.62, 5.5, 1.74, 811, albedo=0.37)
    fab_person(fb, cam, eye, f, 0.72, 15.0, 1.68, 823, albedo=0.44)

    fab_cart(fb, eye, f, 1.05, 8.4)

    fog(fb, 0.94, 34.0)
    # A last, gentle unevenness across the whole frame: lamps are not identical
    # and a cleanroom is not lit flat. It used to be four times this deep and
    # over cells the size of a machine, which put grey smudges on the near tools
    # that read as dirt on the lens rather than as light in a room.
    fb.lum *= 0.96 + 0.08 * fractal(h, w, 97, base=10)
    return fb.lum


# --- plate: the fab, the banner --------------------------------------------

def fab_hero_tool(fb, eye, f, x_in, z0, z1, top, port_z):
    """The one tool the picture is actually about, with the operator at it.

    The generated banks are a run of anonymous machines and that is their job;
    this one is drawn by hand because the eye has to land somewhere. It carries
    the load port the operator is working at, an open service panel with the
    lit interior showing, and a stack lamp on the roof.

    Its face stands four centimetres proud of the bank behind it. That is not a
    detail about fabs, it is a detail about depth buffers: two faces at the same
    x would fight for the same pixels and come back stitched. Four centimetres
    is invisible at this distance and settles the argument.
    """
    face = x_in + 0.04
    tex = texture(521, base=5)

    def mk(pts, axis):
        n = face_normal(pts, eye)
        b = base_shade(n)

        def sh(s):
            v = 0.62 * (b + LAMP_GAIN * lamp_diffuse(n, s.P))
            ta = sample(tex, s.u / 0.45, s.v / 0.45)
            v *= 1.0 + 0.11 * (2 * ta - 1) * mip(s.z, f, 0.45)
            if axis == "x":
                sm = stripe(s.u / 0.62, 0.010, (s.z / f) / 0.62)
                sl = stripe(s.u / 0.62 - 0.030, 0.008, (s.z / f) / 0.62)
                v *= 1.0 - 0.30 * sm + 0.16 * sl
                # A shallower plinth than the generated tools carry. Theirs is
                # a dark band a metre up a machine three metres away; this one
                # is a metre up a machine that fills the left edge of the frame,
                # where the same fraction is a tenth of the sheet in solid ink.
                v *= 1.0 - 0.20 * smoothstep(0.30, 0.09, s.v)
                v *= 1.0 + 0.16 * (smoothstep(0.74, 0.86, s.v)
                                   - smoothstep(1.00, 1.16, s.v))
                v *= 1.0 + 0.55 * np.clip((0.035 - np.abs(s.v - top)) / 0.02, 0, 1)
            return v
        return sh
    abox(fb, (face - 3.7, 0.0, z0), (face, top, z1), mk)

    # The load port: a waist-high shelf INTO THE AISLE with a carrier docked on
    # it. This is what the operator's hand is on. Into the aisle is +x with the
    # eye where it is, and the first version had it at face - 0.34, which put
    # the whole thing inside the cabinet where the operator was reaching for a
    # shelf nobody could see.
    abox(fb, (face, 0.86, port_z), (face + 0.54, 1.02, port_z + 0.62),
         lambda pts, axis: matte(pts, eye, 0.50, seed=311, amp=0.12, period=0.2, f=f))
    abox(fb, (face + 0.05, 1.02, port_z + 0.06), (face + 0.34, 1.38, port_z + 0.56),
         lambda pts, axis: matte(pts, eye, 0.68, seed=313, amp=0.10, period=0.12, f=f))

    # An open service panel further down the tool, with the inside lit. It is a
    # small hard-edged bright shape at head height beside a small hard-edged
    # dark one — the visor — and a reader's eye goes to that pair before it goes
    # anywhere else in the frame.
    # There was an open service panel here for four renders — a lit rack behind
    # a dark surround — and it is gone. In the halftone it read, every time, as
    # a framed picture hung on the wall: a rectangle of regular pattern inside a
    # black border is a picture frame to a reader before it is anything else,
    # and no amount of irregular shelving changed that. The reason is
    # structural. A recess reads as a recess because you can see INTO it at an
    # angle, and this one was a flat quad lying on the surface of the cabinet.
    # Drawing it properly means cutting a hole in a box, which the rasteriser
    # here cannot do, and faking it cost the frame its subject twice over.
    #
    # What is left is what actually breaks up a machine face in a fab
    # photograph: pipework run along it, and a console small enough to read as a
    # fitting. Both are cheap and both survive the screen.
    for (cy, cr) in ((1.96, 0.055), (2.14, 0.038)):
        abox(fb, (face, cy - cr, z0), (face + 2 * cr, cy + cr, z1),
             lambda pts, axis: matte(pts, eye, 0.68, seed=533, amp=0.10,
                                     period=0.3, f=f))
    # Drops from the conduit into the cabinet, at a pitch that does not divide
    # the panel seams'. Two regular rhythms at the same pitch beat against each
    # other under a screen; at different pitches they read as two systems.
    for dz in np.arange(z0 + 0.42, z1 - 0.2, 0.93):
        abox(fb, (face, 1.30, dz), (face + 0.045, 1.94, dz + 0.045),
             lambda pts, axis: matte(pts, eye, 0.60, seed=537, amp=0.10,
                                     period=0.12, f=f))

    # The console: a screen in a bezel, on a stalk, at the port. Kept to a hand
    # span for the reason the generated tools' screens are — at any larger size
    # a lit rectangle stops being a fitting and becomes the subject.
    sz0 = port_z - 0.34
    abox(fb, (face + 0.06, 1.02, sz0), (face + 0.12, 1.34, sz0 + 0.06),
         lambda pts, axis: matte(pts, eye, 0.44, seed=539, amp=0.10, period=0.1, f=f))
    abox(fb, (face + 0.02, 1.34, sz0 - 0.10), (face + 0.16, 1.52, sz0 + 0.24),
         lambda pts, axis: matte(pts, eye, 0.24, seed=545, amp=0.08, period=0.1, f=f))
    quad(fb, (face + 0.165, 1.365, sz0 - 0.075), (face + 0.165, 1.365, sz0 + 0.215),
         (face + 0.165, 1.495, sz0 + 0.215), (face + 0.165, 1.495, sz0 - 0.075),
         lambda s: 0.88 + 0.14 * np.sin(s.v * 61.0),
         uv=[(0, 0), (0.29, 0), (0.29, 0.13), (0, 0.13)])

    # A stack lamp on the roof, and the tool's own controller box.
    sx = face - 0.30
    abox(fb, (sx, top, z0 + 0.55), (sx + 0.10, top + 0.34, z0 + 0.65),
         lambda pts, axis: matte(pts, eye, 0.30, seed=317, amp=0.10, period=0.05, f=f))
    quad(fb, (sx, top + 0.34, z0 + 0.55), (sx + 0.10, top + 0.34, z0 + 0.55),
         (sx + 0.10, top + 0.34, z0 + 0.65), (sx, top + 0.34, z0 + 0.65),
         lambda s: 1.30)
    abox(fb, (face - 1.30, top, z0 + 1.10), (face - 0.45, top + 0.42, z0 + 2.05),
         lambda pts, axis: matte(pts, eye, 0.54, seed=531, amp=0.14, period=0.2, f=f))


def plate_fab_tall(h, w):
    """The same fab, at 2:1, with an operator at a load port as the subject.

    The strip is a picture of a room and it works because a corridor is the
    right shape for a 3.6:1 frame. A banner is not a corridor, and photographing
    the same corridor with more sky over it would give a third of the front page
    to a ceiling. So this is the other picture a photographer takes on the same
    visit: they turn toward the nearest tool, wait for the operator to put a
    hand on the load port, and shoot at a longer lens from closer in.

    The composition is a triangle. The operator stands on the left third at more
    than half the height of the frame; the tool they are working at fills the
    left edge and carries the one bright highlight below the ceiling; the aisle
    runs out to the right and takes the eye to a second, much smaller figure.
    The lens is 68 degrees rather than 78 — wide, but not so wide that the near
    machine bends, which it would need to be to fit a corridor into this shape.
    """
    cam = Camera(eye=(1.25, 1.55, 0.0), target=(-1.30, 1.00, 9.5),
                 w=w, h=h, hfov_deg=68.0)
    fb = Frame(cam, 0.80)
    eye, f = cam.eye, cam.f
    g = _rng(9377)

    CEIL, AISLE, BACK = 3.15, 2.30, 46.0
    lights = fab_lights(CEIL, BACK)
    set_lamps(lights)

    fab_shell(fb, eye, f, lights, CEIL, AISLE, BACK, ceil_emit=0.26)
    # The banks start beyond the hero tool on this plate. They would otherwise
    # be laid out through the space it occupies, and while the depth buffer
    # would sort that out, the machine the picture is about would have somebody
    # else's control screen showing through the gaps around it.
    fab_banks(fb, eye, f, g, AISLE, BACK, z0=7.0)
    fab_services(fb, eye, f, BACK)
    fab_endwall(fb, eye, f, CEIL, BACK)

    fab_hero_tool(fb, eye, f, -AISLE, 1.85, 6.90, 2.42, port_z=5.90)
    # The right-hand bank has nothing in front of it for the first few metres,
    # so it gets its own near tool to close the right edge at the bottom.
    abox(fb, (AISLE, 0.0, 2.60), (AISLE + 3.7, 1.34, 6.40),
         lambda pts, axis: matte(pts, eye, 0.64, seed=541, amp=0.13, period=0.4, f=f))
    abox(fb, (AISLE + 0.18, 1.34, 3.10), (AISLE + 1.05, 1.86, 4.30),
         lambda pts, axis: matte(pts, eye, 0.70, seed=543, amp=0.12, period=0.2, f=f))

    fab_cart(fb, eye, f, 0.92, 10.4)

    # The subject, and one more far down the aisle so the eye has somewhere to
    # go after it. The near one is rounded and lit by the room's lamps; at 55%
    # of the frame height a flat gown would be a cut-out.
    # Three figures, at three depths, and the near one is the subject.
    #
    # This plate ran without a foreground figure for several versions and read
    # as an establishing shot — the kind of picture a paper runs inside, not the
    # one it leads with. An empty corridor of tool bays does argue the story's
    # point (nobody is adding capacity, the 2026 budget is maintenance only),
    # and that argument was worth something. But it is not worth the dominant
    # picture on the page having nothing for the eye to land on and no object of
    # known size to measure the room against, and the story survives the change:
    # a technician walking an aisle of tools that are not running new capacity,
    # past a colleague working an open load port, IS maintenance-only capex.
    #
    # The near one stands at 81% of the width, clear to the right of the
    # vanishing point at 70%, so the corridor still runs to a point rather than
    # into somebody's back. That was the whole risk in putting a figure here.
    # Carried a stop darker than the other two. Removing the black bar along
    # the top necessarily took the top off the density range with it — there is
    # no way to delete the darkest thing in a frame and keep its darkest value —
    # and a photograph with no near-solid anywhere has no snap. So the black
    # goes back at the SUBJECT, in the lower right, which is where a picture
    # editor would want it and is nowhere near the edge that meets type.
    fab_person(fb, cam, eye, f, 1.75, 3.60, 1.76, 871, rounded=True, albedo=0.28)
    # Pushed a metre and a bit further down the tool than it was. At 5.05 this
    # figure stood 55% of the frame's height against the near one's 69%, and two
    # figures within a quarter of each other in size read as one distance, which
    # is the opposite of what a second figure is for. At 6.2 it is 40%, and the
    # three of them now step down 69 / 40 / 12 — a depth ladder rather than a
    # crowd.
    fab_person(fb, cam, eye, f, -1.05, 6.20, 1.76, 857,
               rounded=True, visor_at=0.42, reach=0.42)
    fab_person(fb, cam, eye, f, 0.42, 14.0, 1.70, 863)

    fog(fb, 0.94, 34.0)
    fb.lum *= 0.96 + 0.08 * fractal(h, w, 149, base=10)
    return fb.lum


# --- plate: the wafer -----------------------------------------------------

def plate_wafer(h, w):
    """A 300 mm wafer on a chuck, under a ring light, seen from about a metre.

    Silicon is a dark mirror, so almost everything the eye sees on a wafer is
    the reflection of the lamp above it. That is modelled literally: the
    environment is a painted ceiling plane, and every pixel of the disc traces
    its own reflected ray up to that plane and reads what is there. What comes
    back is the conic section of a real ring lamp, which is why it lies on the
    disc the way it does in a photograph and not the way a cosine of the polar
    angle does — that was the previous version, and it drew a bow tie.

    The lamp is not placed by hand. `mirror_hit()` is run once for the centre of
    the wafer to find out where on the ceiling the middle of the frame is
    looking, and the ring is hung around that point, offset by a third of its
    radius so the crescent falls across the disc rather than ringing it. Move
    the camera and the highlight follows, because it is a reflection of
    something and not a shape painted onto a circle.
    """
    # Close enough that the disc is three quarters of the frame's width. It was
    # shot from a metre away for several passes and the frame was 60% stage and
    # background — flat surfaces at one tone each, which took over the histogram
    # and left the subject with a third of the range to live in. Filling the
    # frame with the subject is not a compositional preference here, it is what
    # makes the subject's own range BE the frame's range.
    cam = Camera(eye=(0.088, 0.262, -0.392), target=(0.0, 0.0, 0.016),
                 w=w, h=h, hfov_deg=46.0)
    fb = Frame(cam, 0.62)
    eye, f = cam.eye, cam.f
    R = 0.150
    up = np.array([0.0, 1.0, 0.0])
    ENV_Y = 0.62

    def mirror_hit(P, plane_y):
        """Where the ray from the eye to P, bounced off y=0, crosses y=plane_y."""
        P = np.atleast_2d(np.asarray(P, float))
        V = P - eye[None, :]
        V /= np.maximum(1e-9, np.linalg.norm(V, axis=1))[:, None]
        Rr = V - 2.0 * (V @ up)[:, None] * up[None, :]
        t = (plane_y - P[:, 1]) / np.maximum(Rr[:, 1], 1e-3)
        return P[:, 0] + t * Rr[:, 0], P[:, 2] + t * Rr[:, 2]

    # Where the middle of the disc is looking, and how far across the ceiling
    # the whole disc's gaze spreads. Both are measured rather than assumed: a
    # 300 mm mirror 0.63 m from the lens with the ceiling 0.62 m above it sweeps
    # about 0.84 m of ceiling, which is nearly three times the wafer's own
    # width. Sizing a lamp as if the reflection were life-size is what made the
    # first ring vanish — it was a fifth of the footprint and fell in a corner.
    cxz = mirror_hit([[0.0, 0.0, 0.0]], ENV_Y)
    exz = mirror_hit([[R, 0.0, 0.0], [-R, 0.0, 0.0]], ENV_Y)
    SPREAD = float(abs(exz[0][0] - exz[0][1])) * 0.5
    LX, LZ = float(cxz[0][0]) + 0.42 * SPREAD, float(cxz[1][0]) - 0.34 * SPREAD
    etex = texture(53, base=3)

    # The ring is a real object in the room, so the stage and the tool behind it
    # are lit by it too — sampled at eight points, because a ring lamp a hand's
    # width across does not light a chuck like a single dot.
    set_lamps([(LX + 0.15 * math.cos(a), ENV_Y, LZ + 0.15 * math.sin(a))
               for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)]
              + [(LX - 0.30, ENV_Y, LZ + 0.05)],
              power=1.0 / 9.0, falloff=1.4)

    def env(x, z):
        """The ceiling, painted: a ring lamp, a soft box, and dark structure.

        The structure matters as much as the lamps. A wafer that reflects an
        even grey sky is a grey circle; a wafer that reflects a ceiling with
        things on it has something for the halftone to screen everywhere, not
        just under the highlight.
        """
        r = np.hypot(x - LX, z - LZ)
        # Every length below is a fraction of SPREAD, so the lamp stays the
        # right size on the disc if the camera moves. Two Gaussians, not one: a
        # tube has a bright core and a wide falloff off the diffuser around it.
        # A single narrow lobe clips to flat paper and takes the die grid with
        # it — the crescent came out as a white hole with no silicon inside it.
        ring = np.exp(-((r - 0.46 * SPREAD) / (0.085 * SPREAD)) ** 2) * 1.00
        ring += np.exp(-((r - 0.46 * SPREAD) / (0.26 * SPREAD)) ** 2) * 0.26
        boxlight = np.exp(-(((x - LX + 1.05 * SPREAD) / (0.40 * SPREAD)) ** 2
                            + ((z - LZ - 0.20 * SPREAD) / (0.85 * SPREAD)) ** 2)) * 0.30
        # Two bars of ceiling structure, which come back as dark curves across
        # the silicon. They matter: a mirror reflecting nothing but a lamp is a
        # bright shape on a flat field, and it is the DARK reflections that tell
        # a reader the surface is polished rather than merely pale.
        rail = -0.20 * np.exp(-((z - LZ + 0.62 * SPREAD) / (0.10 * SPREAD)) ** 2)
        rail -= 0.13 * np.exp(-((x - LX - 0.80 * SPREAD) / (0.13 * SPREAD)) ** 2)
        # The base level matters more than any of the above. At 0.14 the
        # unlit silicon printed as near-black and the plate scored 24% midtones
        # — a bright arc on a dark disc, which is a hard drive platter, not a
        # wafer. A cleanroom ceiling is a large dull white thing, so the floor
        # of the environment is high and the ring is a lift on top of it.
        # A ceiling that is bright at one end and dim at the other. This is the
        # term that decides whether the disc has a photograph's tonal range
        # ACROSS ITSELF or is a uniformly lit circle with a highlight on it —
        # and it was the latter for four attempts. With an even ceiling the
        # mirror returns one value everywhere the lamp is not, the whole disc
        # lands on one tone, and `fill_histogram` then hauls that tone up to the
        # frame's mean because the disc is most of the frame. A room is not
        # evenly lit, and a mirror is the surface that shows it.
        sweep = 0.78 * smoothstep(-0.85, 1.15, (x - LX) / SPREAD)
        dull = 0.19 + 0.12 * sample(etex, x * 2.4, z * 2.4)
        return dull + sweep + ring + boxlight + rail

    # --- the tool interior behind. Out of focus, but a frame whose background
    # is blank paper reads as a cut-out; this gives the disc something to be in
    # front of.
    # The texture period here is deliberately long. At 10 cm it read as stucco:
    # a 2 m wall an arm's length behind the subject was covered in blobs the
    # size of the wafer, and the eye put them in the same plane as the dice.
    quad(fb, (-1.2, -0.30, 0.62), (1.2, -0.30, 0.62), (1.2, 0.90, 0.62), (-1.2, 0.90, 0.62),
         matte([(-1.2, -0.30, 0.62), (1.2, -0.30, 0.62), (1.2, 0.90, 0.62)], eye, 0.40,
               seed=151, amp=0.11, period=0.55, f=f, lamp=0.20),
         uv=[(-1.2, -0.30), (1.2, -0.30), (1.2, 0.90), (-1.2, 0.90)])
    abox(fb, (-0.62, -0.30, 0.44), (-0.20, 0.34, 0.60),
         lambda pts, axis: matte(pts, eye, 0.34, seed=157, amp=0.16, period=0.14, f=f,
                                 lamp=0.20))
    quad(fb, (0.10, 0.10, 0.605), (0.52, 0.10, 0.605), (0.52, 0.34, 0.605), (0.10, 0.34, 0.605),
         lambda s: 0.66)

    # --- the stage: a rectangular base and a round chuck. The chuck is round
    # because the wafer is, and a curved side band under a flat ellipse is the
    # cheapest solid object there is — three tones on one shape and the eye has
    # a cylinder.
    # Deliberately DARKER than the wafer. The plate scored 31% midtones with a
    # stage brighter than its subject: the tone stretch found its 92nd
    # percentile out in the stage, clipped that to paper, and pushed the silicon
    # down into the shadows. A wafer under a ring light is the brightest thing
    # in its own photograph, and the way to make it so is to put nothing bright
    # behind it, not to turn the lamp up.
    abox(fb, (-0.30, -0.16, -0.26), (0.30, -0.035, 0.30),
         lambda pts, axis: matte(pts, eye, 0.26, seed=59, amp=0.10, period=0.17, f=f,
                                 lamp=0.20))

    NC = 96
    ca = np.linspace(0, 2 * np.pi, NC, endpoint=False)
    RC = 0.168
    cr = np.stack([RC * np.cos(ca), np.zeros(NC), RC * np.sin(ca)], axis=1)
    chuck_top = matte([(0, -0.004, 0), (1, -0.004, 0), (0, -0.004, 1)], eye, 0.38,
                      seed=61, amp=0.14, period=0.09, f=f, lamp=0.22)
    for i in range(NC):
        j = (i + 1) % NC
        p0 = cr[i] + [0, -0.004, 0]
        p1 = cr[j] + [0, -0.004, 0]
        poly(fb, [(0, -0.004, 0), p0, p1], chuck_top,
             uv=[(0, 0), (p0[0], p0[2]), (p1[0], p1[2])])
        # The side band, one quad per segment, each with its own normal — which
        # is the entire reason it looks round instead of like a drawn circle.
        side = [(p0[0], -0.004, p0[2]), (p1[0], -0.004, p1[2]),
                (p1[0], -0.042, p1[2]), (p0[0], -0.042, p0[2])]
        n = unit([np.cos(ca[i]), 0.0, np.sin(ca[i])])
        if float(np.dot(n, eye - np.asarray(side).mean(axis=0))) <= 0:
            continue
        b = base_shade(n)
        poly(fb, side, (lambda b: lambda s: 0.44 * b * (1 + 0.10 * np.sin(s.v * 700)))(b),
             uv=[(0, 0), (0.01, 0), (0.01, 0.038), (0, 0.038)])

    # --- the wafer, as a fan with a notch cut into the rim. The notch is a
    # couple of vertices pulled inward: it is the detail that says which way is
    # up on a wafer, and it costs one line.
    N = 240
    ang = np.linspace(0, 2 * np.pi, N, endpoint=False)
    rad = np.full(N, R)
    notch = np.abs(((ang - 2.15 + np.pi) % (2 * np.pi)) - np.pi)
    rad -= 0.011 * np.clip(1.0 - notch / 0.070, 0, 1)
    rim = np.stack([rad * np.cos(ang), np.zeros(N), rad * np.sin(ang)], axis=1)

    dietex = texture(67, base=6)
    DIE = 0.0086

    def wafer_sh(s):
        x, z = s.u, s.v
        r = np.hypot(x, z)
        hx, hz = mirror_hit(s.P, ENV_Y)
        spec = env(hx, hz)

        # Scribe streets between the dice, and a slow variation from one die to
        # the next. The streets are matte, so they knock the reflection down
        # rather than adding ink of their own — which is why on real silicon
        # they disappear inside the bright crescent and reappear outside it.
        #
        # The die was 12.6 mm in the first pass, which put twenty-three of them
        # across the disc and drew graph paper. A memory die is small; making it
        # so takes the grid below the frequency at which the eye reads "ruled
        # lines" and up to where it reads "surface", which is the only place a
        # halftone can do anything useful with it.
        fw = (s.z / f) / DIE
        street = np.maximum(stripe(x / DIE, 0.040, fw), stripe(z / DIE, 0.040, fw))
        # Two scales of variation across the surface: die to die, and the slow
        # swirl of film thickness that every real wafer photograph shows. The
        # second is what keeps the disc from being a flat field with a grid
        # ruled on it — which is what it was, and it printed as a sieve.
        die = 0.92 + 0.16 * sample(dietex, x / (DIE * 4), z / (DIE * 4))
        die *= 0.88 + 0.24 * sample(dietex, x / 0.11 + 3.0, z / 0.11 + 3.0)
        # Edge exclusion: the outermost few millimetres carry no printed dice.
        street *= 1.0 - smoothstep(R - 0.011, R - 0.004, r)

        # The additive term is small on purpose. It is the light the silicon
        # scatters rather than reflects, and every point of it added here is
        # contrast taken away from the reflection: at 0.14 with a gain of 0.52
        # the whole lit half of the disc came out above the tone stretch's 92nd
        # percentile and clipped to flat paper, which looked like a drum head.
        v = 0.05 + 0.36 * spec * die
        # The streets are a whisper. At a third they drew graph paper across the
        # whole disc and the eye read a mesh; the subject of the picture is the
        # light on the silicon, and the grid is the evidence that it is silicon.
        v *= 1.0 - 0.60 * street
        # The bevel. The last two millimetres of a wafer curve away from the
        # ceiling and catch the room instead, so the rim is a bright hairline
        # with a dark one outside it — which is what reads as an edge with a
        # thickness rather than as a cut-out.
        v += 0.55 * smoothstep(R - 0.0050, R - 0.0016, r) * (1 - smoothstep(R - 0.0016, R - 0.0004, r))
        v *= 1.0 - 0.45 * smoothstep(R - 0.0016, R + 0.0004, r)
        return v

    for i in range(N):
        j = (i + 1) % N
        poly(fb, [(0, 0, 0), rim[i], rim[j]], wafer_sh,
             uv=[(0, 0), (rim[i][0], rim[i][2]), (rim[j][0], rim[j][2])])

    # --- a vacuum wand over the wafer, and its reflection in it. The wand is
    # what makes this an inspection and not a still life; the reflection is what
    # proves the wafer is a mirror rather than a disc of grey card. It is the
    # same ray as the lamp uses, stopped at a lower plane.
    WY, WZ = 0.055, 0.020
    abox(fb, (-0.34, WY - 0.007, WZ - 0.007), (0.015, WY + 0.007, WZ + 0.007),
         lambda pts, axis: matte(pts, eye, 0.30, seed=71, amp=0.16, period=0.02, f=f,
                                 lamp=0.18))
    abox(fb, (0.005, WY - 0.012, WZ - 0.012), (0.052, WY + 0.012, WZ + 0.012),
         lambda pts, axis: matte(pts, eye, 0.44, seed=73, amp=0.12, period=0.02, f=f,
                                 lamp=0.18))

    def wand_reflection(s):
        hx, hz = mirror_hit(s.P, WY)
        hit = ((hx > -0.34) & (hx < 0.052) & (np.abs(hz - WZ) < 0.012)) * 1.0
        hit *= np.hypot(s.P[:, 0], s.P[:, 2]) < R - 0.002
        return s.dst * 0.55, hit * 0.60
    quad(fb, (-R, 0.0003, -R), (R, 0.0003, -R), (R, 0.0003, R), (-R, 0.0003, R),
         wand_reflection, uv=[(-R, -R), (R, -R), (R, R), (-R, R)])

    fog(fb, 0.60, 3.5)
    fb.lum *= 0.94 + 0.10 * fractal(h, w, 47, base=8)
    # The tool behind is a long way outside the plane of focus and the near lip
    # of the stage is a little outside it; the wafer is in it.
    defocus(fb, focus=0.63, radius=max(2, int(0.016 * w)), gain=0.55)
    return fb.lum


# --- plate: the line ------------------------------------------------------

def plate_line(h, w):
    """A back-end line: trays of packaged parts on conveyors, running away.

    The conveyors are set on a diagonal rather than square to the frame, because
    a belt that recedes straight up the middle draws a symmetric wedge and a
    symmetric wedge is a diagram — the first pass did exactly that and came back
    looking like a flight of stairs. Off-axis, the two rails converge at
    different rates, the trays foreshorten unevenly, and the frame acquires a
    direction.

    There are two lines and not one for the same reason. With a single belt the
    right third of the frame was floor and far wall, a quarter of the sheet with
    nothing in it; a second line further out converges at its own rate, fills
    that third, and is what a back-end floor actually looks like.

    It is also the tightest of the three plates: at 364 x 204 a tray pocket is
    three pixels, so the parts in them are a shader on the tray's top face
    rather than three hundred more boxes. What matters at that size is that each
    pocket has a lit edge and a dark floor, not that it has vertices.
    """
    cam = Camera(eye=(1.05, 1.30, -0.95), target=(-0.34, 0.76, 2.30),
                 w=w, h=h, hfov_deg=54.0)
    fb = Frame(cam, 0.66)
    eye, f = cam.eye, cam.f
    g = _rng(9091)

    BELT, FAR = 0.78, 7.0
    lights = [(0.30, 2.05, z) for z in (0.2, 1.6, 3.2, 5.2)]
    lights += [(1.60, 2.05, z) for z in (2.2, 4.2)]
    set_lamps(lights)

    # --- the floor of the bay, far below and mostly out of shot; it stops the
    # bottom corners of the frame from being empty paper.
    quad(fb, (-8, 0, -1.4), (8, 0, -1.4), (8, 0, FAR), (-8, 0, FAR),
         matte([(-8, 0, -1.4), (8, 0, -1.4), (8, 0, FAR)], eye, 0.40,
               seed=83, amp=0.22, period=0.6, f=f),
         uv=[(-8, -1.4), (8, -1.4), (8, FAR), (-8, FAR)])

    # --- the machine housing across the back, and the tool that feeds the belt.
    # A far wall that is one flat tone is a hole; a far wall with structure on it
    # is a room with another room behind it. It is deliberately darker than the
    # belts, so the eye is not pulled out of the frame at the vanishing point —
    # which is what the first pass did with a blown-out window.
    quad(fb, (-8, 0, FAR), (8, 0, FAR), (8, 3.4, FAR), (-8, 3.4, FAR),
         matte([(-8, 0, FAR), (8, 0, FAR), (8, 3.4, FAR)], eye, 0.50,
               seed=89, amp=0.18, period=0.8, f=f),
         uv=[(-8, 0), (8, 0), (8, 3.4), (-8, 3.4)])
    abox(fb, (-2.6, 0.0, 5.4), (-0.75, 2.35, 6.9),
         lambda pts, axis: matte(pts, eye, 0.58, seed=139, amp=0.16, period=0.3, f=f))
    abox(fb, (2.10, 0.0, 5.0), (3.9, 1.95, 6.9),
         lambda pts, axis: matte(pts, eye, 0.44, seed=149, amp=0.18, period=0.3, f=f))
    quad(fb, (-2.30, 1.05, 5.38), (-1.05, 1.05, 5.38),
         (-1.05, 1.62, 5.38), (-2.30, 1.62, 5.38),
         lambda s: 0.92 - 0.16 * np.clip(s.v / 0.6, 0, 1),
         uv=[(0, 0), (1.25, 0), (1.25, 0.57), (0, 0.57)])

    # --- the trays. A JEDEC tray is black plastic, but black plastic under a
    # lamp bank is not black on paper: it is a mid grey with a hard highlight
    # along every moulded edge, and printing it as the ink it is named after
    # loses every one of those edges.
    ptex = texture(107, base=6)

    def tray_top(pts, axis):
        n = face_normal(pts, eye)
        if axis != "y":
            return matte(pts, eye, 0.50, seed=109, amp=0.16, period=0.05, f=f)

        def sh(s):
            pu, pv = 0.0285, 0.0325
            cu = ((s.u / pu) % 1.0) - 0.5
            cv = ((s.v / pv) % 1.0) - 0.5
            fu, fv = (s.z / f) / pu, (s.z / f) / pv
            inside = (np.clip((0.33 - np.abs(cu)) / np.maximum(fu, 1e-4) + 0.5, 0, 1)
                      * np.clip((0.35 - np.abs(cv)) / np.maximum(fv, 1e-4) + 0.5, 0, 1))
            b = base_shade(n) + LAMP_GAIN * lamp_diffuse(n, s.P)
            tray = 0.80 * b * (1 + 0.10 * (2 * sample(ptex, s.u / 0.02, s.v / 0.02) - 1))
            part = 0.40 * b
            # The lit edge on the near side of every part, and a dark one on the
            # far side. A grid of dark squares is a texture; a grid of dark
            # squares each with a highlight along one edge and a shadow along
            # the other is three hundred small objects.
            lit = np.clip((0.34 - np.abs(cv + 0.28)) / 0.14, 0, 1) * inside
            shd = np.clip((0.34 - np.abs(cv - 0.30)) / 0.14, 0, 1) * inside
            v = tray * (1 - inside) + part * inside
            v += (0.62 * lit - 0.16 * shd) * b
            return v
        return sh

    btex = texture(101, base=5)

    def conveyor(cx, z0, z1, wide, loaded):
        """One line: legs, a table, a belt with the lamps running down it, side
        rails and a run of trays. Written once and placed twice, because the
        second line has to converge on the SAME vanishing point as the first —
        two belts drawn by two sets of numbers would not, and the eye finds that
        immediately even when it cannot say what is wrong."""
        # The table's side was 0.38 on the single-belt version and it printed as
        # a black wedge cutting the frame in half. It is brushed stainless in a
        # lit room; what makes it read as metal is not that it is dark but that
        # it has a bright lip along the top and a shadowed rebate under it.
        abox(fb, (cx - wide - 0.12, 0.26, z0), (cx + wide + 0.12, BELT - 0.03, z1),
             lambda pts, axis: matte(pts, eye, 0.54, seed=97, amp=0.16, period=0.25, f=f))
        for side in (-1, 1):
            abox(fb, (cx + side * (wide + 0.13) - 0.015, BELT - 0.055, z0),
                 (cx + side * (wide + 0.13) + 0.015, BELT - 0.030, z1),
                 lambda pts, axis: matte(pts, eye, 0.80, seed=99, amp=0.08, period=0.2, f=f))
        for lz in np.arange(z0 + 0.4, z1 - 0.3, 1.45):
            for side in (-1, 1):
                abox(fb, (cx + side * wide - 0.035, 0.0, lz),
                     (cx + side * wide + 0.035, 0.30, lz + 0.07),
                     lambda pts, axis: matte(pts, eye, 0.44, seed=101,
                                             amp=0.14, period=0.1, f=f))

        bp = [(cx - wide, BELT, z0), (cx + wide, BELT, z0),
              (cx + wide, BELT, z1), (cx - wide, BELT, z1)]
        bn = face_normal(bp, eye)

        def belt_sh(s):
            v = 0.46 * (base_shade(bn) + LAMP_GAIN * lamp_diffuse(bn, s.P))
            v *= 1.0 - 0.20 * stripe(s.v / 0.11, 0.020, (s.z / f) / 0.11)
            t = sample(btex, s.u / 0.09, s.v / 0.09)
            v *= 1.0 + 0.22 * (2 * t - 1) * mip(s.z, f, 0.09)
            v += 0.26 * specular(bn, s.P, eye, lights, shine=34.0, falloff=0.05)
            return v
        quad(fb, *bp, belt_sh,
             uv=[(cx - wide, z0), (cx + wide, z0), (cx + wide, z1), (cx - wide, z1)])

        for side in (-1, 1):
            abox(fb, (cx + side * (wide + 0.06) - 0.026, BELT - 0.02, z0),
                 (cx + side * (wide + 0.06) + 0.026, BELT + 0.072, z1),
                 lambda pts, axis: matte(pts, eye, 0.74, seed=103,
                                         amp=0.10, period=0.1, f=f))

        zt = z0 + 0.2
        while zt < z1 - 0.4:
            if g.random() < loaded:
                abox(fb, (cx - wide + 0.04, BELT + 0.001, zt),
                     (cx + wide - 0.04, BELT + 0.032, zt + 0.215), tray_top)
            zt += 0.215 + 0.050 + 0.03 * g.random()

    conveyor(0.0, -1.2, FAR - 0.9, 0.34, 1.00)
    conveyor(1.15, 0.1, FAR - 0.6, 0.30, 0.72)

    # A trolley of empty trays parked beside the second line, and a duct
    # crossing above it. The right of the frame runs almost along the lines'
    # own vanishing direction, so anything placed out there is far away and
    # hazed; the only things that can fill that corner are objects standing
    # close to the lens, and these two are the ones a floor like this has.
    abox(fb, (1.02, 0.0, 0.30), (1.44, 0.62, 1.05),
         lambda pts, axis: matte(pts, eye, 0.42, seed=173, amp=0.14, period=0.15, f=f))
    for k in range(7):
        abox(fb, (1.05, 0.62 + k * 0.034, 0.34), (1.41, 0.62 + k * 0.034 + 0.026, 1.01),
             lambda pts, axis: matte(pts, eye, 0.62, seed=179, amp=0.10, period=0.08, f=f))
    abox(fb, (0.55, 1.94, 0.20), (3.4, 2.24, 0.62),
         lambda pts, axis: matte(pts, eye, 0.46, seed=181, amp=0.12, period=0.4, f=f))

    # --- a gantry over the near belt with a pick head on it, and a post
    # carrying it down to the floor on the far side. It crosses the frame near
    # the top, which closes the composition and gives the eye a hard dark shape
    # to measure the pale machinery against.
    abox(fb, (-2.2, 1.66, 1.30), (2.2, 1.80, 1.48),
         lambda pts, axis: matte(pts, eye, 0.30, seed=113, amp=0.16, period=0.2, f=f))
    abox(fb, (-1.28, 0.0, 1.32), (-1.10, 1.66, 1.46),
         lambda pts, axis: matte(pts, eye, 0.36, seed=117, amp=0.14, period=0.2, f=f))
    abox(fb, (-0.20, 1.14, 1.31), (0.16, 1.66, 1.47),
         lambda pts, axis: matte(pts, eye, 0.52, seed=127, amp=0.20, period=0.1, f=f))
    abox(fb, (-0.23, 1.02, 1.28), (0.19, 1.14, 1.50),
         lambda pts, axis: matte(pts, eye, 0.26, seed=131, amp=0.22, period=0.06, f=f))

    fog(fb, 0.76, 7.0)
    fb.lum *= 0.94 + 0.11 * fractal(h, w, 71, base=8)
    defocus(fb, focus=1.60, radius=max(2, int(0.011 * w)), gain=0.9)
    return fb.lum


PLATE_FN = {"fab": plate_fab, "wafer": plate_wafer, "line": plate_line,
            "fab_tall": plate_fab_tall}


# --- tone -----------------------------------------------------------------

def fill_histogram(img, lo_pct=1.5, hi_pct=94.0, target=0.50):
    """Stretch to the midtones, clip the speculars, then bend the mean to target.

    Two ways to get this wrong, and both were got wrong before this rule.

    Stretch between the extremes and the frame comes out black: a fab ceiling is
    lamps and a wafer is specular, so the top of the range ends up owned by a few
    hundred pixels nobody is looking at while the subject is squeezed into the
    bottom third. That is how the very first tiles printed.

    Take `hi` from a fixed high percentile of the WHOLE frame instead and the
    opposite happens as soon as the subject is small. The wafer plate is 60%
    dark stage and dark background, all piled within a fiftieth of each other,
    so the 92nd percentile of the frame landed just above that pile and INSIDE
    the disc — the disc clipped to paper and screened as a dinner plate.

    So the white point is taken from the upper half of the histogram: split at
    the median, then read a percentile of the brighter half. When the surround
    is flat and dark the upper half is mostly subject, and the white point lands
    on the subject's highlights where it belongs. When the frame is normally
    exposed and the highlight is a lamp covering three per cent of it, that lamp
    is still a small minority of the upper half and still clips, which is what a
    photographer does with a fitting in shot.

    The gamma is then solved rather than guessed: g = log(target)/log(mean)
    lands the mean exactly on target, and is clamped so a pathological frame
    gets a mediocre curve instead of a destroyed one.
    """
    lo = float(np.percentile(img, lo_pct))
    upper = img[img >= np.median(img)]
    hi = float(np.percentile(upper, hi_pct))
    img = np.clip((img - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    mean = float(img.mean())
    if 0.02 < mean < 0.98:
        # The clamp is a guard against a pathological frame getting a destroyed
        # curve rather than a mediocre one, and it earns its keep: the banner's
        # `target` silently stopped doing anything for two renders because the
        # solved gamma had gone under the old floor of 0.50 and every value
        # below it produced the same picture. The floor is 0.45 because that is
        # what the banner needs (0.468) with room to spare, and because the
        # nearest other plate solves to 0.508 and is therefore untouched by the
        # change — which the byte comparison confirms rather than assumes.
        g = math.log(target) / math.log(mean)
        img = img ** min(1.9, max(0.45, g))
    return img


def midtone_mass(img):
    """The acceptance number: how much of the frame is actually mid-grey.

    A halftone screen has its full vocabulary between about a quarter and three
    quarters; outside that it is running out of dots to turn off or on. A plate
    that scores low here will print as a silhouette however good its geometry
    is, so the figure goes on stdout next to the byte count.
    """
    return float(((img > 0.25) & (img < 0.75)).mean())


def render(kind, w, h, seed, target=0.50):
    img = PLATE_FN[kind](h * SS, w * SS)
    img = np.clip(img, 0.0, None)

    # Box-filter the supersample down. The rasteriser draws hard edges, so this
    # is the only anti-aliasing in the pipeline and it has to happen before the
    # screen sees the image.
    img = img.reshape(h, SS, w, SS).mean(axis=(1, 3))

    img = fill_histogram(img, target=target)
    img = np.clip(img + grain(h, w, seed, 0.022), 0.0, 1.0)
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--out", default=TILES, help="where the .bin tiles go")
    ap.add_argument("--keep-src", action="store_true",
                    help="also leave the source PNGs next to the tiles")
    ap.add_argument("--preview", action="store_true",
                    help="also write what the screened tile looks like on the panel")
    ap.add_argument("--only", help="render just this plate")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    # A plain run builds PLATES. Naming a plate explicitly also reaches the
    # shelf, so a parked camera stays inspectable without shipping a tile.
    for (name, w, h, kind, target, seed) in (PLATES + SHELVED if args.only else PLATES):
        if args.only and args.only != name:
            continue
        if w % 2:
            sys.exit(f"{name}: width {w} is odd; a tile packs two pixels to a byte")

        img = render(kind, w, h, seed, target)
        src = os.path.join(args.out, f"{name}.png")
        Image.fromarray((img * 255 + 0.5).astype(np.uint8), "L").save(src)

        dst = os.path.join(args.out, f"{name}.bin")
        cmd = [sys.executable, MAKE_TILE, src, "--out", dst,
               "--width", str(w), "--height", str(h), "--halftone",
               *TONE]
        if args.preview:
            cmd += ["--preview", os.path.join(args.out, f"{name}_screen.png")]
        subprocess.run(cmd, check=True)

        got = os.path.getsize(dst)
        want = w * h // 2
        if got != want:
            sys.exit(f"{name}: tile is {got} bytes, contract says {want}")
        print(f"{name}: {w}x{h}, {got} bytes, "
              f"mean {img.mean():.2f}, midtones {midtone_mass(img):.0%}")

        if not args.keep_src:
            os.remove(src)


if __name__ == "__main__":
    main()
