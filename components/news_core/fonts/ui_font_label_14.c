/*******************************************************************************
 * Size: 14 px
 * Bpp: 1
 * Opts: --font LibreFranklin[wght].ttf@wght=600 --size 14 --bpp 1 --format lvgl --symbols  !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~ ¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ‐–—‘’‚“”„†‡•…‰′″‹›⁄€№™≈≠≤≥ --no-compress --lv-font-name ui_font_label_14 -o components/news_core/fonts/ui_font_label_14.c
 ******************************************************************************/

#ifdef LV_LVGL_H_INCLUDE_SIMPLE
#include "lvgl.h"
#else
#include "lvgl/lvgl.h"
#endif

#ifndef UI_FONT_LABEL_14
#define UI_FONT_LABEL_14 1
#endif

#if UI_FONT_LABEL_14

/*-----------------
 *    BITMAPS
 *----------------*/

/*Store the image of the glyphs*/
static LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {
    /* U+0020 " " */
    0x0,

    /* U+0021 "!" */
    0xff, 0xff, 0x3c,

    /* U+0022 "\"" */
    0xde, 0xa5, 0x20,

    /* U+0023 "#" */
    0x0, 0x24, 0x24, 0x24, 0xff, 0x44, 0x44, 0xfe,
    0x48, 0x48, 0x48, 0x40,

    /* U+0024 "$" */
    0x8, 0x1f, 0x1f, 0xcd, 0x6, 0x83, 0xc0, 0xfc,
    0x1f, 0x9, 0xa4, 0xdf, 0xc7, 0xc0, 0x80,

    /* U+0025 "%" */
    0x70, 0x8d, 0x88, 0xd9, 0xd, 0xa0, 0xda, 0x7,
    0x5e, 0xf, 0x30, 0xb3, 0x13, 0x33, 0x33, 0x21,
    0xe0,

    /* U+0026 "&" */
    0x3e, 0xc, 0x61, 0x8c, 0x3b, 0x83, 0xe0, 0xf8,
    0x3f, 0x16, 0x74, 0xc7, 0x98, 0xf1, 0xf3, 0x80,

    /* U+0027 "'" */
    0xfa,

    /* U+0028 "(" */
    0x26, 0x6c, 0xcc, 0xcc, 0xcc, 0x66, 0x20,

    /* U+0029 ")" */
    0x46, 0x62, 0x33, 0x33, 0x33, 0x66, 0x40,

    /* U+002A "*" */
    0x10, 0x5f, 0xcc, 0x68, 0x20,

    /* U+002B "+" */
    0x30, 0xc3, 0x3f, 0x30, 0xc3, 0x0,

    /* U+002C "," */
    0xf6,

    /* U+002D "-" */
    0xf0,

    /* U+002E "." */
    0xf0,

    /* U+002F "/" */
    0x18, 0x84, 0x62, 0x10, 0x8c, 0x42, 0x30,

    /* U+0030 "0" */
    0x3c, 0x66, 0x42, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0x42, 0x66, 0x3c,

    /* U+0031 "1" */
    0x33, 0xcf, 0xc, 0x30, 0xc3, 0xc, 0x30, 0xcf,
    0xc0,

    /* U+0032 "2" */
    0x79, 0x8c, 0x18, 0x30, 0xe3, 0x86, 0x18, 0x61,
    0xff, 0xf8,

    /* U+0033 "3" */
    0x3c, 0x67, 0x3, 0x3, 0x6, 0x3e, 0x7, 0x3,
    0x3, 0xc7, 0x7c,

    /* U+0034 "4" */
    0x6, 0xe, 0x1e, 0x36, 0x36, 0x66, 0xc6, 0xff,
    0x6, 0x6, 0x6,

    /* U+0035 "5" */
    0x7e, 0x7e, 0x40, 0x40, 0xdc, 0x67, 0x3, 0x3,
    0x3, 0xc6, 0x7c,

    /* U+0036 "6" */
    0x3e, 0x62, 0x40, 0xc0, 0xdc, 0xe7, 0xc3, 0xc3,
    0xc3, 0x66, 0x3c,

    /* U+0037 "7" */
    0x7f, 0x7f, 0x2, 0x6, 0xc, 0xc, 0x8, 0x18,
    0x18, 0x38, 0x30,

    /* U+0038 "8" */
    0x3c, 0x67, 0xc3, 0xc3, 0xfe, 0x7e, 0xff, 0xc3,
    0xc3, 0xc3, 0x7c,

    /* U+0039 "9" */
    0x3c, 0x66, 0xc3, 0xc3, 0xe3, 0x7f, 0x3, 0x3,
    0x6, 0xe6, 0x7c,

    /* U+003A ":" */
    0xf0, 0xf,

    /* U+003B ";" */
    0xf0, 0xf, 0x60,

    /* U+003C "<" */
    0x0, 0x1d, 0xe7, 0xf, 0x7, 0x81, 0x80,

    /* U+003D "=" */
    0xfe, 0x0, 0x7, 0xf0,

    /* U+003E ">" */
    0x81, 0xc1, 0xe0, 0x71, 0xde, 0x30, 0x0,

    /* U+003F "?" */
    0x7d, 0x8c, 0x18, 0x30, 0xc3, 0xc, 0x18, 0x0,
    0x60, 0xc0,

    /* U+0040 "@" */
    0x1f, 0x4, 0x19, 0x7d, 0xcd, 0x9b, 0x13, 0x62,
    0x6c, 0xdc, 0xee, 0x40, 0xc, 0x20, 0x7c, 0x0,

    /* U+0041 "A" */
    0xe, 0x3, 0x81, 0xe0, 0x7c, 0x13, 0xc, 0xc3,
    0x38, 0xfe, 0x61, 0x98, 0x34, 0xc,

    /* U+0042 "B" */
    0xfc, 0xc7, 0xc3, 0xc3, 0xc6, 0xfc, 0xc7, 0xc3,
    0xc3, 0xc7, 0xfe,

    /* U+0043 "C" */
    0x3e, 0x31, 0x90, 0xd8, 0xc, 0x6, 0x3, 0x1,
    0x80, 0x41, 0xb1, 0x8f, 0x80,

    /* U+0044 "D" */
    0xf8, 0xc6, 0xc6, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc6, 0xc6, 0xf8,

    /* U+0045 "E" */
    0xff, 0x83, 0x6, 0xc, 0x1f, 0xb0, 0x60, 0xc1,
    0x83, 0xf8,

    /* U+0046 "F" */
    0xff, 0x83, 0x6, 0xc, 0x1f, 0xb0, 0x60, 0xc1,
    0x83, 0x0,

    /* U+0047 "G" */
    0x1e, 0x31, 0x90, 0x78, 0xc, 0x6, 0x3f, 0x7,
    0x83, 0x41, 0xb1, 0xcf, 0xa0,

    /* U+0048 "H" */
    0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xff, 0xc3, 0xc3,
    0xc3, 0xc3, 0xc3,

    /* U+0049 "I" */
    0xff, 0xff, 0xfc,

    /* U+004A "J" */
    0x18, 0xc6, 0x31, 0x8c, 0x63, 0x1b, 0xfc,

    /* U+004B "K" */
    0xc3, 0x63, 0x33, 0x1b, 0xd, 0x87, 0xe3, 0xb1,
    0x8c, 0xc6, 0x61, 0xb0, 0xc0,

    /* U+004C "L" */
    0xc1, 0x83, 0x6, 0xc, 0x18, 0x30, 0x60, 0xc1,
    0x83, 0xf8,

    /* U+004D "M" */
    0xe0, 0xfc, 0x1f, 0xc7, 0xf8, 0xfd, 0x17, 0xb6,
    0xf6, 0xde, 0x73, 0xce, 0x79, 0xcf, 0x11, 0x80,

    /* U+004E "N" */
    0xc1, 0xf0, 0xfc, 0x7e, 0x3d, 0x9e, 0xef, 0x37,
    0x8f, 0xc7, 0xe1, 0xf0, 0x60,

    /* U+004F "O" */
    0x3e, 0x31, 0x90, 0xd8, 0x3c, 0x1e, 0xf, 0x7,
    0x83, 0x41, 0x31, 0x8f, 0x80,

    /* U+0050 "P" */
    0xfc, 0xc7, 0xc3, 0xc3, 0xc7, 0xfe, 0xc0, 0xc0,
    0xc0, 0xc0, 0xc0,

    /* U+0051 "Q" */
    0x3e, 0x31, 0x90, 0xd8, 0x3c, 0x1e, 0xf, 0x7,
    0x83, 0x41, 0xb1, 0x8f, 0x80, 0x70, 0x8,

    /* U+0052 "R" */
    0xfe, 0xc7, 0xc3, 0xc3, 0xc7, 0xfe, 0xcc, 0xc6,
    0xc6, 0xc6, 0xc3,

    /* U+0053 "S" */
    0x3e, 0x42, 0xc0, 0xe0, 0xf8, 0x7e, 0x1f, 0x7,
    0x3, 0xc2, 0x7c,

    /* U+0054 "T" */
    0xff, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,
    0x18, 0x18, 0x18,

    /* U+0055 "U" */
    0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc3, 0x66, 0x3c,

    /* U+0056 "V" */
    0x60, 0xd8, 0x66, 0x18, 0xc6, 0x33, 0xc, 0xc1,
    0xb0, 0x68, 0x1e, 0x3, 0x80, 0xc0,

    /* U+0057 "W" */
    0xc3, 0xe, 0x38, 0xf1, 0xc7, 0xcf, 0x36, 0x59,
    0x36, 0xd9, 0xb6, 0xc7, 0x1c, 0x38, 0xe1, 0xc7,
    0xe, 0x38,

    /* U+0058 "X" */
    0x61, 0x9c, 0xc3, 0x30, 0x78, 0x1c, 0x3, 0x1,
    0xe0, 0x5c, 0x33, 0x18, 0xe6, 0x18,

    /* U+0059 "Y" */
    0x61, 0xb0, 0xcc, 0xc7, 0x61, 0xe0, 0xe0, 0x30,
    0x18, 0xc, 0x6, 0x3, 0x0,

    /* U+005A "Z" */
    0xff, 0x7, 0xe, 0xc, 0x1c, 0x38, 0x38, 0x70,
    0x70, 0xe0, 0xff,

    /* U+005B "[" */
    0xfc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xf0,

    /* U+005C "\\" */
    0x82, 0x10, 0x86, 0x10, 0x86, 0x10, 0x86,

    /* U+005D "]" */
    0xf3, 0x33, 0x33, 0x33, 0x33, 0x33, 0xf0,

    /* U+005E "^" */
    0x10, 0xc2, 0x9a, 0x4d, 0x10,

    /* U+005F "_" */
    0xfc,

    /* U+0060 "`" */
    0xc7,

    /* U+0061 "a" */
    0x7d, 0x8c, 0x19, 0xfe, 0x78, 0xf3, 0xbb,

    /* U+0062 "b" */
    0xc1, 0x83, 0x6, 0xee, 0xf8, 0xf1, 0xe3, 0xc7,
    0x9a, 0xf0,

    /* U+0063 "c" */
    0x3c, 0xcf, 0x6, 0xc, 0x18, 0x19, 0x9e,

    /* U+0064 "d" */
    0x6, 0xc, 0x1b, 0xb6, 0xf8, 0xf1, 0xe3, 0xc7,
    0xcd, 0xf8,

    /* U+0065 "e" */
    0x38, 0xcb, 0x1f, 0xfc, 0x18, 0x19, 0x9e,

    /* U+0066 "f" */
    0x3b, 0x19, 0xf6, 0x31, 0x8c, 0x63, 0x18,

    /* U+0067 "g" */
    0x7f, 0xc6, 0xc6, 0xfc, 0x40, 0xc0, 0x7e, 0xc3,
    0xc3, 0x7e,

    /* U+0068 "h" */
    0xc1, 0x83, 0x6, 0xee, 0x78, 0xf1, 0xe3, 0xc7,
    0x8f, 0x18,

    /* U+0069 "i" */
    0xf3, 0xff, 0xfc,

    /* U+006A "j" */
    0x6c, 0x36, 0xdb, 0x6d, 0xfc,

    /* U+006B "k" */
    0xc1, 0x83, 0x6, 0x3c, 0xdb, 0x3e, 0x76, 0xcd,
    0x8f, 0x18,

    /* U+006C "l" */
    0xff, 0xff, 0xfc,

    /* U+006D "m" */
    0xdc, 0xee, 0x73, 0xc6, 0x3c, 0x63, 0xc6, 0x3c,
    0x63, 0xc6, 0x3c, 0x63,

    /* U+006E "n" */
    0xdd, 0xcf, 0x1e, 0x3c, 0x78, 0xf1, 0xe3,

    /* U+006F "o" */
    0x38, 0xdb, 0x1e, 0x3c, 0x78, 0xdb, 0x1c,

    /* U+0070 "p" */
    0xfd, 0x9f, 0x1e, 0x3c, 0x78, 0xf3, 0x7e, 0xc1,
    0x80,

    /* U+0071 "q" */
    0x7a, 0xcf, 0x1e, 0x3c, 0x78, 0xd9, 0xbf, 0x6,
    0xc,

    /* U+0072 "r" */
    0xdf, 0xf1, 0x8c, 0x63, 0x18,

    /* U+0073 "s" */
    0x3e, 0xc5, 0x83, 0xe3, 0xe0, 0xf1, 0xbe,

    /* U+0074 "t" */
    0x63, 0x19, 0xf6, 0x31, 0x8c, 0x63, 0xe,

    /* U+0075 "u" */
    0xc7, 0x8f, 0x1e, 0x3c, 0x78, 0xf3, 0xbb,

    /* U+0076 "v" */
    0xc2, 0x62, 0x66, 0x34, 0x34, 0x3c, 0x18, 0x18,

    /* U+0077 "w" */
    0xc6, 0x2c, 0xcd, 0xb9, 0x37, 0xa2, 0xbc, 0x77,
    0xe, 0x60, 0x8c,

    /* U+0078 "x" */
    0x66, 0x64, 0x3c, 0x18, 0x1c, 0x3c, 0x66, 0xc7,

    /* U+0079 "y" */
    0xc7, 0x89, 0x13, 0x66, 0x87, 0xc, 0x18, 0x31,
    0xc0,

    /* U+007A "z" */
    0xfc, 0x71, 0x8c, 0x71, 0x8c, 0x3f,

    /* U+007B "{" */
    0x19, 0x8c, 0x63, 0x1b, 0x86, 0x31, 0x8c, 0x61,
    0x80,

    /* U+007C "|" */
    0xff, 0xff, 0xff, 0xfc,

    /* U+007D "}" */
    0xe0, 0xc3, 0xc, 0x30, 0xc1, 0xcc, 0x30, 0xc3,
    0xc, 0xe0,

    /* U+007E "~" */
    0xe1, 0x38,

    /* U+00A0 " " */
    0x0,

    /* U+00A1 "¡" */
    0xf3, 0xff, 0xf0,

    /* U+00A2 "¢" */
    0x10, 0x71, 0xb6, 0x2c, 0x18, 0x30, 0x61, 0x7e,
    0x78, 0x40,

    /* U+00A3 "£" */
    0x1e, 0x33, 0x60, 0x60, 0x70, 0xfc, 0x30, 0x30,
    0x30, 0x63, 0xfe,

    /* U+00A4 "¤" */
    0xff, 0x38, 0x61, 0xcf, 0xf0,

    /* U+00A5 "¥" */
    0x61, 0xb8, 0xcc, 0xc7, 0x61, 0xe0, 0xe1, 0xfc,
    0x18, 0x7f, 0x6, 0x3, 0x0,

    /* U+00A6 "¦" */
    0xff, 0xf0, 0x3f, 0xfc,

    /* U+00A7 "§" */
    0x3c, 0xcd, 0x81, 0xc3, 0xec, 0xd9, 0x9e, 0x1c,
    0xf, 0x1b, 0xe0,

    /* U+00A8 "¨" */
    0xff,

    /* U+00A9 "©" */
    0x1f, 0x4, 0x11, 0x39, 0x59, 0x9b, 0x3, 0x60,
    0x6c, 0xcc, 0xf1, 0x40, 0x44, 0x10, 0x7c, 0x0,

    /* U+00AA "ª" */
    0x79, 0x79, 0xf0,

    /* U+00AB "«" */
    0x4e, 0xad, 0xa4, 0x80,

    /* U+00AC "¬" */
    0xfe, 0xc, 0x18,

    /* U+00AE "®" */
    0x38, 0x8a, 0xed, 0xda, 0xa8, 0x8e, 0x0,

    /* U+00AF "¯" */
    0xf8,

    /* U+00B0 "°" */
    0x74, 0x63, 0x17, 0x0,

    /* U+00B1 "±" */
    0x30, 0x60, 0xc7, 0xe3, 0x6, 0xc, 0x0, 0x1,
    0xfc,

    /* U+00B2 "²" */
    0xe9, 0x12, 0x48, 0xf0,

    /* U+00B3 "³" */
    0x7a, 0x42, 0x60, 0x85, 0xc0,

    /* U+00B4 "´" */
    0x3e,

    /* U+00B5 "µ" */
    0xc7, 0x8f, 0x1e, 0x3c, 0x78, 0xfb, 0xfb, 0xc1,
    0x80,

    /* U+00B6 "¶" */
    0x7f, 0xeb, 0xd7, 0xaf, 0x4e, 0x85, 0xa, 0x14,
    0x28, 0x50, 0xa0,

    /* U+00B7 "·" */
    0xf0,

    /* U+00B8 "¸" */
    0x47, 0x80,

    /* U+00B9 "¹" */
    0xd9, 0x24, 0xb8,

    /* U+00BA "º" */
    0x74, 0x63, 0x17, 0x0,

    /* U+00BB "»" */
    0x96, 0x93, 0xa9, 0x0,

    /* U+00BC "¼" */
    0x60, 0xce, 0x8, 0x61, 0x6, 0x10, 0x62, 0x66,
    0x4e, 0xf5, 0x60, 0xa6, 0x1b, 0xf1, 0x6, 0x20,
    0x60,

    /* U+00BD "½" */
    0x60, 0x47, 0x4, 0x18, 0x40, 0xc2, 0x6, 0x2f,
    0x33, 0x4f, 0xd0, 0x61, 0x6, 0x8, 0x70, 0x86,
    0x8, 0x3e,

    /* U+00BE "¾" */
    0x78, 0x42, 0x42, 0x2, 0x20, 0x63, 0x0, 0x93,
    0x45, 0x39, 0xca, 0xc0, 0xa6, 0x9, 0xf8, 0x41,
    0x84, 0xc,

    /* U+00BF "¿" */
    0x18, 0x30, 0x0, 0xc1, 0xe, 0x38, 0x60, 0xc6,
    0xf8,

    /* U+00C0 "À" */
    0x1c, 0x1, 0x80, 0x0, 0x38, 0xe, 0x7, 0x81,
    0xf0, 0x4c, 0x33, 0xc, 0xe3, 0xf9, 0x86, 0x60,
    0xd0, 0x30,

    /* U+00C1 "Á" */
    0x6, 0x7, 0x0, 0x0, 0x38, 0xe, 0x7, 0x81,
    0xf0, 0x4c, 0x33, 0xc, 0xe3, 0xf9, 0x86, 0x60,
    0xd0, 0x30,

    /* U+00C2 "Â" */
    0xe, 0x4, 0x80, 0x0, 0x38, 0xe, 0x7, 0x81,
    0xf0, 0x4c, 0x33, 0xc, 0xe3, 0xf9, 0x86, 0x60,
    0xd0, 0x30,

    /* U+00C3 "Ã" */
    0x1f, 0x0, 0x0, 0x0, 0x38, 0xe, 0x7, 0x81,
    0xf0, 0x4c, 0x33, 0xc, 0xe3, 0xf9, 0x86, 0x60,
    0xd0, 0x30,

    /* U+00C4 "Ä" */
    0x1e, 0x7, 0x80, 0x0, 0x30, 0xe, 0x7, 0x81,
    0xe0, 0xcc, 0x33, 0xc, 0xc7, 0xf9, 0x86, 0x61,
    0xf0, 0x30,

    /* U+00C5 "Å" */
    0x1c, 0xa, 0x7, 0x0, 0x1, 0xc0, 0xe0, 0x78,
    0x7c, 0x26, 0x13, 0x99, 0xcf, 0xe4, 0x1e, 0xf,
    0x6,

    /* U+00C6 "Æ" */
    0x3, 0xfc, 0x1e, 0x0, 0x58, 0x3, 0x60, 0x9,
    0x80, 0x67, 0xe1, 0x18, 0xf, 0xe0, 0x21, 0x81,
    0x86, 0x4, 0x1f, 0xc0,

    /* U+00C7 "Ç" */
    0x3e, 0x31, 0x90, 0xd8, 0xc, 0x6, 0x3, 0x1,
    0x80, 0x41, 0xb1, 0x8f, 0x81, 0x0, 0x40, 0xe0,

    /* U+00C8 "È" */
    0x30, 0x18, 0x7, 0xfc, 0x18, 0x30, 0x60, 0xfd,
    0x83, 0x6, 0xc, 0x1f, 0xc0,

    /* U+00C9 "É" */
    0x1c, 0x60, 0x7, 0xfc, 0x18, 0x30, 0x60, 0xfd,
    0x83, 0x6, 0xc, 0x1f, 0xc0,

    /* U+00CA "Ê" */
    0x38, 0x88, 0x7, 0xfc, 0x18, 0x30, 0x60, 0xfd,
    0x83, 0x6, 0xc, 0x1f, 0xc0,

    /* U+00CB "Ë" */
    0x6c, 0xd8, 0x7, 0xfc, 0x18, 0x30, 0x60, 0xfd,
    0x83, 0x6, 0xc, 0x1f, 0xc0,

    /* U+00CC "Ì" */
    0xe3, 0x6, 0x66, 0x66, 0x66, 0x66, 0x66,

    /* U+00CD "Í" */
    0x3c, 0x6, 0x66, 0x66, 0x66, 0x66, 0x66,

    /* U+00CE "Î" */
    0x69, 0x6, 0x66, 0x66, 0x66, 0x66, 0x66,

    /* U+00CF "Ï" */
    0xff, 0x6, 0x66, 0x66, 0x66, 0x66, 0x66,

    /* U+00D0 "Ð" */
    0x7c, 0x31, 0x98, 0xcc, 0x36, 0x1f, 0xed, 0x86,
    0xc3, 0x63, 0x31, 0x9f, 0x0,

    /* U+00D1 "Ñ" */
    0x3e, 0x0, 0x0, 0x18, 0x3e, 0x1f, 0x8f, 0xc7,
    0xb3, 0xdd, 0xe6, 0xf1, 0xf8, 0xfc, 0x3e, 0xc,

    /* U+00D2 "Ò" */
    0x18, 0x6, 0x0, 0x7, 0xc6, 0x32, 0x1b, 0x7,
    0x83, 0xc1, 0xe0, 0xf0, 0x68, 0x26, 0x31, 0xf0,

    /* U+00D3 "Ó" */
    0xc, 0xc, 0x0, 0x7, 0xc6, 0x32, 0x1b, 0x7,
    0x83, 0xc1, 0xe0, 0xf0, 0x68, 0x26, 0x31, 0xf0,

    /* U+00D4 "Ô" */
    0x8, 0xa, 0x8, 0x80, 0x3, 0xe3, 0x19, 0xd,
    0x83, 0xc1, 0xe0, 0xf0, 0x78, 0x34, 0x13, 0x18,
    0xf8,

    /* U+00D5 "Õ" */
    0x3e, 0x0, 0x0, 0x7, 0xc6, 0x32, 0x1b, 0x7,
    0x83, 0xc1, 0xe0, 0xf0, 0x68, 0x26, 0x31, 0xf0,

    /* U+00D6 "Ö" */
    0x36, 0x1b, 0x0, 0x7, 0xc6, 0x32, 0x1b, 0x7,
    0x83, 0xc1, 0xe0, 0xf0, 0x68, 0x26, 0x31, 0xf0,

    /* U+00D7 "×" */
    0x87, 0x37, 0x8c, 0x7b, 0x30, 0x40,

    /* U+00D8 "Ø" */
    0x0, 0x3, 0xe8, 0xc7, 0x10, 0xe6, 0x3c, 0xc5,
    0x99, 0x33, 0x66, 0x78, 0xce, 0x11, 0xc6, 0x2f,
    0x80,

    /* U+00D9 "Ù" */
    0x38, 0xc, 0x0, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc3, 0xc3, 0xc3, 0xc3, 0x66, 0x3c,

    /* U+00DA "Ú" */
    0xc, 0x30, 0x0, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc3, 0xc3, 0xc3, 0xc3, 0x66, 0x3c,

    /* U+00DB "Û" */
    0x0, 0x18, 0x24, 0x0, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0x66, 0x3c,

    /* U+00DC "Ü" */
    0x3c, 0x3c, 0x0, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3,
    0xc3, 0xc3, 0xc3, 0xc3, 0x66, 0x3c,

    /* U+00DD "Ý" */
    0x6, 0xc, 0x0, 0xc, 0x36, 0x19, 0x98, 0xec,
    0x3c, 0x1c, 0x6, 0x3, 0x1, 0x80, 0xc0, 0x60,

    /* U+00DE "Þ" */
    0xc0, 0xc0, 0xfc, 0xc7, 0xc3, 0xc3, 0xc7, 0xfe,
    0xc0, 0xc0, 0xc0,

    /* U+00DF "ß" */
    0x3c, 0x66, 0x66, 0xec, 0x68, 0x6c, 0x6e, 0x67,
    0x63, 0x63, 0x7e,

    /* U+00E0 "à" */
    0x30, 0x38, 0x3, 0xec, 0x60, 0xcf, 0xf3, 0xc7,
    0x9d, 0xd8,

    /* U+00E1 "á" */
    0xc, 0x70, 0x3, 0xec, 0x60, 0xcf, 0xf3, 0xc7,
    0x9d, 0xd8,

    /* U+00E2 "â" */
    0x18, 0x58, 0x3, 0xec, 0x60, 0xcf, 0xf3, 0xc7,
    0x9d, 0xd8,

    /* U+00E3 "ã" */
    0x7c, 0x0, 0x3, 0xec, 0x60, 0xcf, 0xf3, 0xc7,
    0x9d, 0xd8,

    /* U+00E4 "ä" */
    0x6c, 0xd8, 0x3, 0xec, 0x60, 0xdf, 0xf3, 0xc7,
    0x9d, 0xd8,

    /* U+00E5 "å" */
    0x38, 0x50, 0xe0, 0x7, 0xd8, 0xc1, 0xbf, 0xe7,
    0x8f, 0x3b, 0xb0,

    /* U+00E6 "æ" */
    0x3d, 0xcc, 0x72, 0x6, 0x37, 0xff, 0xe6, 0xc,
    0x60, 0xc7, 0x37, 0x9e,

    /* U+00E7 "ç" */
    0x38, 0xcb, 0x6, 0xc, 0x18, 0x19, 0x9e, 0x10,
    0x10, 0xe0,

    /* U+00E8 "è" */
    0x60, 0x70, 0x1, 0xc6, 0x58, 0xff, 0xe0, 0xc0,
    0xcc, 0xf0,

    /* U+00E9 "é" */
    0x18, 0xe0, 0x1, 0xc6, 0x58, 0xff, 0xe0, 0xc0,
    0xcc, 0xf0,

    /* U+00EA "ê" */
    0x30, 0x50, 0x1, 0xc6, 0x58, 0xff, 0xe0, 0xc0,
    0xcc, 0xf0,

    /* U+00EB "ë" */
    0x6c, 0xd8, 0x1, 0xc6, 0x58, 0xff, 0xe0, 0xc0,
    0xcc, 0xf0,

    /* U+00EC "ì" */
    0xc7, 0x6, 0x66, 0x66, 0x66, 0x60,

    /* U+00ED "í" */
    0x3e, 0x6, 0x66, 0x66, 0x66, 0x60,

    /* U+00EE "î" */
    0x64, 0x80, 0xc6, 0x31, 0x8c, 0x63, 0x18,

    /* U+00EF "ï" */
    0xff, 0x6, 0x66, 0x66, 0x66, 0x60,

    /* U+00F0 "ð" */
    0x68, 0x71, 0x31, 0xe6, 0xf8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F1 "ñ" */
    0x70, 0x38, 0x6, 0xee, 0x78, 0xf1, 0xe3, 0xc7,
    0x8f, 0x18,

    /* U+00F2 "ò" */
    0x60, 0x70, 0x1, 0xc6, 0xd8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F3 "ó" */
    0x18, 0xe0, 0x1, 0xc6, 0xd8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F4 "ô" */
    0x10, 0x50, 0x1, 0xc6, 0xd8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F5 "õ" */
    0x3c, 0x0, 0x1, 0xc6, 0xd8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F6 "ö" */
    0x6c, 0xd8, 0x1, 0xc6, 0xd8, 0xf1, 0xe3, 0xc6,
    0xd8, 0xe0,

    /* U+00F7 "÷" */
    0x30, 0x60, 0x0, 0xf, 0xe0, 0xc, 0x18,

    /* U+00F8 "ø" */
    0x39, 0x6e, 0xc6, 0xce, 0xd6, 0xe6, 0x6c, 0xb8,

    /* U+00F9 "ù" */
    0x60, 0x70, 0x6, 0x3c, 0x78, 0xf1, 0xe3, 0xc7,
    0x9d, 0xd8,

    /* U+00FA "ú" */
    0x18, 0xe0, 0x6, 0x3c, 0x78, 0xf1, 0xe3, 0xc7,
    0x9d, 0xd8,

    /* U+00FB "û" */
    0x38, 0xd8, 0x6, 0x3c, 0x78, 0xf1, 0xe3, 0xc7,
    0x9d, 0xd8,

    /* U+00FC "ü" */
    0x78, 0xf0, 0x6, 0x3c, 0x78, 0xf1, 0xe3, 0xc7,
    0x9d, 0xd8,

    /* U+00FD "ý" */
    0x18, 0xe0, 0x6, 0x3c, 0x48, 0x9b, 0x34, 0x38,
    0x60, 0xc1, 0x8e, 0x0,

    /* U+00FE "þ" */
    0xc1, 0x83, 0x6, 0xee, 0xf8, 0xf1, 0xe3, 0xc7,
    0x9b, 0xf6, 0xc, 0x0,

    /* U+00FF "ÿ" */
    0x3c, 0x78, 0x6, 0x16, 0x6c, 0x99, 0x1e, 0x38,
    0x30, 0x40, 0x8e, 0x0,

    /* U+2010 "‐" */
    0xf0,

    /* U+2013 "–" */
    0xfe,

    /* U+2014 "—" */
    0xff, 0xe0,

    /* U+2018 "‘" */
    0x7f,

    /* U+2019 "’" */
    0xfe,

    /* U+201A "‚" */
    0xf6,

    /* U+201C "“" */
    0x4e, 0xb7, 0xb0,

    /* U+201D "”" */
    0xde, 0xf5, 0x20,

    /* U+201E "„" */
    0xde, 0xd7, 0x20,

    /* U+2020 "†" */
    0x18, 0x30, 0x60, 0x8f, 0xe3, 0x6, 0xc, 0x18,
    0x30, 0x60, 0xc1, 0x80,

    /* U+2021 "‡" */
    0x30, 0xc3, 0xc, 0xfc, 0x41, 0x4, 0xff, 0x71,
    0x4, 0x10,

    /* U+2022 "•" */
    0xff, 0x80,

    /* U+2026 "…" */
    0xcc, 0xf3, 0x30,

    /* U+2030 "‰" */
    0x70, 0x80, 0x36, 0x20, 0xd, 0x90, 0x3, 0x68,
    0x0, 0xda, 0x0, 0x1d, 0x79, 0xe0, 0xf3, 0xcc,
    0x2c, 0xf3, 0x13, 0x3c, 0xcc, 0xcf, 0x32, 0x1e,
    0x78,

    /* U+2032 "′" */
    0x6b, 0x68,

    /* U+2033 "″" */
    0x79, 0x6d, 0xb4, 0x90,

    /* U+2039 "‹" */
    0x7b, 0x40,

    /* U+203A "›" */
    0xb7, 0x80,

    /* U+2044 "⁄" */
    0x2, 0x2, 0x4, 0xc, 0x8, 0x10, 0x30, 0x20,
    0x40, 0x40, 0x80,

    /* U+20AC "€" */
    0x1f, 0x30, 0x20, 0x60, 0xfc, 0x60, 0xfc, 0x60,
    0x20, 0x31, 0x1f,

    /* U+2116 "№" */
    0xc1, 0x9b, 0x86, 0x9f, 0x1a, 0x7c, 0x6f, 0xd9,
    0x83, 0x36, 0xc, 0x78, 0x31, 0xe0, 0xc3, 0x83,
    0x6, 0x0,

    /* U+2122 "™" */
    0xfb, 0x19, 0x18, 0xc8, 0xae, 0x45, 0x52, 0x2e,
    0x91, 0x24,

    /* U+2248 "≈" */
    0x61, 0x38, 0x7, 0xe0,

    /* U+2260 "≠" */
    0x4, 0x13, 0xf8, 0x81, 0x1f, 0xc8, 0x20,

    /* U+2264 "≤" */
    0x2, 0x1d, 0xe7, 0xf, 0x83, 0xc0, 0x80, 0xfe,

    /* U+2265 "≥" */
    0x81, 0xc0, 0xf0, 0x73, 0xfe, 0x20, 0x0, 0xfe
};


