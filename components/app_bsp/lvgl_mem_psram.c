/*
 * lvgl_mem_psram.c — LVGL's heap, moved off internal RAM and into the PSRAM.
 *
 * LVGL ships three allocators and the default is the wrong one for this board.
 * `LV_USE_BUILTIN_MALLOC` carves a fixed pool out of internal `.bss` — 64 KB
 * unless Kconfig says otherwise — and hands it to TLSF. The front page does not
 * fit in it, and it is not close: `ui_news_create()` builds 390 objects and
 * measures **197,096 bytes** the moment it returns, peaking at **202,672**
 * across both pages, the two badges and the provisioning overlay. Three times
 * the pool.
 *
 * Nor can the pool simply be made bigger. The boot log leaves about 186 KiB of
 * internal DRAM free *after* the 64 KB pool has already been reserved, and
 * Wi-Fi, the HTTP server, mbedTLS and every task stack come out of what is
 * left. There is no size of internal pool that holds 203 KB of widgets. The
 * PSRAM has 8 MB, of which the panel framebuffer takes 960 KB and the LVGL
 * draw buffer 288 KB, so the widgets go there and the question closes.
 *
 * The builtin allocator cannot be pointed at the PSRAM either: its pool is a
 * static array, and placing it elsewhere needs `LV_MEM_POOL_ALLOC`, a macro the
 * esp-idf component's Kconfig does not expose. So LVGL is told the allocator is
 * external (`CONFIG_LV_USE_CUSTOM_MALLOC=y`) and the nine functions below are
 * what it links against instead.
 *
 * WHY THIS FILE IS WORTH ITS COMMENTS: running out of LVGL memory does not
 * report itself. `lv_obj_class_create_obj()` reallocates the parent's child
 * array and stores into the result **without checking it**, so an exhausted
 * heap arrives as a StoreProhibited on an address a few hundred bytes above
 * zero, in a backtrace that names whichever widget happened to be next. That is
 * the fault this file exists to prevent, and `oom()` below is here so that if it
 * ever happens again — 8 MB is large, not infinite — the log says so in words
 * before LVGL crashes on the NULL.
 */
#include "lvgl.h"

#include <esp_heap_caps.h>
#include <esp_log.h>

static const char *TAG = "LvglMem";

/* PSRAM, and byte-addressable. The widgets are touched by the CPU only — no DMA
 * descriptor ever points at an lv_obj_t — so external memory costs nothing here
 * but a cache miss, against a refresh of twenty to thirty seconds. */
#define LVGL_MEM_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

/*
 * What LVGL is holding, and the most it has ever held.
 *
 * These are not decoration: `docs/bring-up.md` asks for the numbers a board
 * actually produces rather than the ones a datasheet promises, and this is the
 * one that decides whether the next page's worth of widgets fits. They are
 * plain `size_t` because every LVGL entry point is serialised behind the port's
 * `lvgl_mux` — one task draws, everything else posts a command — so there is no
 * concurrent writer for an atomic to protect against.
 */
static size_t s_used;
static size_t s_max_used;

static void oom(size_t size)
{
    ESP_LOGE(TAG, "LVGL wanted %u B of PSRAM and there is none: %u B free, "
                  "largest block %u B, LVGL holding %u B (peak %u B)",
             (unsigned)size,
             (unsigned)heap_caps_get_free_size(LVGL_MEM_CAPS),
             (unsigned)heap_caps_get_largest_free_block(LVGL_MEM_CAPS),
             (unsigned)s_used, (unsigned)s_max_used);
    ESP_LOGE(TAG, "the next LVGL call that does not check its allocation will "
                  "crash on the NULL — this line is the reason why");
}

static void took(size_t bytes)
{
    s_used += bytes;
    if (s_used > s_max_used) {
        s_max_used = s_used;
    }
}

/* --- the LV_STDLIB_CUSTOM contract ---------------------------------------- */

void lv_mem_init(void)
{
    s_used = 0;
    s_max_used = 0;
}

void lv_mem_deinit(void)
{
    /* The IDF heap outlives us and there is no pool of our own to return. */
}

lv_mem_pool_t lv_mem_add_pool(void *mem, size_t bytes)
{
    /* Only the builtin TLSF allocator has pools to add to. */
    LV_UNUSED(mem);
    LV_UNUSED(bytes);
    return NULL;
}

void lv_mem_remove_pool(lv_mem_pool_t pool)
{
    LV_UNUSED(pool);
}

void *lv_malloc_core(size_t size)
{
    void *p = heap_caps_malloc(size, LVGL_MEM_CAPS);
    if (p == NULL) {
        oom(size);
        return NULL;
    }
    took(heap_caps_get_allocated_size(p));
    return p;
}

void *lv_realloc_core(void *p, size_t new_size)
{
    /* `heap_caps_realloc()` allocates when handed NULL and frees when handed a
     * zero size, which is exactly what LVGL expects — and it does get handed
     * NULL: a parent's child array starts empty and is grown by this call. */
    const size_t was = (p != NULL) ? heap_caps_get_allocated_size(p) : 0;

    void *n = heap_caps_realloc(p, new_size, LVGL_MEM_CAPS);
    if (n == NULL && new_size > 0) {
        oom(new_size);
        return NULL;           /* the old block is still live and still ours */
    }

    s_used -= was;
    if (n != NULL) {
        took(heap_caps_get_allocated_size(n));
    }
    return n;
}

void lv_free_core(void *p)
{
    if (p == NULL) {
        return;
    }
    s_used -= heap_caps_get_allocated_size(p);
    heap_caps_free(p);
}

void lv_mem_monitor_core(lv_mem_monitor_t *mon_p)
{
    /*
     * `total_size` is what the PSRAM heap could still give LVGL plus what LVGL
     * already has, rather than a pool size — there is no pool. That keeps
     * `used_pct` meaning "how much of what I could have am I using", which is
     * the question worth asking on a heap this size. Fragmentation is the IDF
     * allocator's business and is reported as unknown rather than as zero,
     * which would read as "perfect".
     */
    const size_t free_now = heap_caps_get_free_size(LVGL_MEM_CAPS);

    lv_memzero(mon_p, sizeof(*mon_p));
    mon_p->total_size = s_used + free_now;
    mon_p->free_cnt   = 0;
    mon_p->free_size  = free_now;
    mon_p->free_biggest_size = heap_caps_get_largest_free_block(LVGL_MEM_CAPS);
    mon_p->used_cnt   = 0;
    mon_p->max_used   = s_max_used;
    mon_p->used_pct   = (uint8_t)(mon_p->total_size
                                  ? (100U * s_used + mon_p->total_size / 2) / mon_p->total_size
                                  : 0);
    mon_p->frag_pct   = 0;
}

lv_result_t lv_mem_test_core(void)
{
    /* heap_caps_check_integrity_all() walks every heap on the chip and is far
     * more than LVGL is asking about; the IDF's own heap poisoning is the tool
     * for that and is a menuconfig option away. */
    return LV_RESULT_OK;
}
