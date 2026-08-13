/*
 * news_model.h — everything the board knows about the news, in one struct.
 *
 * This is the seam of the whole project. `news_t` is produced by exactly two
 * things — news_parse.c (from the JSON a PC serves) and news_mock.c (the
 * built-in demo snapshot) — and consumed by exactly two — the UI pages and the
 * companion-app JSON. Nothing else reads the network payload, so a change to
 * the wire format lands in one file.
 *
 * Every array is fixed-size and every count is clamped by the producer. The
 * struct is therefore ~6 KB, copyable, and safe to snapshot under a mutex and
 * hand to the UI task without any ownership question. That is deliberate: on a
 * device where one task owns the panel and another owns the network, a plain
 * copyable value is worth more than the bytes it wastes.
 *
 * Portable: no LVGL, no ESP-IDF. The host tests build this directly.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- capacities -----------------------------------------------------------
 * These are display capacities, not protocol limits: the panel is 648x480 and
 * fits six agent rows, eight note rows and about fourteen graph nodes before
 * anything becomes unreadable. The parser drops the overflow rather than
 * failing, so a news with 500 agents still renders its first six. */
#define NEWS_NAME_MAX      32
#define NEWS_TIME_MAX      24
#define NEWS_TITLE_MAX     64      /* bytes of UTF-8, ~21 Hangul syllables */
#define NEWS_TAG_NAME_MAX  24
#define NEWS_AGENT_NAME_MAX 20
#define NEWS_AGENT_NOTE_MAX 72

#define NEWS_DAILY_DAYS    7
#define NEWS_TAGS_MAX      6
#define NEWS_AGENTS_MAX    6
#define NEWS_NODES_MAX     14
#define NEWS_EDGES_MAX     32
#define NEWS_RECENT_MAX    8
#define NEWS_INBOX_MAX     8

/* --- pieces --------------------------------------------------------------- */

typedef enum {
    AGENT_IDLE = 0,
    AGENT_RUNNING,
    AGENT_ERROR,
    AGENT_DONE,
    AGENT_STATE_COUNT,
} agent_state_t;

typedef struct {
    char name[NEWS_TAG_NAME_MAX];
    int  count;
} news_tag_t;

typedef struct {
    char          name[NEWS_AGENT_NAME_MAX];
    agent_state_t state;
    char          last_run[NEWS_TIME_MAX];   /* free text: "20:55", "2h ago" */
    int           processed;
    int           queued;
    int           progress;                   /* 0..100, or -1 for "no bar" */
    char          note[NEWS_AGENT_NOTE_MAX]; /* what it is doing right now */
} news_agent_t;

typedef struct {
    char title[NEWS_TITLE_MAX];
    int  deg;                                 /* link degree — drives node size */
} news_node_t;

/* Indices into news_t.nodes. uint8_t is enough for NEWS_NODES_MAX and keeps
 * the edge list at two bytes a pair. */
typedef struct {
    uint8_t a, b;
} news_edge_t;

typedef struct {
    char title[NEWS_TITLE_MAX];
    char time[NEWS_TIME_MAX];
    int  links;
} news_note_t;

typedef struct {
    char title[NEWS_TITLE_MAX];
    int  age_days;
} news_inbox_t;

typedef struct {
    int notes;
    int links;
    int orphans;
    int tags;
    int added_today;
    int added_7d;
    int daily[NEWS_DAILY_DAYS];              /* oldest first, today last */
} news_stats_t;

/* --- the snapshot --------------------------------------------------------- */

typedef struct {
    bool valid;                 /* false = nothing has ever been loaded */
    bool demo;                  /* true = news_mock, no news_url configured */

    char news[NEWS_NAME_MAX];
    char generated_at[NEWS_TIME_MAX];

    news_stats_t stats;

    news_tag_t   tags[NEWS_TAGS_MAX];
    int           tag_count;

    news_agent_t agents[NEWS_AGENTS_MAX];
    int           agent_count;

    news_node_t  nodes[NEWS_NODES_MAX];
    int           node_count;
    news_edge_t  edges[NEWS_EDGES_MAX];
    int           edge_count;

    news_note_t  recent[NEWS_RECENT_MAX];
    int           recent_count;

    news_inbox_t inbox[NEWS_INBOX_MAX];
    int           inbox_count;
    int           inbox_total;  /* server's real count; >= inbox_count */
} news_t;

/* --- helpers (pure, shared by the UI, the API and the tests) -------------- */

/* Copy a UTF-8 string into a fixed buffer, truncating on a character boundary.
 *
 * strlcpy would happily cut a 3-byte Hangul syllable in half, and a lone
 * continuation byte does not render as "the title was long" — it renders as a
 * tofu box, or worse, sends LVGL's decoder past the NUL. Every string that
 * enters news_t from the network goes through here. Always NUL-terminates.
 * Returns the number of bytes written (excluding the NUL). */
size_t news_str_copy(char *dst, size_t dst_size, const char *src);

/* "RUNNING" / "IDLE" / "ERROR" / "DONE" — never NULL, even for a bad enum. */
const char *news_agent_state_name(agent_state_t s);

/* Parse a wire state word ("running", "idle", ...). Unknown -> AGENT_IDLE. */
agent_state_t news_agent_state_from(const char *word);

/* How many agents are in AGENT_RUNNING. */
int news_running_agents(const news_t *v);

/* Links per note, x100 (2.74 links/note -> 274). 0 when there are no notes. */
int news_link_density_x100(const news_t *v);

/* Orphan share of all notes, x10 (2.6% -> 26). 0 when there are no notes. */
int news_orphan_rate_x10(const news_t *v);

/* Largest value in stats.daily[], floored at 1 so a bar chart can divide by it. */
int news_daily_peak(const news_t *v);

/* A fingerprint of everything that is drawn. Two snapshots with the same
 * fingerprint produce the same pixels, so the caller can skip a panel refresh
 * entirely — which on e-Paper is the difference between a silent board and one
 * that flashes every five minutes for no reason.
 *
 * Deliberately excludes nothing that reaches the glass, including `demo`. */
uint32_t news_hash(const news_t *v);

#ifdef __cplusplus
}
#endif
