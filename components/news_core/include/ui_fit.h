/*
 * ui_fit.h — the copyfit engine: how much of a story fits in a column.
 *
 * A newspaper page is a fixed grid of boxes and the copy is whatever the wire
 * sent that morning, so something has to decide where the text stops. On this
 * board that something cannot be LVGL. A label told to wrap inside 328 px will
 * set a fifteenth line at y=330 and let it hang across the rule below, because
 * LVGL clips to the widget and the widget is the thing we sized wrong. So the
 * cut is made here, in bytes, before a glyph is set — and it is made with
 * lv_text_get_size(), the same measurement LVGL will use to lay the label out.
 * That equality is the entire point: a string this file accepted cannot then
 * wrap onto a line that does not exist.
 *
 * Only body text comes through here. Headlines and decks are ellipsized at a
 * fixed height by ui_lab_w(), because a headline that loses its last word is
 * worse than one that shows an ellipsis and a headline is short enough that the
 * ellipsis is the rare case. Body copy is the opposite: it is always too long,
 * and a column ending in "..." reads as a truncated message rather than as a
 * column that continues below the fold.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* --- what this borrows from LVGL ------------------------------------------
 * Copyfitting is pure arithmetic wrapped around one measurement, so it is a
 * host test — and the host test compiles with components/news_core/include on
 * the path and nothing else, because there is no LVGL checkout for it to point
 * at. Where lvgl.h is reachable this is the real thing; where it is not, the
 * five declarations below are the whole of the surface ui_fit.c touches and the
 * test supplies the measurement itself.
 *
 * Two spellings of one API is a risk worth naming out loud: these are
 * transcribed from LVGL 9.5's src/misc/lv_area.h, lv_types.h and lv_text.h, and
 * the simulator compiles this same file against the real headers — so a
 * divergence fails on a laptop with a type error rather than on the glass with a
 * column of text over a rule.
 */
#if defined(__has_include)
#  if __has_include("lvgl.h")
#    define UI_FIT_WITH_LVGL 1
#  endif
#endif

#ifdef UI_FIT_WITH_LVGL
#include "lvgl.h"
#else
typedef struct { int32_t x; int32_t y; } lv_point_t;
typedef struct _lv_font_t lv_font_t;

typedef enum {
    LV_TEXT_FLAG_NONE      = 0x00,
    LV_TEXT_FLAG_EXPAND    = 0x01,
    LV_TEXT_FLAG_FIT       = 0x02,
    LV_TEXT_FLAG_BREAK_ALL = 0x04,
    LV_TEXT_FLAG_RECOLOR   = 0x08,
} lv_text_flag_t;

void lv_text_get_size(lv_point_t *size_res, const char *text, const lv_font_t *font,
                      int32_t letter_space, int32_t line_space, int32_t max_width,
                      lv_text_flag_t flag);
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* --- which script's breaking rule a call takes -----------------------------
 *
 * LVGL 9.5 breaks a line after every CJK ideograph and every kana but not after
 * a Hangul syllable: lv_text_is_a_word() carries no Hangul range, and
 * LV_TXT_BREAK_CHARS cannot name a codepoint above 0x7F. So Korean copy wraps
 * only at its spaces. That is not a correctness problem — the copyfitter
 * measures with the same lv_text_get_size() LVGL draws with, so nothing
 * overflows — it is a typographic one: a 170 px leg holds ten syllables and an
 * eojeol runs two to five, so a fifth of every line ends up in the rag. Korean
 * newspapers break between any two syllables.
 *
 * The fix belongs where the cut already lives. Under UI_FIT_HANGUL these two
 * functions lay the lines out themselves and emit explicit '\n's, leaving LVGL
 * nothing to wrap. Under UI_FIT_LATIN nothing whatsoever changes, which is the
 * point of the parameter: an English edition takes byte-for-byte the path it
 * took before the rule existed. */
typedef enum { UI_FIT_LATIN = 0, UI_FIT_HANGUL = 1 } ui_fit_script_t;

/* The rule an edition's `lang` asks for: "ko" is the only tag with a breaking
 * rule of its own, and everything else — including an empty or absent tag —
 * takes the Latin one. Call sites pass the snapshot's own `v->lang` rather than
 * reading it off anything else, so a renderer's output stays a function of the
 * snapshot it was handed. NULL is Latin, like every other unknown tag. */