/*---------------------
 *  GLYPH DESCRIPTION
 *--------------------*/

static const lv_font_fmt_txt_glyph_dsc_t glyph_dsc[] = {
    {.bitmap_index = 0, .adv_w = 0, .box_w = 0, .box_h = 0, .ofs_x = 0, .ofs_y = 0} /* id = 0 reserved */,
    {.bitmap_index = 0, .adv_w = 47, .box_w = 1, .box_h = 1, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1, .adv_w = 58, .box_w = 2, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 4, .adv_w = 101, .box_w = 5, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 7, .adv_w = 135, .box_w = 8, .box_h = 12, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 19, .adv_w = 143, .box_w = 9, .box_h = 13, .ofs_x = 0, .ofs_y = -1},
    {.bitmap_index = 34, .adv_w = 209, .box_w = 12, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 51, .adv_w = 183, .box_w = 11, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 67, .adv_w = 55, .box_w = 2, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 68, .adv_w = 68, .box_w = 4, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 75, .adv_w = 68, .box_w = 4, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 82, .adv_w = 98, .box_w = 6, .box_h = 6, .ofs_x = 0, .ofs_y = 5},
    {.bitmap_index = 87, .adv_w = 129, .box_w = 6, .box_h = 7, .ofs_x = 1, .ofs_y = 2},
    {.bitmap_index = 93, .adv_w = 54, .box_w = 2, .box_h = 4, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 94, .adv_w = 85, .box_w = 4, .box_h = 1, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 95, .adv_w = 53, .box_w = 2, .box_h = 2, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 96, .adv_w = 80, .box_w = 5, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 103, .adv_w = 157, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 114, .adv_w = 111, .box_w = 6, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 123, .adv_w = 141, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 133, .adv_w = 147, .box_w = 8, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 144, .adv_w = 151, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 155, .adv_w = 150, .box_w = 8, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 166, .adv_w = 152, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 177, .adv_w = 137, .box_w = 8, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 188, .adv_w = 152, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 199, .adv_w = 151, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 210, .adv_w = 53, .box_w = 2, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 212, .adv_w = 56, .box_w = 2, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 215, .adv_w = 127, .box_w = 7, .box_h = 7, .ofs_x = 1, .ofs_y = 2},
    {.bitmap_index = 222, .adv_w = 129, .box_w = 7, .box_h = 4, .ofs_x = 1, .ofs_y = 4},
    {.bitmap_index = 226, .adv_w = 127, .box_w = 7, .box_h = 7, .ofs_x = 1, .ofs_y = 2},
    {.bitmap_index = 233, .adv_w = 119, .box_w = 7, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 243, .adv_w = 187, .box_w = 11, .box_h = 11, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 259, .adv_w = 169, .box_w = 10, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 273, .adv_w = 160, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 284, .adv_w = 161, .box_w = 9, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 297, .adv_w = 166, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 308, .adv_w = 144, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 318, .adv_w = 139, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 328, .adv_w = 167, .box_w = 9, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 341, .adv_w = 167, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 352, .adv_w = 69, .box_w = 2, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 355, .adv_w = 98, .box_w = 5, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 362, .adv_w = 163, .box_w = 9, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 375, .adv_w = 139, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 385, .adv_w = 209, .box_w = 11, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 401, .adv_w = 170, .box_w = 9, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 414, .adv_w = 172, .box_w = 9, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 427, .adv_w = 158, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 438, .adv_w = 173, .box_w = 9, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 453, .adv_w = 160, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 464, .adv_w = 149, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 475, .adv_w = 150, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 486, .adv_w = 161, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 497, .adv_w = 162, .box_w = 10, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 511, .adv_w = 240, .box_w = 13, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 529, .adv_w = 160, .box_w = 10, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 543, .adv_w = 160, .box_w = 9, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 556, .adv_w = 149, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 567, .adv_w = 69, .box_w = 4, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 574, .adv_w = 80, .box_w = 5, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 581, .adv_w = 69, .box_w = 4, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 588, .adv_w = 106, .box_w = 6, .box_h = 6, .ofs_x = 0, .ofs_y = 2},
    {.bitmap_index = 593, .adv_w = 120, .box_w = 6, .box_h = 1, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 594, .adv_w = 67, .box_w = 4, .box_h = 2, .ofs_x = 0, .ofs_y = 9},
    {.bitmap_index = 595, .adv_w = 125, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 602, .adv_w = 136, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 612, .adv_w = 123, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 619, .adv_w = 136, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 629, .adv_w = 131, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 636, .adv_w = 88, .box_w = 5, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 643, .adv_w = 139, .box_w = 8, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 653, .adv_w = 133, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 663, .adv_w = 57, .box_w = 2, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 666, .adv_w = 57, .box_w = 3, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 671, .adv_w = 132, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 681, .adv_w = 58, .box_w = 2, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 684, .adv_w = 205, .box_w = 12, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 696, .adv_w = 133, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 703, .adv_w = 134, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 710, .adv_w = 136, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 719, .adv_w = 136, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 728, .adv_w = 92, .box_w = 5, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 733, .adv_w = 117, .box_w = 7, .box_h = 8, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 740, .adv_w = 93, .box_w = 5, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 747, .adv_w = 132, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 754, .adv_w = 126, .box_w = 8, .box_h = 8, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 762, .adv_w = 182, .box_w = 11, .box_h = 8, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 773, .adv_w = 129, .box_w = 8, .box_h = 8, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 781, .adv_w = 124, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 790, .adv_w = 113, .box_w = 6, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 796, .adv_w = 77, .box_w = 5, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 805, .adv_w = 57, .box_w = 2, .box_h = 15, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 809, .adv_w = 77, .box_w = 6, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 819, .adv_w = 133, .box_w = 7, .box_h = 2, .ofs_x = 1, .ofs_y = 5},
    {.bitmap_index = 821, .adv_w = 47, .box_w = 1, .box_h = 1, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 822, .adv_w = 58, .box_w = 2, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 825, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 835, .adv_w = 142, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 846, .adv_w = 126, .box_w = 6, .box_h = 6, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 851, .adv_w = 144, .box_w = 9, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 864, .adv_w = 57, .box_w = 2, .box_h = 15, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 868, .adv_w = 112, .box_w = 7, .box_h = 12, .ofs_x = 0, .ofs_y = -1},
    {.bitmap_index = 879, .adv_w = 72, .box_w = 4, .box_h = 2, .ofs_x = 1, .ofs_y = 9},
    {.bitmap_index = 880, .adv_w = 186, .box_w = 11, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 896, .adv_w = 88, .box_w = 4, .box_h = 5, .ofs_x = 1, .ofs_y = 6},
    {.bitmap_index = 899, .adv_w = 106, .box_w = 5, .box_h = 5, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 903, .adv_w = 129, .box_w = 7, .box_h = 3, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 906, .adv_w = 122, .box_w = 7, .box_h = 7, .ofs_x = 1, .ofs_y = 4},
    {.bitmap_index = 913, .adv_w = 81, .box_w = 5, .box_h = 1, .ofs_x = 1, .ofs_y = 10},
    {.bitmap_index = 914, .adv_w = 104, .box_w = 5, .box_h = 5, .ofs_x = 1, .ofs_y = 8},
    {.bitmap_index = 918, .adv_w = 129, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 927, .adv_w = 101, .box_w = 4, .box_h = 7, .ofs_x = 1, .ofs_y = 5},
    {.bitmap_index = 931, .adv_w = 105, .box_w = 5, .box_h = 7, .ofs_x = 0, .ofs_y = 5},
    {.bitmap_index = 936, .adv_w = 67, .box_w = 4, .box_h = 2, .ofs_x = 0, .ofs_y = 9},
    {.bitmap_index = 937, .adv_w = 132, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 946, .adv_w = 132, .box_w = 7, .box_h = 12, .ofs_x = 1, .ofs_y = -1},
    {.bitmap_index = 957, .adv_w = 52, .box_w = 2, .box_h = 2, .ofs_x = 1, .ofs_y = 5},
    {.bitmap_index = 958, .adv_w = 55, .box_w = 3, .box_h = 3, .ofs_x = 0, .ofs_y = -3},
    {.bitmap_index = 960, .adv_w = 82, .box_w = 3, .box_h = 7, .ofs_x = 1, .ofs_y = 5},
    {.bitmap_index = 963, .adv_w = 90, .box_w = 5, .box_h = 5, .ofs_x = 1, .ofs_y = 6},
    {.bitmap_index = 967, .adv_w = 106, .box_w = 5, .box_h = 5, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 971, .adv_w = 207, .box_w = 12, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 988, .adv_w = 219, .box_w = 13, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1006, .adv_w = 220, .box_w = 13, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1024, .adv_w = 118, .box_w = 7, .box_h = 10, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1033, .adv_w = 169, .box_w = 10, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1051, .adv_w = 169, .box_w = 10, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1069, .adv_w = 169, .box_w = 10, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1087, .adv_w = 169, .box_w = 10, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1105, .adv_w = 169, .box_w = 10, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1123, .adv_w = 169, .box_w = 9, .box_h = 15, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1140, .adv_w = 236, .box_w = 14, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1160, .adv_w = 161, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = -3},
    {.bitmap_index = 1176, .adv_w = 144, .box_w = 7, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1189, .adv_w = 144, .box_w = 7, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1202, .adv_w = 144, .box_w = 7, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1215, .adv_w = 144, .box_w = 7, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1228, .adv_w = 69, .box_w = 4, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1235, .adv_w = 69, .box_w = 4, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1242, .adv_w = 69, .box_w = 4, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1249, .adv_w = 69, .box_w = 4, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1256, .adv_w = 169, .box_w = 9, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1269, .adv_w = 170, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1285, .adv_w = 172, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1301, .adv_w = 172, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1317, .adv_w = 172, .box_w = 9, .box_h = 15, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1334, .adv_w = 172, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1350, .adv_w = 172, .box_w = 9, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1366, .adv_w = 126, .box_w = 6, .box_h = 7, .ofs_x = 1, .ofs_y = 2},
    {.bitmap_index = 1372, .adv_w = 168, .box_w = 11, .box_h = 12, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1389, .adv_w = 161, .box_w = 8, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1403, .adv_w = 161, .box_w = 8, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1417, .adv_w = 161, .box_w = 8, .box_h = 15, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1432, .adv_w = 161, .box_w = 8, .box_h = 14, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1446, .adv_w = 160, .box_w = 9, .box_h = 14, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1462, .adv_w = 160, .box_w = 8, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1473, .adv_w = 142, .box_w = 8, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1484, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1494, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1504, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1514, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1524, .adv_w = 125, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1534, .adv_w = 125, .box_w = 7, .box_h = 12, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1545, .adv_w = 205, .box_w = 12, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1557, .adv_w = 123, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = -3},
    {.bitmap_index = 1567, .adv_w = 131, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1577, .adv_w = 131, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1587, .adv_w = 131, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1597, .adv_w = 131, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1607, .adv_w = 57, .box_w = 4, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1613, .adv_w = 57, .box_w = 4, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1619, .adv_w = 57, .box_w = 5, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1626, .adv_w = 57, .box_w = 4, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1632, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1642, .adv_w = 133, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1652, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1662, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1672, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1682, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1692, .adv_w = 134, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1702, .adv_w = 129, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 2},
    {.bitmap_index = 1709, .adv_w = 132, .box_w = 8, .box_h = 8, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1717, .adv_w = 132, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1727, .adv_w = 132, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1737, .adv_w = 132, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1747, .adv_w = 132, .box_w = 7, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1757, .adv_w = 124, .box_w = 7, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1769, .adv_w = 135, .box_w = 7, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1781, .adv_w = 124, .box_w = 7, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 1793, .adv_w = 85, .box_w = 4, .box_h = 1, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 1794, .adv_w = 129, .box_w = 7, .box_h = 1, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 1795, .adv_w = 201, .box_w = 11, .box_h = 1, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 1797, .adv_w = 52, .box_w = 2, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 1798, .adv_w = 52, .box_w = 2, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 1799, .adv_w = 52, .box_w = 2, .box_h = 4, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1800, .adv_w = 99, .box_w = 5, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 1803, .adv_w = 100, .box_w = 5, .box_h = 4, .ofs_x = 1, .ofs_y = 7},
    {.bitmap_index = 1806, .adv_w = 100, .box_w = 5, .box_h = 4, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1809, .adv_w = 110, .box_w = 7, .box_h = 13, .ofs_x = 0, .ofs_y = -2},
    {.bitmap_index = 1821, .adv_w = 110, .box_w = 6, .box_h = 13, .ofs_x = 1, .ofs_y = -2},
    {.bitmap_index = 1831, .adv_w = 74, .box_w = 3, .box_h = 3, .ofs_x = 1, .ofs_y = 4},
    {.bitmap_index = 1833, .adv_w = 188, .box_w = 10, .box_h = 2, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1836, .adv_w = 303, .box_w = 18, .box_h = 11, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1861, .adv_w = 58, .box_w = 3, .box_h = 5, .ofs_x = 0, .ofs_y = 6},
    {.bitmap_index = 1863, .adv_w = 99, .box_w = 6, .box_h = 5, .ofs_x = 0, .ofs_y = 6},
    {.bitmap_index = 1867, .adv_w = 63, .box_w = 2, .box_h = 5, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 1869, .adv_w = 63, .box_w = 2, .box_h = 5, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 1871, .adv_w = 55, .box_w = 8, .box_h = 11, .ofs_x = -2, .ofs_y = 0},
    {.bitmap_index = 1882, .adv_w = 142, .box_w = 8, .box_h = 11, .ofs_x = 0, .ofs_y = 0},
    {.bitmap_index = 1893, .adv_w = 253, .box_w = 14, .box_h = 10, .ofs_x = 1, .ofs_y = 0},
    {.bitmap_index = 1911, .adv_w = 220, .box_w = 13, .box_h = 6, .ofs_x = 0, .ofs_y = 4},
    {.bitmap_index = 1921, .adv_w = 133, .box_w = 7, .box_h = 4, .ofs_x = 1, .ofs_y = 3},
    {.bitmap_index = 1925, .adv_w = 134, .box_w = 7, .box_h = 8, .ofs_x = 1, .ofs_y = 1},
    {.bitmap_index = 1932, .adv_w = 128, .box_w = 7, .box_h = 9, .ofs_x = 0, .ofs_y = 1},
    {.bitmap_index = 1940, .adv_w = 128, .box_w = 7, .box_h = 9, .ofs_x = 1, .ofs_y = 1}
};

