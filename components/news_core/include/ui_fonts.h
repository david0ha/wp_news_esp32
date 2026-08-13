/*
 * ui_fonts.h — the seven faces this board sets a newspaper in.
 *
 * All four families are SIL Open Font License 1.1 (fonts/OFL-*.txt), so the
 * generated bitmaps ship with this repo. They were chosen against the paper
 * being imitated rather than by taste:
 *
 *   masthead    blackletter                UnifrakturMaguntia
 *   headlines   a Didone — WP sets its     Playfair Display, at wght 800 for
 *               headlines in Postoni       the lead and 700 for the rest
 *   deck/body   a text serif               Source Serif 4
 *   labels      Franklin Gothic — WP's     Libre Franklin, which is a revival
 *               byline and kicker face     of exactly that face
 *
 * ## Every face is 1 bpp, and that is a measurement, not a default
 *
 * The panel has no grey. LVGL renders anti-aliased text as intermediate RGB565
 * and main.cpp's flush callback puts that through wp_quantize565(), which
 * ordered-dithers to the six inks. For a photograph that is correct. For text
 * it is destructive: a 16 px serif stem is about 1.5 px wide, so half of it is
 * anti-aliasing, and dithering that half turns a solid stem into a dotted one.
 * Rendered side by side, 4 bpp body text has holes punched through 'm', 'w' and
 * every descender, and the 112 px masthead grows a ragged stipple along
 * contours that 1 bpp keeps smooth.
 *
 * At 1 bpp every text pixel is exactly WP_RGB_BLACK or WP_RGB_WHITE, and
 * wp_quantize() maps both to themselves under every dither offset — so text
 * takes the quantizer's identity path and cannot pick up a colour fringe.
 *
 * ## Optical sizes are calculated, not chosen
 *
 * Source Serif 4 carries an `opsz` axis calibrated in points, and this panel's
 * pixel pitch is known (1600x1200 over 13.3" is 150.4 dpi), so each face is
 * instanced at the optical size its pixel size actually is. ui_font_body_16 is
 * 7.7 pt and instanced at opsz 8: sturdier stems and more open counters than
 * the same family at opsz 20, which is what survives a 1-bit render.
 *
 * ## Coverage
 *
 * Headlines, decks, bylines and body text arrive over the network and cannot be
 * subset, so every text face carries ASCII, all of Latin-1 (Bogotá, Zürich,
 * Müller are routine in a dateline) and the typography in S_DATA_PUNCT. A
 * character outside that renders as a tofu box; the simulator checks every
 * string in a snapshot against the face that will draw it, so it fails on a
 * laptop with the codepoint printed rather than silently on the glass.
 *
 * The masthead face carries all of A-Z, a-z and " .,'-&" rather than just the
 * letters S_MASTHEAD happens to use, so changing the paper's name does not
 * silently blank the largest text on the screen.
 *
 * ## Do not hand-edit
 *
 *     python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools
 *     /tmp/fontenv/bin/python tools/gen_fonts.py --download
 *
 * fontTools is needed because Google publishes three of these families only as
 * variable fonts, and lv_font_conv would silently take the default instance —
 * Playfair Regular where the table asks for Playfair Bold. The generated .c
 * files are committed, so a normal build needs neither node nor Python.
 */
#pragma once

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The paper's name, once, across the top. Subset; see above. */
extern const lv_font_t ui_font_masthead_112;

/* The lead story's headline, and nothing else. */
extern const lv_font_t ui_font_display_56;

/* Secondary headlines. */
extern const lv_font_t ui_font_display_36;

/* The standfirst under a headline. Italic, as a deck has been since Caslon. */
extern const lv_font_t ui_font_deck_24;

/* The lead story's body. */
extern const lv_font_t ui_font_body_20;

/* Column body text. */
extern const lv_font_t ui_font_body_16;

/* Bylines, datelines, kickers, section rules, photo captions, the folio line
 * and the ticker — everything set in small sans caps. */
extern const lv_font_t ui_font_label_14;

#ifdef __cplusplus
}
#endif
