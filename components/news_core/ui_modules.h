/*
 * ui_modules.h — the parts both sheets are made of.
 *
 * A1 and A2 are not two layouts any more, they are two module lists handed to
 * the same make-up desk. That is the whole reason this file exists: the second
 * page was a data dump precisely because it was written as its own thing, and a
 * markets page only reads as a newspaper if it is set out of the same parts as
 * the front — the same standing rail, the same ruled tables, the same kicker
 * over the same headline over the same legs of body. So every renderer is here,
 * both page files build a list and call ui_mod_run(), and neither of them owns a
 * coordinate.
 *
 * THE POOL, AND WHY create() CANNOT BUILD AT FINAL COORDINATES
 * -----------------------------------------------------------
 * The old pages built every widget where it would stand, because where it would
 * stand was a macro. It is a composition now, and a composition is not known
 * until a snapshot has arrived — so create() builds a POOL of renderers, one per
 * module the page can ever show, and update() places them.
 *
 * A renderer that the day's make-up did not use is HIDDEN, never freed. On a
 * board that repaints every five minutes for years, LVGL object churn is how the
 * heap fragments, and the failure it produces — an allocation that fails on the
 * four hundredth poll — is invisible until it happens and unattributable when it
 * does. Every widget this file creates is created once.
 *
 * WHAT IS IN A ui_module_t
 * ------------------------
 * One instance renders one KIND. The union is what keeps that cheap: a page
 * declares its pool as a list of kinds, gets an array of these as a file-scope
 * static, and pays for the largest member once per module rather than for every
 * member of every kind. They are file statics rather than locals for the reason
 * news_model.h gives about news_t: the largest of them is most of a kilobyte and
 * UiTask's whole stack is eight.
 *
 * Portable: LVGL only, no ESP-IDF. The simulator builds this verbatim.
 */
#pragma once

#include "lvgl.h"

#include "news_model.h"
#include "ui_compose.h"
#include "ui_news.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- the shapes' capacities -----------------------------------------------
 * Every one of these is a widget count, so it is the worst case a payload can
 * ask for and not a typical one. They are here rather than in ui_internal.h
 * because nothing outside this file has an opinion about them.
 *
 * A story sets at most four legs. The count is a pure function of the MEASURE —
 * see ui_legs_for() — and four is what 1140 px divides into at the narrowest leg
 * this paper sets.
 *
 * The array this sizes is s_copy[UI_LEGS_MAX][NEWS_BODY_MAX] in ui_modules.c:
 * 4 x 2,400 = 9,600 bytes of file-scope static, against 3 x 1,600 = 4,800
 * before. It is a static rather than a local for the reason news_model.h gives
 * about news_t — UiTask's whole stack is eight kilobytes — and it is safe
 * because UiTask is the only caller. */
#define UI_LEGS_MAX             4

/* The narrowest LEG this page sets body text in, which is not the narrowest
 * MODULE. ui_internal.h's measure table is about modules on the six-column grid
 * and says two columns, 364 px, 45 characters; a leg inside a module is a
 * different question, and the page already says so — UI_LEG_GUTTER is 20 px
 * against the page's 24 precisely because the legs of one story are set tighter
 * than two stories are.
 *
 * 230 px is 28 characters at ui_font_body_16's measured 8.02 px prose advance.
 * That is below typography's 45-character comfort floor and deliberately so:
 * newspapers have always set at the narrow end of it, and the Wall Street
 * Journal front page this design is answering runs five legs across the same
 * measure, which is about 210 px and 26 characters. Four legs of 270 is the
 * conservative reading of that page, not an aggressive one. */
#define UI_LEG_MIN_W          230

/* The peer table's six fields — symbol, name, P/E, capitalisation, last,
 * change. A narrow module drops fields rather than squeezing all six; see
 * peer_fields() in ui_modules.c for the order they go in. */
#define UI_PEER_FIELDS          6

/* The metric grid's cards, one per group. The model allows twenty-eight figures
 * and says nothing about how many groups they fall into, so in principle every
 * figure could carry its own head — but eight cards and their eight rules
 * already overrun the well at one card across, so a ninth group cannot reach the
 * glass however many widgets are built for it. Eight is therefore the point past
 * which more objects buy nothing. It is also the row bound: at one card across
 * every card is its own row, so there are never more rows than cards. */
#define UI_DOSSIER_GROUPS       8