/*---------------------
 *  CHARACTER MAPPING
 *--------------------*/

static const uint16_t unicode_list_3[] = {
    0x0, 0x3, 0x4, 0x8, 0x9, 0xa, 0xc, 0xd,
    0xe, 0x10, 0x11, 0x12, 0x16, 0x20, 0x22, 0x23,
    0x29, 0x2a, 0x34, 0x9c, 0x106, 0x112, 0x238, 0x250,
    0x254, 0x255
};

/*Collect the unicode lists and glyph_id offsets*/
static const lv_font_fmt_txt_cmap_t cmaps[] =
{
    {
        .range_start = 32, .range_length = 95, .glyph_id_start = 1,
        .unicode_list = NULL, .glyph_id_ofs_list = NULL, .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY
    },
    {
        .range_start = 160, .range_length = 13, .glyph_id_start = 96,
        .unicode_list = NULL, .glyph_id_ofs_list = NULL, .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY
    },
    {
        .range_start = 174, .range_length = 82, .glyph_id_start = 109,
        .unicode_list = NULL, .glyph_id_ofs_list = NULL, .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY
    },
    {
        .range_start = 8208, .range_length = 598, .glyph_id_start = 191,
        .unicode_list = unicode_list_3, .glyph_id_ofs_list = NULL, .list_length = 26, .type = LV_FONT_FMT_TXT_CMAP_SPARSE_TINY
    }
};