ui_fit_script_t ui_fit_script(const char *lang);

/* Copy as much of `src` as fits in `w` x `h`, set in `font` at `line_space`,
 * into `dst` (`n` bytes, always NUL-terminated). Returns the number of SOURCE
 * bytes consumed, so the next column starts at src + the return value.
 *
 * The cut lands on a word boundary, and on a SENTENCE boundary when the nearest
 * one costs no line: a column that stops on a full stop reads as a decision
 * rather than as a bug, and it is worth having whenever it is free. It is never
 * worth a line. The box is the space the owner asked to see used, a short
 * column is visible from across the room, and a last line that ends mid-clause
 * is what every newspaper column does. There is no ellipsis — a newspaper
 * column simply stops. The single case that cuts mid-word is a first word too
 * long for `w`, where the alternative is emitting nothing, and an empty column
 * is worse than an awkward one.
 *
 * Leading whitespace is consumed and dropped; trailing whitespace is trimmed
 * from `dst` and left in the source for the next call to drop as its own
 * leading whitespace. The returned counts therefore tile `src` exactly: nothing
 * is repeated, and the only bytes that reach no column are the spaces at the
 * joins.
 *
 * Measured at letter_space 0, which is what body text is set at. A tracked
 * label must not be copyfitted with this: every caps label on the page takes
 * +2, and two extra pixels a character is a line and a half over a column.
 *
 * A return of 0 for a `src` that holds text means the box cannot hold one
 * character — `h` below a single line, a non-positive span, no room in `dst`.
 * It is the only honest answer, and a caller walking columns must stop on it
 * rather than call again with the same arguments.
 *
 * Under UI_FIT_HANGUL `dst` is no longer a prefix of `src`: the lines are laid
 * out here and joined with '\n', so `dst` carries one byte per inserted break
 * that the source never had. Everything above still holds as stated — the
 * return is SOURCE bytes, the spans still tile `src`, the copy is still cut at
 * a boundary a reader would have chosen — and one thing is added: a break never
 * lands before a closing mark (`.,!?%)]` and `、。〉》」』`), never after an opening
 * one (`([` and `〈《「『`), and never inside a run of non-Hangul characters,
 * which is what keeps a figure like 1,631.47 whole. */
size_t ui_fit_text(const lv_font_t *font, int w, int h, int line_space,
                   ui_fit_script_t script, const char *src, char *dst, size_t n);

/* Copy `src` into `dst` with explicit line breaks chosen so that the WIDEST of
 * the lines is as narrow as it can be — a headline broken the way a copy desk
 * breaks one, rather than the way a text engine fills one.
 *
 * Greedy wrapping is correct for a column of body text and wrong for a display
 * line: it runs line one to the measure and drops the remainder onto line two,
 * so a two-line head arrives as a full line and a stub. This tries every legal
 * split into the number of lines the string was going to take anyway, and keeps
 * the one whose longest line is shortest. Nothing is added, removed or
 * reordered; the only bytes that change are the spaces that became newlines.
 *
 * Returns the number of lines it set, or 0 if it declined — an empty string, a
 * head that already sets on one line (returns 1), one that needs more lines
 * than `max_lines` and is therefore going to be ellipsized by ui_lab_box()'s
 * rule anyway, or one where no split leaves every line inside `w`. On 0 the
 * caller can still set `dst`: it holds the source, unmodified, which is exactly
 * what would have been set without this call.
 *
 * Two and three lines are the cases it handles, because two and three are what
 * a headline slot on this sheet has; four is a paragraph.
 *
 * Under UI_FIT_HANGUL the candidates are the spaces AND every legal syllable
 * boundary, scored by exactly the same rule — which is what lets a Korean head
 * with no spaces in it be broken at all, and a Korean head with two of them be
 * broken somewhere better than either. There the breaks are inserted rather
 * than substituted, so `dst` needs a byte per break; a `dst` too small for
 * them declines, as every other refusal here does, with the source intact. */
int ui_fit_balance(const lv_font_t *font, int w, int max_lines,
                   ui_fit_script_t script, const char *src, char *dst, size_t n);

#ifdef __cplusplus
}
#endif