/* --- the widgets ----------------------------------------------------------
 * One struct per kind, named after the elements a printer would name. A NULL
 * pointer is a widget this kind does not have — a STORY has no caption, and the
 * two share ui_w_story_t because a lead IS a story with a photograph and a deck.
 */

/* A photograph, and the box that crops it.
 *
 * The device never resizes a tile — it has already been through a halftone, and
 * resampling a screened image screens it a second time, which is the confetti
 * wp_palette.h warns about. A slot narrower than the picture therefore CROPS,
 * and the crop is a clipping pane with the image hung inside it at a negative
 * offset rather than a stride trick on the descriptor: the pane is one object,
 * LVGL clips children to their parent by construction, and there is no second
 * expression of the image's row length to get wrong.
 *
 * The descriptor lives here rather than as a file static because a front page
 * blits three pictures and LVGL dereferences the descriptor at RENDER time, so
 * one shared descriptor would draw the last picture three times. */
typedef struct {
    lv_obj_t      *box, *art, *edge[4];
    lv_image_dsc_t dsc;
} ui_w_art_t;

typedef struct {
    lv_obj_t *kicker, *head, *deck, *byline, *hair;
    ui_w_art_t art;
    lv_obj_t *cap, *cred;                     /* the lead's caption line */
    lv_obj_t *leg[UI_LEGS_MAX];
    lv_obj_t *leg_rule[UI_LEGS_MAX - 1];
    lv_obj_t *end;                            /* the end-of-story square */
} ui_w_story_t;

/* The metric grid: one caps head and one rule per CARD, and a label, a value and
 * a change per figure. A hero and a card row are the same three widgets read at
 * two sizes — md_font() re-points the value at the display face — so lifting the
 * heroes out into their own band above the grid costs no objects at all. */
typedef struct {
    lv_obj_t *group[UI_DOSSIER_GROUPS], *grule[UI_DOSSIER_GROUPS];
    lv_obj_t *label[NEWS_FIGURES_MAX], *value[NEWS_FIGURES_MAX],
             *chg[NEWS_FIGURES_MAX];
    lv_obj_t *marks;                          /* every mark, one callback */
} ui_w_dossier_t;

typedef struct {
    lv_obj_t *head, *plot, *note;
} ui_w_chart_t;

typedef struct {
    lv_obj_t *head, *hair;
    lv_obj_t *when[NEWS_BRIEFS_MAX], *text[NEWS_BRIEFS_MAX],
             *rule[NEWS_BRIEFS_MAX];
} ui_w_briefs_t;

typedef struct {
    lv_obj_t *head, *hair;
    lv_obj_t *col[UI_PEER_FIELDS];
    lv_obj_t *cell[NEWS_PEERS_MAX][UI_PEER_FIELDS];
    lv_obj_t *rule[NEWS_PEERS_MAX];
    lv_obj_t *marks;
} ui_w_peers_t;

/* A statement, and it is ONE widget set for all three of news_model.h's
 * `render` values. A drawn table reuses the printed one's labels rather than
 * building a second set: `col[]` becomes the period labels along the foot of the
 * plot, `rlabel[]` becomes the legend entries, and `cell[r][0]` becomes the
 * coloured figure beside each legend entry. Nothing here is created for one
 * render and hidden for the others, so the choice costs no objects at all.
 *
 * `plot` is the one addition: a pane covering the whole module with a DRAW_MAIN
 * handler, which is where the bars, the tones, the line and the swatches are
 * laid down as hard pixels. It is the same shape as the marks pane and for the
 * same reason — a bar is geometry, not a glyph, and sixty panes for sixty
 * rectangles is sixty objects to place, hide and invalidate. */
typedef struct {
    lv_obj_t *title, *note, *hair;
    lv_obj_t *col[NEWS_TABLE_COLS];
    lv_obj_t *rlabel[NEWS_TABLE_ROWS];
    lv_obj_t *cell[NEWS_TABLE_ROWS][NEWS_TABLE_COLS];
    lv_obj_t *rule[NEWS_TABLE_ROWS];
    lv_obj_t *plot;
} ui_w_table_t;

typedef struct {
    lv_obj_t  *head, *hair;
    ui_w_art_t art[NEWS_THUMBS_MAX];
    lv_obj_t  *cap[NEWS_THUMBS_MAX];
} ui_w_thumbs_t;

typedef struct {
    lv_obj_t *rule, *text, *attrib;
} ui_w_quote_t;