/*-----------------
 *    KERNING
 *----------------*/


/*Map glyph_ids to kern left classes*/
static const uint8_t kern_left_class_mapping[] =
{
    0, 0, 0, 1, 0, 0, 0, 0,
    1, 2, 0, 0, 0, 3, 4, 3,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 5, 6, 7, 8, 9, 10,
    11, 0, 0, 12, 13, 14, 0, 0,
    8, 15, 8, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 0, 0, 0,
    0, 0, 26, 27, 28, 0, 29, 30,
    31, 32, 0, 33, 34, 0, 32, 32,
    35, 27, 0, 36, 37, 38, 0, 39,
    40, 41, 42, 43, 44, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 45, 5,
    5, 5, 5, 5, 5, 9, 7, 9,
    9, 9, 9, 0, 0, 0, 0, 8,
    0, 8, 8, 8, 8, 8, 0, 0,
    19, 19, 19, 19, 23, 0, 0, 26,
    26, 26, 26, 26, 26, 29, 28, 29,
    29, 29, 29, 0, 0, 0, 0, 0,
    32, 35, 35, 35, 35, 35, 0, 35,
    0, 0, 0, 0, 42, 0, 42, 0,
    4, 4, 46, 47, 0, 46, 47, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0
};

/*Map glyph_ids to kern right classes*/
static const uint8_t kern_right_class_mapping[] =
{
    0, 0, 0, 1, 0, 0, 0, 0,
    1, 0, 2, 3, 0, 4, 5, 4,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 6, 6, 0, 0, 0,
    2, 0, 7, 0, 8, 0, 0, 0,
    8, 0, 0, 9, 0, 0, 0, 0,
    8, 0, 8, 0, 10, 11, 12, 13,
    14, 15, 16, 17, 0, 0, 2, 0,
    0, 0, 18, 0, 19, 20, 19, 0,
    21, 0, 0, 22, 0, 0, 23, 23,
    19, 24, 20, 25, 26, 27, 28, 29,
    30, 31, 32, 33, 0, 0, 2, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 7,
    7, 7, 7, 7, 7, 34, 8, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 8, 8, 8, 8, 8, 0, 0,
    12, 12, 12, 12, 16, 0, 0, 18,
    18, 18, 18, 18, 18, 18, 19, 19,
    19, 19, 19, 0, 0, 0, 0, 0,
    23, 19, 19, 19, 19, 19, 0, 19,
    28, 28, 28, 28, 32, 0, 32, 0,
    5, 5, 0, 35, 0, 0, 35, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0
};