/* Where a mark goes and which way it points, in the coordinates of the pane
 * that draws it. The marks of a whole module are drawn by ONE callback on ONE
 * pane rather than by a pane apiece: a triangle is geometry and not a glyph, the
 * rail can carry a dozen of them, and twelve panes of fourteen pixels each is
 * twelve objects to place, hide and invalidate for one shape drawn twice.
 *
 * TWO SHAPES SHARE THE LIST, and the second is the reason `kind` exists. A hero
 * figure in the dossier carries a RANGE BAR — a rule across its column with the
 * value's position marked on it, which is what turns a number into a graphic —
 * and that is the same kind of object as a mark: a few pixels of geometry, drawn
 * many times per module, in coordinates the placement already worked out. Giving
 * it its own pane per figure would be the mistake this list exists to avoid.
 *
 * The fields are read differently by the two kinds, which is the whole of the
 * saving:
 *
 *   UI_MARK_CHG    x, y   the mark's top-left     side  its side
 *                  bp     the change, in basis points; 0 draws the flat bar
 *   UI_MARK_RANGE  x, y   the bar's top-left      side  the bar's WIDTH
 *                  bp     the position within the range, 0..1000
 *
 * A range bar is drawn in INK and never in green or red, and that is the colour
 * policy applied rather than an omission: where a figure sits inside its own
 * 52-week band is a POSITION, not a change, and colour on this sheet is reserved
 * for changes. A green range bar would be the page asserting a direction the
 * producer never sent. */
typedef enum { UI_MARK_CHG = 0, UI_MARK_RANGE } ui_mark_kind_t;

typedef struct { int16_t x, y, side; int32_t bp; uint8_t kind; } ui_mark_t;

#define UI_MARKS_MAX  (NEWS_FIGURES_MAX > NEWS_PEERS_MAX \
                       ? NEWS_FIGURES_MAX : NEWS_PEERS_MAX)

/* --- a drawn statement ----------------------------------------------------
 *
 * news_model.h lets a producer say that a table is an ARGUMENT rather than a
 * record, and this is what the argument is drawn from. Six quarters of revenue,
 * profit and margin printed as eighteen cells is a thing the reader has to
 * assemble; the same eighteen numbers as bars with a line over them is a thing
 * they see.
 *
 * WHY A DISPLAY LIST AND NOT A REDRAW FROM THE MODEL
 * -------------------------------------------------
 * A DRAW_MAIN handler cannot ask the compositor anything and must not work the
 * geometry out for itself. ui_modules.c's whole contract is that a measurement
 * and a placement are one walk with no second table of offsets in the file, and
 * a draw callback that recomputed the bars would be exactly that second table —
 * the failure it produces is a graphic that disagrees with the labels printed
 * around it, which no assertion on the widget tree can see. So the placement
 * works every rectangle out once and leaves it here, and the callback is a
 * transcription with no arithmetic in it.
 *
 * WHY THE LISTS ARE SHARED RATHER THAN PER-MODULE
 * ----------------------------------------------
 * A list is about 340 bytes. Inside the ui_module_t union every module of every
 * pool pays for it — nineteen modules across the two pages, 6.5 KB of internal
 * .bss to hold at most two drawn tables. Keyed on (page, src) instead there are
 * exactly four, which is 1.4 KB and an exact fit: NEWS_TABLES_MAX tables, two
 * sheets, and no two placed modules on one sheet share a src.
 *
 * Keying on src ALONE would alias, and silently: A1 and A2 can each hold a
 * drawn table, ui_mod_run() runs for both pages on every snapshot, and the
 * second run would overwrite the first page's bars with its own while leaving
 * A1's labels saying something else. */
/* Drawn series. SIX rather than ui_series_at()'s five treatments, and the extra
 * one is a stack's business: a stack's row count is the producer's, and dropping
 * the sixth component of a stack would understate its total, which is the one
 * thing a stacked bar may not do. grf_series() in ui_modules.c is where a sixth
 * series takes the fifth's treatment and why that beats the alternatives. */
#define UI_GRF_ROWS   6

typedef enum { UI_GRF_NONE = 0, UI_GRF_BARS, UI_GRF_STACK } ui_grf_kind_t;

/* One drawn rectangle, in the plot pane's own coordinates. y1 is exclusive of
 * nothing — it is the last row, the way ui_draw_rect_c_abs() takes its bounds. */
typedef struct { int16_t x, w, y0, y1; } ui_grf_box_t;