/*Kern values between classes*/
static const int8_t kern_class_values[] =
{
    0, 0, 0, 0, 0, 0, -22, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, -7, -7, 0, 0, 0, 0,
    -1, -9, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    18, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, -12, 0, 0,
    -30, 0, -28, -24, 0, -33, 0, 0,
    -5, -5, 0, 0, 0, 0, 0, 0,
    0, 0, -16, -14, 0, -11, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -27, 0, -17, -13, -14,
    -24, -11, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, -12,
    0, 0, 0, 0, -22, 0, 0, 0,
    0, 0, -12, -10, 0, -5, -25, -10,
    -22, -24, -5, -25, 0, 0, -9, -6,
    0, 0, 0, 0, 0, -6, -11, 0,
    -17, -14, -6, -9, 0, 0, -16, 0,
    0, 0, 0, 0, 0, -5, -2, 0,
    0, -5, 0, -4, -4, -6, -8, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -6, 0, 0, 0, -5, 0, -4, -4,
    -7, -7, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -12, 0, 0, -10, 0, -4, -4, -11,
    0, -10, -10, -15, -16, -4, 0, 0,
    0, 0, 0, 0, 0, 0, -2, 0,
    0, 0, 0, 0, 0, 0, -18, 0,
    0, 0, 0, 0, 0, 0, 0, -8,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, -5, -3, 0, 0, 0, 0,
    0, -3, 0, 0, -15, -11, -4, -9,
    0, 0, 0, 0, 0, 0, -29, 0,
    0, -18, -9, -15, -4, 0, 0, 0,
    0, 0, -5, 0, -20, -19, -17, -17,
    0, -16, -17, -14, -15, -10, -9, -14,
    -11, -17, -15, -17, -35, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -11, 0, -6, -6, 0, -10, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -11, 0, -10, -13, 0, -6, -12, -6,
    -9, -6, 0, -8, 0, -5, -11, -10,
    0, 0, 0, 0, 0, 0, -9, -7,
    -19, -13, -5, -13, 0, 0, 0, -38,
    0, 0, 0, -12, 0, -5, -14, 0,
    0, -21, -9, -21, -19, 0, -28, 0,
    0, -5, -4, 0, 0, 0, 0, 0,
    -3, 0, 0, -13, -9, 0, -10, 0,
    0, -35, 0, 0, 0, -31, 0, 0,
    -23, 0, -19, 0, -8, 0, -4, -6,
    -8, -8, -11, -4, -10, -10, -6, 0,
    0, 0, 0, -8, 0, 0, 0, 0,
    0, 0, 0, -28, 0, 0, 0, 0,
    0, 0, 0, -6, -2, 0, 0, -2,
    0, -4, -4, 0, -6, 0, 0, -8,
    -8, -6, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -6, -3,
    -2, -4, -5, 0, -7, -6, -7, -8,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, -5, 0, -7, -6, 0, -7,
    0, 0, 0, 0, 0, 0, -30, -27,
    -19, -23, -11, -18, -5, 0, 0, 0,
    0, -4, -7, 0, -22, -25, -22, -22,
    0, -19, -19, -19, -24, -9, -20, -19,
    -18, -17, -19, -18, -32, 0, 0, 0,
    0, 0, 0, 0, -10, 0, -4, 0,
    0, 0, 0, 0, -4, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, -17,
    0, 0, 0, 0, -28, -17, -10, -22,
    -10, -14, -7, 0, 0, -4, -4, -4,
    -4, 0, -15, -17, -15, -16, 0, -12,
    -12, -13, -15, 0, -12, -7, -7, -7,
    -7, -8, -32, 0, 0, 0, 0, -24,
    -13, 0, -24, -10, -14, -6, 0, 0,
    -4, -5, -4, -4, 0, -14, -16, -15,
    0, 0, -10, -12, -8, 0, 0, -11,
    -4, -4, -4, -4, -6, -32, 0, 0,
    0, 0, 0, -14, 0, -5, -15, 0,
    -9, -4, -4, -5, -5, -2, -5, 0,
    -4, -13, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -15, 0,
    0, 0, 0, 0, 0, -33, -24, -13,
    -25, -16, -17, -8, 0, 0, -4, -4,
    -2, -2, -5, -23, -25, -22, -24, 0,
    -15, -12, -11, -21, -10, -17, -14, -11,
    -15, -12, -15, -33, 0, 0, 0, 0,
    0, -11, 0, 0, -6, 0, 0, 0,
    0, 0, 0, 0, -2, 0, 0, -8,
    -8, 0, 0, 0, 0, 0, 0, -7,
    0, -8, -8, 0, -6, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 21, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, -4, 0, -4,
    -4, 0, -2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -4, 0, -6, -6, -6, -6, -4, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -1, 0, 0, 0, 0,
    0, 0, 0, -4, 0, -4, -2, -6,
    -4, -4, 0, 0, -4, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -25, 0,
    -15, -16, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -3, 0,
    -5, -4, -7, -5, -5, 0, 0, 0,
    14, 1, -9, 0, 0, -9, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, -4, -4, 0, 0, 0, 0, 0,
    -4, 0, 0, 0, 0, -1, 0, 0,
    0, 13, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -4, -6, -4, 0, 0,
    0, 0, 0, -4, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, -4,
    0, -4, -4, 0, -4, 0, 0, 0,
    0, 7, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, -12,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, -4, -8, -7, 0,
    0, 0, 0, 0, -8, -6, -4, -5,
    -5, -4, -5, 0, 0, 0, -6, 0,
    0, -5, 0, 0, 0, 0, 0, 0,
    -25, 0, -17, -16, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -4, 0, -7, -6, -9, -6, -5, 0,
    0, 2, 0, 0, -19, -11, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, -2, -4, -4, 0, 0, 0,
    0, 0, -2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -4, 0,
    -5, -4, -5, -4, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, -4, -4, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, -1, 0, 0,
    0, 5, 0, 0, 0, -16, 0, 0,
    -17, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -4, -7, -6, -4, 0,
    0, 0, 0, -5, 0, 0, -2, -2,
    -4, -2, 0, 0, 0, 0, 0, 0,
    -16, 0, 0, -14, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, -4, -6,
    -6, -4, 0, 0, 0, 0, -4, 0,
    0, -2, -2, -2, -2, 0, 0, 0,
    0, 0, 0, 0, -12, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, -5, -11, -6, 0, 0, 0, 0,
    0, -5, -7, -4, -6, -6, -4, -6,
    0, 0, 0, 0, 0, 0, -16, 0,
    0, -17, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, -4, -6, -6, -4,
    0, 0, 0, 0, -5, 0, 0, -2,
    -2, -2, -2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -5, -4, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 20, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 15, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, -19, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    -24, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, -14, -14, 0, 0,
    0, 0, -3, -12, 0, 0, -4, 0,
    0, 0, 0, 0, 0
};