typedef struct {
    uint8_t      kind;                                  /* ui_grf_kind_t     */
    uint8_t      rows, cols;
    ui_grf_box_t box[UI_GRF_ROWS][NEWS_TABLE_COLS];
    ui_grf_box_t key[UI_GRF_ROWS];                      /* the legend swatch */
    int16_t      lx[NEWS_TABLE_COLS], ly[NEWS_TABLE_COLS];
    uint8_t      ln;                                    /* points on the line */
    int32_t      lbp;                 /* the line's last less its first, for  */
                                      /* ui_chg_colour() — see ui_modules.c   */
    int16_t      mkx, mky;            /* the mark beside the line's end value */
    int16_t      base, x0, x1;        /* the zero row, and the plot's sides   */
} ui_grf_t;

typedef struct {
    ui_mod_kind_t kind;
    lv_obj_t     *pane;        /* every widget below is a child of this   */

    ui_mark_t     mark[UI_MARKS_MAX];
    int           mark_n;

    /* How deep the module actually SET, which is not how tall it was given.
     *
     * A column rule runs the depth of the type beside it and stops. That is not
     * decoration: on a thin day a band is taller than anything in it, and a
     * hairline drawn the full depth of the band turns three modules that each
     * ended honestly into three empty columns with rules down them — the page
     * advertising its own white rather than simply stopping. Every renderer
     * records where it finished and ui_rules_place() draws to the deeper of the
     * two neighbours. */
    int           ink_h;

    /* The display list a drawn statement was placed with, or NULL — which is
     * also what every module that is not a drawn table carries. It points into
     * ui_modules.c's own four slots and is re-pointed by every placement, so a
     * module that stops being drawn stops drawing. */
    const ui_grf_t *grf;

    union {
        ui_w_story_t   story;      /* UI_MOD_LEAD and UI_MOD_STORY */
        ui_w_dossier_t dossier;
        ui_w_chart_t   chart;
        ui_w_briefs_t  briefs;
        ui_w_peers_t   peers;
        ui_w_table_t   table;
        ui_w_thumbs_t  thumbs;
        ui_w_quote_t   quote;
    } w;
} ui_module_t;

/* The rules BETWEEN modules, which belong to no module: a hairline down the
 * gutter separating two modules of a band, and a rule across the foot of a band
 * that has another band under it. They are the page's furniture rather than a
 * renderer's, they are the same on both sheets, and there are never more of them
 * than there are modules. */
typedef struct {
    lv_obj_t *vrule[UI_MOD_MAX];
    lv_obj_t *hrule[UI_MOD_MAX];
} ui_rules_t;

/* --- what the two pages have to agree about -------------------------------
 *
 * These are page-inventory decisions rather than renderers, and they are here
 * for one reason: A1 and A2 must not print the same statement, and until now
 * they kept that promise by having two files carry the same arithmetic with a
 * comment admitting it — "the two files agree on the number, and they have to".
 *
 * That was survivable while A1 ran a statement only on a day with no stories. It
 * is not any more. The producer now files two tables and BOTH may be drawn, so
 * the moment A1 takes a graphic as an ordinary module the old rule hands the
 * same table to both sheets, and the failure is silent: two pages, same numbers,
 * nothing in either file wrong on its own. One function, called by both, is the
 * only version of this that cannot drift. */

/* The statement A1 runs as a GRAPHIC in the middle of an ordinary front page —
 * the lowest-indexed table the producer marked as an argument and sent numbers
 * for — or -1.
 *
 * A drawn table is what the front page has instead of a second chart: the owner
 * asked for colour and charts in the middle of a paper of words and pictures,
 * and a revenue-profit-margin figure is the one statement a general reader
 * actually reads. A PRINTED statement is not offered the same promotion, because
 * a grid of eighteen cells in the middle of a front page is a page with a
 * spreadsheet dropped into it. */
int ui_a1_graphic(const news_t *v);

/* The statement A1 runs on a day that brought no stories at all, or -1. The
 * LAST one, so it cannot be the graphic above — which is only ever offered on a
 * day that HAS stories, so the two can never both be on. */
int ui_a1_table(const news_t *v);

/* Whether A2 should run table `i`. Everything A1 did not take, which is what
 * makes the split total: every table reaches exactly one sheet. */
bool ui_a2_takes_table(const news_t *v, int i);

/* How many legs a module of `w` pixels sets its body in.
 *
 * Exposed because it is the arithmetic the FRONT PAGE has to reason about to
 * decide whether the day's lead deserves the whole measure, and the answer must
 * be the one the renderer will actually use. A page that guessed three legs
 * where ui_modules.c sets four would ask for a banner the copy cannot fill. */
int ui_legs_for(int w);