/*Collect the kern class' data in one place*/
static const lv_font_fmt_txt_kern_classes_t kern_classes =
{
    .class_pair_values   = kern_class_values,
    .left_class_mapping  = kern_left_class_mapping,
    .right_class_mapping = kern_right_class_mapping,
    .left_class_cnt      = 47,
    .right_class_cnt     = 35,
};

/*--------------------
 *  ALL CUSTOM DATA
 *--------------------*/

#if LVGL_VERSION_MAJOR == 8
/*Store all the custom data of the font*/
static  lv_font_fmt_txt_glyph_cache_t cache;
#endif

#if LVGL_VERSION_MAJOR >= 8
static const lv_font_fmt_txt_dsc_t font_dsc = {
#else
static lv_font_fmt_txt_dsc_t font_dsc = {
#endif
    .glyph_bitmap = glyph_bitmap,
    .glyph_dsc = glyph_dsc,
    .cmaps = cmaps,
    .kern_dsc = &kern_classes,
    .kern_scale = 16,
    .cmap_num = 4,
    .bpp = 1,
    .kern_classes = 1,
    .bitmap_format = 0,
#if LVGL_VERSION_MAJOR == 8
    .cache = &cache
#endif
};



extern const lv_font_t ui_font_ko_label_14;

/*-----------------
 *  PUBLIC FONT
 *----------------*/

/*Initialize a public general font descriptor*/
#if LVGL_VERSION_MAJOR >= 8
const lv_font_t ui_font_label_14 = {
#else
lv_font_t ui_font_label_14 = {
#endif
    .get_glyph_dsc = lv_font_get_glyph_dsc_fmt_txt,    /*Function pointer to get glyph's data*/
    .get_glyph_bitmap = lv_font_get_bitmap_fmt_txt,    /*Function pointer to get glyph's bitmap*/
    .line_height = 18,          /*The maximum line height required by the font*/
    .base_line = 3,             /*Baseline measured from the bottom of the line*/
#if !(LVGL_VERSION_MAJOR == 6 && LVGL_VERSION_MINOR == 0)
    .subpx = LV_FONT_SUBPX_NONE,
#endif
#if LV_VERSION_CHECK(7, 4, 0) || LVGL_VERSION_MAJOR >= 8
    .underline_position = -1,
    .underline_thickness = 1,
#endif
    .dsc = &font_dsc,          /*The custom font data. Will be accessed by `get_glyph_bitmap/dsc` */
#if LV_VERSION_CHECK(8, 2, 0) || LVGL_VERSION_MAJOR >= 9
    .fallback = &ui_font_ko_label_14,
#endif
    .user_data = NULL,
};



#endif /*#if UI_FONT_LABEL_14*/