/* Whether `body` has the copy to fill a module of `w` pixels down to
 * `lines_per_leg` lines in every one of its legs.
 *
 * This is the banner test, and it is a MEASUREMENT rather than a character
 * count: the body is run through the same line breaker the legs will be set
 * with, at the width they will be set at. A byte threshold cannot know that a
 * story of long words sets shorter than a story of short ones, and the failure
 * it produces — a full-measure package with three inches of paper under the last
 * leg — is the exact fault the compositor was rebuilt to remove.
 *
 * Pure in (body, w, lines_per_leg), so news_hash()'s promise survives it. */
bool ui_body_fills_legs(const char *body, int w, int lines_per_leg);

/* How deep `body` actually sets at a measure of `w`, in pixels — the legs it
 * would be broken into, at the leading they would be set at.
 *
 * The page needs this to answer a question only it can ask: has the day brought
 * enough WRITTEN COPY to fill the sheet? A count of stories cannot answer it —
 * two long pieces fill more paper than four short ones — and a count of bytes
 * cannot either, because a story of long words breaks into more lines than a
 * story of short ones at the same length. Measuring is the only honest way, and
 * it is the same measurement the renderer will make. */
int ui_body_depth(const char *body, int w);

/* The floor a LEAD's legs are held to, which is the number the banner test
 * wants for `lines_per_leg`: below six lines under a lead's display type the
 * package stops reading as a story. story_run() already protects it, so the
 * banner asks the same question the renderer will answer. */
#define UI_LEAD_FLOOR_LINES     6

/* How deep the METRIC GRID sets at a measure of `w`, in pixels: the hero band,
 * the rows of cards, and the paper between them, with every gap at its natural
 * size. Zero for a snapshot with no figures in it.
 *
 * This is the number ui_mod_measure() reports as `h_pref` for UI_MOD_DOSSIER,
 * and it is exposed for the question only a PAGE can ask: has this snapshot
 * brought enough figures to fill the room a promotion would give the grid?
 *
 * That question has an answer in the tree and, until now, no way to ask it —
 * which is what ui_page_front.c's build() comment is about. The dossier is
 * marked unconditionally `elastic`, so on a thin day the compositor hands it the
 * whole well and the grid opens its gaps to swallow room it has no figures for:
 * the same defect as a hole at the foot, one module further in, and worse,
 * because a hole reads as a page that ended and a stretched grid reads as a
 * broken one. The fix is the test body_is_elastic() already applies to a story,
 * asked of the figures — elastic only when the grid can honestly fill what it
 * would claim.
 *
 * Pure in (v, w). The grid's shape is a function of the MEASURE alone and never
 * of the height it is later given, so news_hash()'s promise survives it and a
 * page may call it before anything has been composed. */
int ui_dossier_natural_h(const news_t *v, int w);

/* --- the calls ------------------------------------------------------------ */

/* Build one renderer of `kind` under `par`. Call it once per pool entry from a
 * page's create(); everything it builds is hidden until a composition places
 * it. */
void ui_mod_create(ui_module_t *w, lv_obj_t *par, ui_mod_kind_t kind);

void ui_rules_create(ui_rules_t *r, lv_obj_t *par);

/* ui_measure_fn, for ui_compose_env_t::measure. `ctx` is the news_t the module
 * list was built from. Pure in (m, w, ctx), which is what news_hash()'s promise
 * rests on: two snapshots that fingerprint the same must measure the same or the
 * board skips a refresh it needed. */
void ui_mod_measure(const ui_mod_t *m, int w, int *h_min, int *h_pref, void *ctx);

/* Compose `mods` into the well, print what was placed, hide the rest, and
 * record the make-up for ui_page_layout(). This is the whole of a page's
 * update() after it has decided what the day brought.
 *
 * `mods` is reordered — see ui_compose() — so a caller that wants to know what
 * happened to a particular module must look it up by `src` afterwards, or ask
 * ui_page_layout(). */
void ui_mod_run(ui_page_t page, const news_t *v,
                ui_module_t *pool, int pool_n, ui_rules_t *rules,
                ui_mod_t *mods, int n);

/* Every renderer hidden and every rule taken away, with no composition
 * recorded. What a page does with a NULL snapshot: an empty page and not a
 * placeholder, because the demo snapshot is what an unconfigured board shows and
 * the only way to reach this is a board that has lost its feed. */
void ui_mod_blank(ui_page_t page, ui_module_t *pool, int pool_n, ui_rules_t *rules);

#ifdef __cplusplus
}
#endif
