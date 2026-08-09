// GENERATED — DO NOT EDIT.
//
// Produced by scripts/gen-languages.ts from data/scripts.json, data/languages.json,
// data/provider-matrix.json and data/matrix-overrides.json.
// Regenerate with `pnpm --filter @thibi/languages gen`. CI asserts this file matches
// its inputs, so hand-editing it fails the build rather than taking effect.
//
// Frozen at module scope: this is the reason the registry is a compiled TS object rather
// than an imported JSON file. A client component can import it, it tree-shakes, and
// nothing downstream can mutate the shared table.

import type { LanguageEntry, ProviderLanguageCapability, ProviderId, ScriptEntry } from '../types.js';

export const GENERATED_AT = "2026-08-09";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const SCRIPTS: Readonly<Record<string, ScriptEntry>> = deepFreeze(
  {
  "Arab": {
    "clusters": "codepoint",
    "code": "Arab",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "٠١٢٣٤٥٦٧٨٩",
        "۰۱۲۳۴۵۶۷۸۹"
      ]
    },
    "direction": "rtl",
    "nameEn": "Arabic",
    "typography": {
      "cssStack": "'Noto Naskh Arabic', system-ui, sans-serif",
      "fontFamily": "Noto Naskh Arabic",
      "googleFontSubset": "arabic",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        1536,
        1540
      ],
      [
        1542,
        1547
      ],
      [
        1549,
        1562
      ],
      [
        1564,
        1566
      ],
      [
        1568,
        1599
      ],
      [
        1601,
        1610
      ],
      [
        1622,
        1647
      ],
      [
        1649,
        1756
      ],
      [
        1758,
        1791
      ],
      [
        1872,
        1919
      ],
      [
        2160,
        2190
      ],
      [
        2192,
        2193
      ],
      [
        2199,
        2273
      ],
      [
        2275,
        2303
      ],
      [
        64336,
        64450
      ],
      [
        64467,
        64829
      ],
      [
        64832,
        64911
      ],
      [
        64914,
        64967
      ],
      [
        64975,
        64975
      ],
      [
        65008,
        65023
      ],
      [
        65136,
        65140
      ],
      [
        65142,
        65276
      ],
      [
        69216,
        69246
      ],
      [
        69314,
        69316
      ],
      [
        69372,
        69375
      ],
      [
        126464,
        126467
      ],
      [
        126469,
        126495
      ],
      [
        126497,
        126498
      ],
      [
        126500,
        126500
      ],
      [
        126503,
        126503
      ],
      [
        126505,
        126514
      ],
      [
        126516,
        126519
      ],
      [
        126521,
        126521
      ],
      [
        126523,
        126523
      ],
      [
        126530,
        126530
      ],
      [
        126535,
        126535
      ],
      [
        126537,
        126537
      ],
      [
        126539,
        126539
      ],
      [
        126541,
        126543
      ],
      [
        126545,
        126546
      ],
      [
        126548,
        126548
      ],
      [
        126551,
        126551
      ],
      [
        126553,
        126553
      ],
      [
        126555,
        126555
      ],
      [
        126557,
        126557
      ],
      [
        126559,
        126559
      ],
      [
        126561,
        126562
      ],
      [
        126564,
        126564
      ],
      [
        126567,
        126570
      ],
      [
        126572,
        126578
      ],
      [
        126580,
        126583
      ],
      [
        126585,
        126588
      ],
      [
        126590,
        126590
      ],
      [
        126592,
        126601
      ],
      [
        126603,
        126619
      ],
      [
        126625,
        126627
      ],
      [
        126629,
        126633
      ],
      [
        126635,
        126651
      ],
      [
        126704,
        126705
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Armn": {
    "clusters": "grapheme",
    "code": "Armn",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Armenian",
    "typography": {
      "cssStack": "'Noto Sans Armenian', system-ui, sans-serif",
      "fontFamily": "Noto Sans Armenian",
      "googleFontSubset": "armenian",
      "lineHeight": 1.6,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        1329,
        1366
      ],
      [
        1369,
        1418
      ],
      [
        1421,
        1423
      ],
      [
        64275,
        64279
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Beng": {
    "clusters": "grapheme",
    "code": "Beng",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "০১২৩৪৫৬৭৮৯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Bengali",
    "typography": {
      "cssStack": "'Noto Sans Bengali', system-ui, sans-serif",
      "fontFamily": "Noto Sans Bengali",
      "googleFontSubset": "bengali",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2432,
        2435
      ],
      [
        2437,
        2444
      ],
      [
        2447,
        2448
      ],
      [
        2451,
        2472
      ],
      [
        2474,
        2480
      ],
      [
        2482,
        2482
      ],
      [
        2486,
        2489
      ],
      [
        2492,
        2500
      ],
      [
        2503,
        2504
      ],
      [
        2507,
        2510
      ],
      [
        2519,
        2519
      ],
      [
        2524,
        2525
      ],
      [
        2527,
        2531
      ],
      [
        2534,
        2558
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Cyrl": {
    "clusters": "grapheme",
    "code": "Cyrl",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Cyrillic",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": "cyrillic",
      "lineHeight": 1.5,
      "minFontPx": 14
    },
    "unicodeRanges": [
      [
        1024,
        1156
      ],
      [
        1159,
        1327
      ],
      [
        7296,
        7306
      ],
      [
        7467,
        7467
      ],
      [
        7544,
        7544
      ],
      [
        11744,
        11775
      ],
      [
        42560,
        42655
      ],
      [
        65070,
        65071
      ],
      [
        122928,
        122989
      ],
      [
        123023,
        123023
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Deva": {
    "clusters": "grapheme",
    "code": "Deva",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "०१२३४५६७८९"
      ]
    },
    "direction": "ltr",
    "nameEn": "Devanagari",
    "typography": {
      "cssStack": "'Noto Sans Devanagari', system-ui, sans-serif",
      "fontFamily": "Noto Sans Devanagari",
      "googleFontSubset": "devanagari",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2304,
        2384
      ],
      [
        2389,
        2403
      ],
      [
        2406,
        2431
      ],
      [
        43232,
        43263
      ],
      [
        72448,
        72457
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Ethi": {
    "clusters": "grapheme",
    "code": "Ethi",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Ethiopic",
    "typography": {
      "cssStack": "'Noto Sans Ethiopic', system-ui, sans-serif",
      "fontFamily": "Noto Sans Ethiopic",
      "googleFontSubset": "ethiopic",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        4608,
        4680
      ],
      [
        4682,
        4685
      ],
      [
        4688,
        4694
      ],
      [
        4696,
        4696
      ],
      [
        4698,
        4701
      ],
      [
        4704,
        4744
      ],
      [
        4746,
        4749
      ],
      [
        4752,
        4784
      ],
      [
        4786,
        4789
      ],
      [
        4792,
        4798
      ],
      [
        4800,
        4800
      ],
      [
        4802,
        4805
      ],
      [
        4808,
        4822
      ],
      [
        4824,
        4880
      ],
      [
        4882,
        4885
      ],
      [
        4888,
        4954
      ],
      [
        4957,
        4988
      ],
      [
        4992,
        5017
      ],
      [
        11648,
        11670
      ],
      [
        11680,
        11686
      ],
      [
        11688,
        11694
      ],
      [
        11696,
        11702
      ],
      [
        11704,
        11710
      ],
      [
        11712,
        11718
      ],
      [
        11720,
        11726
      ],
      [
        11728,
        11734
      ],
      [
        11736,
        11742
      ],
      [
        43777,
        43782
      ],
      [
        43785,
        43790
      ],
      [
        43793,
        43798
      ],
      [
        43808,
        43814
      ],
      [
        43816,
        43822
      ],
      [
        124896,
        124902
      ],
      [
        124904,
        124907
      ],
      [
        124909,
        124910
      ],
      [
        124912,
        124926
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Geor": {
    "clusters": "grapheme",
    "code": "Geor",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Georgian",
    "typography": {
      "cssStack": "'Noto Sans Georgian', system-ui, sans-serif",
      "fontFamily": "Noto Sans Georgian",
      "googleFontSubset": "georgian",
      "lineHeight": 1.6,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        4256,
        4293
      ],
      [
        4295,
        4295
      ],
      [
        4301,
        4301
      ],
      [
        4304,
        4346
      ],
      [
        4348,
        4351
      ],
      [
        7312,
        7354
      ],
      [
        7357,
        7359
      ],
      [
        11520,
        11557
      ],
      [
        11559,
        11559
      ],
      [
        11565,
        11565
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Grek": {
    "clusters": "grapheme",
    "code": "Grek",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Greek",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": "greek",
      "lineHeight": 1.5,
      "minFontPx": 14
    },
    "unicodeRanges": [
      [
        880,
        883
      ],
      [
        885,
        887
      ],
      [
        890,
        893
      ],
      [
        895,
        895
      ],
      [
        900,
        900
      ],
      [
        902,
        902
      ],
      [
        904,
        906
      ],
      [
        908,
        908
      ],
      [
        910,
        929
      ],
      [
        931,
        993
      ],
      [
        1008,
        1023
      ],
      [
        7462,
        7466
      ],
      [
        7517,
        7521
      ],
      [
        7526,
        7530
      ],
      [
        7615,
        7615
      ],
      [
        7936,
        7957
      ],
      [
        7960,
        7965
      ],
      [
        7968,
        8005
      ],
      [
        8008,
        8013
      ],
      [
        8016,
        8023
      ],
      [
        8025,
        8025
      ],
      [
        8027,
        8027
      ],
      [
        8029,
        8029
      ],
      [
        8031,
        8061
      ],
      [
        8064,
        8116
      ],
      [
        8118,
        8132
      ],
      [
        8134,
        8147
      ],
      [
        8150,
        8155
      ],
      [
        8157,
        8175
      ],
      [
        8178,
        8180
      ],
      [
        8182,
        8190
      ],
      [
        8486,
        8486
      ],
      [
        43877,
        43877
      ],
      [
        65856,
        65934
      ],
      [
        65952,
        65952
      ],
      [
        119296,
        119365
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Gujr": {
    "clusters": "grapheme",
    "code": "Gujr",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "૦૧૨૩૪૫૬૭૮૯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Gujarati",
    "typography": {
      "cssStack": "'Noto Sans Gujarati', system-ui, sans-serif",
      "fontFamily": "Noto Sans Gujarati",
      "googleFontSubset": "gujarati",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2689,
        2691
      ],
      [
        2693,
        2701
      ],
      [
        2703,
        2705
      ],
      [
        2707,
        2728
      ],
      [
        2730,
        2736
      ],
      [
        2738,
        2739
      ],
      [
        2741,
        2745
      ],
      [
        2748,
        2757
      ],
      [
        2759,
        2761
      ],
      [
        2763,
        2765
      ],
      [
        2768,
        2768
      ],
      [
        2784,
        2787
      ],
      [
        2790,
        2801
      ],
      [
        2809,
        2815
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Guru": {
    "clusters": "grapheme",
    "code": "Guru",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "੦੧੨੩੪੫੬੭੮੯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Gurmukhi",
    "typography": {
      "cssStack": "'Noto Sans Gurmukhi', system-ui, sans-serif",
      "fontFamily": "Noto Sans Gurmukhi",
      "googleFontSubset": "gurmukhi",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2561,
        2563
      ],
      [
        2565,
        2570
      ],
      [
        2575,
        2576
      ],
      [
        2579,
        2600
      ],
      [
        2602,
        2608
      ],
      [
        2610,
        2611
      ],
      [
        2613,
        2614
      ],
      [
        2616,
        2617
      ],
      [
        2620,
        2620
      ],
      [
        2622,
        2626
      ],
      [
        2631,
        2632
      ],
      [
        2635,
        2637
      ],
      [
        2641,
        2641
      ],
      [
        2649,
        2652
      ],
      [
        2654,
        2654
      ],
      [
        2662,
        2678
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Hang": {
    "clusters": "grapheme",
    "code": "Hang",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Hangul",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": null,
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        4352,
        4607
      ],
      [
        11904,
        11929
      ],
      [
        11931,
        12019
      ],
      [
        12032,
        12245
      ],
      [
        12293,
        12293
      ],
      [
        12295,
        12295
      ],
      [
        12321,
        12329
      ],
      [
        12334,
        12335
      ],
      [
        12344,
        12347
      ],
      [
        12593,
        12686
      ],
      [
        12800,
        12830
      ],
      [
        12896,
        12926
      ],
      [
        13312,
        19903
      ],
      [
        19968,
        40959
      ],
      [
        43360,
        43388
      ],
      [
        44032,
        55203
      ],
      [
        55216,
        55238
      ],
      [
        55243,
        55291
      ],
      [
        63744,
        64109
      ],
      [
        64112,
        64217
      ],
      [
        65440,
        65470
      ],
      [
        65474,
        65479
      ],
      [
        65482,
        65487
      ],
      [
        65490,
        65495
      ],
      [
        65498,
        65500
      ],
      [
        94178,
        94179
      ],
      [
        94192,
        94193
      ],
      [
        131072,
        173791
      ],
      [
        173824,
        177977
      ],
      [
        177984,
        178205
      ],
      [
        178208,
        183969
      ],
      [
        183984,
        191456
      ],
      [
        191472,
        192093
      ],
      [
        194560,
        195101
      ],
      [
        196608,
        201546
      ],
      [
        201552,
        205743
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Hani": {
    "clusters": "grapheme",
    "code": "Hani",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Han",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": null,
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        11904,
        11929
      ],
      [
        11931,
        12019
      ],
      [
        12032,
        12245
      ],
      [
        12293,
        12293
      ],
      [
        12295,
        12295
      ],
      [
        12321,
        12329
      ],
      [
        12344,
        12347
      ],
      [
        13312,
        19903
      ],
      [
        19968,
        40959
      ],
      [
        63744,
        64109
      ],
      [
        64112,
        64217
      ],
      [
        94178,
        94179
      ],
      [
        94192,
        94193
      ],
      [
        131072,
        173791
      ],
      [
        173824,
        177977
      ],
      [
        177984,
        178205
      ],
      [
        178208,
        183969
      ],
      [
        183984,
        191456
      ],
      [
        191472,
        192093
      ],
      [
        194560,
        195101
      ],
      [
        196608,
        201546
      ],
      [
        201552,
        205743
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Hebr": {
    "clusters": "codepoint",
    "code": "Hebr",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "rtl",
    "nameEn": "Hebrew",
    "typography": {
      "cssStack": "'Noto Sans Hebrew', system-ui, sans-serif",
      "fontFamily": "Noto Sans Hebrew",
      "googleFontSubset": "hebrew",
      "lineHeight": 1.6,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        1425,
        1479
      ],
      [
        1488,
        1514
      ],
      [
        1519,
        1524
      ],
      [
        64285,
        64310
      ],
      [
        64312,
        64316
      ],
      [
        64318,
        64318
      ],
      [
        64320,
        64321
      ],
      [
        64323,
        64324
      ],
      [
        64326,
        64335
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Jpan": {
    "clusters": "grapheme",
    "code": "Jpan",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Japanese",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": null,
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        11904,
        11929
      ],
      [
        11931,
        12019
      ],
      [
        12032,
        12245
      ],
      [
        12293,
        12293
      ],
      [
        12295,
        12295
      ],
      [
        12321,
        12329
      ],
      [
        12344,
        12347
      ],
      [
        12353,
        12438
      ],
      [
        12445,
        12447
      ],
      [
        12449,
        12538
      ],
      [
        12541,
        12543
      ],
      [
        12784,
        12799
      ],
      [
        13008,
        13054
      ],
      [
        13056,
        13143
      ],
      [
        13312,
        19903
      ],
      [
        19968,
        40959
      ],
      [
        63744,
        64109
      ],
      [
        64112,
        64217
      ],
      [
        65382,
        65391
      ],
      [
        65393,
        65437
      ],
      [
        94178,
        94179
      ],
      [
        94192,
        94193
      ],
      [
        110576,
        110579
      ],
      [
        110581,
        110587
      ],
      [
        110589,
        110590
      ],
      [
        110592,
        110882
      ],
      [
        110898,
        110898
      ],
      [
        110928,
        110930
      ],
      [
        110933,
        110933
      ],
      [
        110948,
        110951
      ],
      [
        127488,
        127488
      ],
      [
        131072,
        173791
      ],
      [
        173824,
        177977
      ],
      [
        177984,
        178205
      ],
      [
        178208,
        183969
      ],
      [
        183984,
        191456
      ],
      [
        191472,
        192093
      ],
      [
        194560,
        195101
      ],
      [
        196608,
        201546
      ],
      [
        201552,
        205743
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Khmr": {
    "clusters": "grapheme",
    "code": "Khmr",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "០១២៣៤៥៦៧៨៩"
      ]
    },
    "direction": "ltr",
    "nameEn": "Khmer",
    "typography": {
      "cssStack": "'Noto Sans Khmer', system-ui, sans-serif",
      "fontFamily": "Noto Sans Khmer",
      "googleFontSubset": "khmer",
      "lineHeight": 1.9,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        6016,
        6109
      ],
      [
        6112,
        6121
      ],
      [
        6128,
        6137
      ],
      [
        6624,
        6655
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Knda": {
    "clusters": "grapheme",
    "code": "Knda",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "೦೧೨೩೪೫೬೭೮೯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Kannada",
    "typography": {
      "cssStack": "'Noto Sans Kannada', system-ui, sans-serif",
      "fontFamily": "Noto Sans Kannada",
      "googleFontSubset": "kannada",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3200,
        3212
      ],
      [
        3214,
        3216
      ],
      [
        3218,
        3240
      ],
      [
        3242,
        3251
      ],
      [
        3253,
        3257
      ],
      [
        3260,
        3268
      ],
      [
        3270,
        3272
      ],
      [
        3274,
        3277
      ],
      [
        3285,
        3286
      ],
      [
        3293,
        3294
      ],
      [
        3296,
        3299
      ],
      [
        3302,
        3311
      ],
      [
        3313,
        3315
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Laoo": {
    "clusters": "grapheme",
    "code": "Laoo",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "໐໑໒໓໔໕໖໗໘໙"
      ]
    },
    "direction": "ltr",
    "nameEn": "Lao",
    "typography": {
      "cssStack": "'Noto Sans Lao', system-ui, sans-serif",
      "fontFamily": "Noto Sans Lao",
      "googleFontSubset": "lao",
      "lineHeight": 1.8,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3713,
        3714
      ],
      [
        3716,
        3716
      ],
      [
        3718,
        3722
      ],
      [
        3724,
        3747
      ],
      [
        3749,
        3749
      ],
      [
        3751,
        3773
      ],
      [
        3776,
        3780
      ],
      [
        3782,
        3782
      ],
      [
        3784,
        3790
      ],
      [
        3792,
        3801
      ],
      [
        3804,
        3807
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Latn": {
    "clusters": "grapheme",
    "code": "Latn",
    "complex": false,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Latin",
    "typography": {
      "cssStack": "system-ui, sans-serif",
      "fontFamily": null,
      "googleFontSubset": "latin",
      "lineHeight": 1.5,
      "minFontPx": 14
    },
    "unicodeRanges": [
      [
        65,
        90
      ],
      [
        97,
        122
      ],
      [
        170,
        170
      ],
      [
        186,
        186
      ],
      [
        192,
        214
      ],
      [
        216,
        246
      ],
      [
        248,
        696
      ],
      [
        736,
        740
      ],
      [
        7424,
        7461
      ],
      [
        7468,
        7516
      ],
      [
        7522,
        7525
      ],
      [
        7531,
        7543
      ],
      [
        7545,
        7614
      ],
      [
        7680,
        7935
      ],
      [
        8305,
        8305
      ],
      [
        8319,
        8319
      ],
      [
        8336,
        8348
      ],
      [
        8490,
        8491
      ],
      [
        8498,
        8498
      ],
      [
        8526,
        8526
      ],
      [
        8544,
        8584
      ],
      [
        11360,
        11391
      ],
      [
        42786,
        42887
      ],
      [
        42891,
        42957
      ],
      [
        42960,
        42961
      ],
      [
        42963,
        42963
      ],
      [
        42965,
        42972
      ],
      [
        42994,
        43007
      ],
      [
        43824,
        43866
      ],
      [
        43868,
        43876
      ],
      [
        43878,
        43881
      ],
      [
        64256,
        64262
      ],
      [
        65313,
        65338
      ],
      [
        65345,
        65370
      ],
      [
        67456,
        67461
      ],
      [
        67463,
        67504
      ],
      [
        67506,
        67514
      ],
      [
        122624,
        122654
      ],
      [
        122661,
        122666
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Mlym": {
    "clusters": "grapheme",
    "code": "Mlym",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "൦൧൨൩൪൫൬൭൮൯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Malayalam",
    "typography": {
      "cssStack": "'Noto Sans Malayalam', system-ui, sans-serif",
      "fontFamily": "Noto Sans Malayalam",
      "googleFontSubset": "malayalam",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3328,
        3340
      ],
      [
        3342,
        3344
      ],
      [
        3346,
        3396
      ],
      [
        3398,
        3400
      ],
      [
        3402,
        3407
      ],
      [
        3412,
        3427
      ],
      [
        3430,
        3455
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Mymr": {
    "clusters": "grapheme",
    "code": "Mymr",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "၀၁၂၃၄၅၆၇၈၉"
      ]
    },
    "direction": "ltr",
    "nameEn": "Myanmar",
    "typography": {
      "cssStack": "'Noto Sans Myanmar', system-ui, sans-serif",
      "fontFamily": "Noto Sans Myanmar",
      "googleFontSubset": "myanmar",
      "lineHeight": 1.9,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        4096,
        4255
      ],
      [
        43488,
        43518
      ],
      [
        43616,
        43647
      ],
      [
        71376,
        71395
      ]
    ],
    "zeroWidth": {
      "zwj": "strip",
      "zwnj": "strip",
      "zwsp": "strip"
    }
  },
  "Orya": {
    "clusters": "grapheme",
    "code": "Orya",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "୦୧୨୩୪୫୬୭୮୯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Odia",
    "typography": {
      "cssStack": "'Noto Sans Oriya', system-ui, sans-serif",
      "fontFamily": "Noto Sans Oriya",
      "googleFontSubset": "oriya",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2817,
        2819
      ],
      [
        2821,
        2828
      ],
      [
        2831,
        2832
      ],
      [
        2835,
        2856
      ],
      [
        2858,
        2864
      ],
      [
        2866,
        2867
      ],
      [
        2869,
        2873
      ],
      [
        2876,
        2884
      ],
      [
        2887,
        2888
      ],
      [
        2891,
        2893
      ],
      [
        2901,
        2903
      ],
      [
        2908,
        2909
      ],
      [
        2911,
        2915
      ],
      [
        2918,
        2935
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Sinh": {
    "clusters": "grapheme",
    "code": "Sinh",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "ltr",
    "nameEn": "Sinhala",
    "typography": {
      "cssStack": "'Noto Sans Sinhala', system-ui, sans-serif",
      "fontFamily": "Noto Sans Sinhala",
      "googleFontSubset": "sinhala",
      "lineHeight": 1.9,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3457,
        3459
      ],
      [
        3461,
        3478
      ],
      [
        3482,
        3505
      ],
      [
        3507,
        3515
      ],
      [
        3517,
        3517
      ],
      [
        3520,
        3526
      ],
      [
        3530,
        3530
      ],
      [
        3535,
        3540
      ],
      [
        3542,
        3542
      ],
      [
        3544,
        3551
      ],
      [
        3558,
        3567
      ],
      [
        3570,
        3572
      ],
      [
        70113,
        70132
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Taml": {
    "clusters": "grapheme",
    "code": "Taml",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "௦௧௨௩௪௫௬௭௮௯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Tamil",
    "typography": {
      "cssStack": "'Noto Sans Tamil', system-ui, sans-serif",
      "fontFamily": "Noto Sans Tamil",
      "googleFontSubset": "tamil",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        2946,
        2947
      ],
      [
        2949,
        2954
      ],
      [
        2958,
        2960
      ],
      [
        2962,
        2965
      ],
      [
        2969,
        2970
      ],
      [
        2972,
        2972
      ],
      [
        2974,
        2975
      ],
      [
        2979,
        2980
      ],
      [
        2984,
        2986
      ],
      [
        2990,
        3001
      ],
      [
        3006,
        3010
      ],
      [
        3014,
        3016
      ],
      [
        3018,
        3021
      ],
      [
        3024,
        3024
      ],
      [
        3031,
        3031
      ],
      [
        3046,
        3066
      ],
      [
        73664,
        73713
      ],
      [
        73727,
        73727
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Telu": {
    "clusters": "grapheme",
    "code": "Telu",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "౦౧౨౩౪౫౬౭౮౯"
      ]
    },
    "direction": "ltr",
    "nameEn": "Telugu",
    "typography": {
      "cssStack": "'Noto Sans Telugu', system-ui, sans-serif",
      "fontFamily": "Noto Sans Telugu",
      "googleFontSubset": "telugu",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3072,
        3084
      ],
      [
        3086,
        3088
      ],
      [
        3090,
        3112
      ],
      [
        3114,
        3129
      ],
      [
        3132,
        3140
      ],
      [
        3142,
        3144
      ],
      [
        3146,
        3149
      ],
      [
        3157,
        3158
      ],
      [
        3160,
        3162
      ],
      [
        3165,
        3165
      ],
      [
        3168,
        3171
      ],
      [
        3174,
        3183
      ],
      [
        3191,
        3199
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Thaa": {
    "clusters": "codepoint",
    "code": "Thaa",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": []
    },
    "direction": "rtl",
    "nameEn": "Thaana",
    "typography": {
      "cssStack": "'Noto Sans Thaana', system-ui, sans-serif",
      "fontFamily": "Noto Sans Thaana",
      "googleFontSubset": "thaana",
      "lineHeight": 1.7,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        1920,
        1969
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  },
  "Thai": {
    "clusters": "grapheme",
    "code": "Thai",
    "complex": true,
    "digits": {
      "foldToLatin": false,
      "native": [
        "๐๑๒๓๔๕๖๗๘๙"
      ]
    },
    "direction": "ltr",
    "nameEn": "Thai",
    "typography": {
      "cssStack": "'Noto Sans Thai', system-ui, sans-serif",
      "fontFamily": "Noto Sans Thai",
      "googleFontSubset": "thai",
      "lineHeight": 1.8,
      "minFontPx": 15
    },
    "unicodeRanges": [
      [
        3585,
        3642
      ],
      [
        3648,
        3675
      ]
    ],
    "zeroWidth": {
      "zwj": "keep",
      "zwnj": "keep",
      "zwsp": "strip"
    }
  }
} as Record<string, ScriptEntry>,
);

export const LANGUAGES: Readonly<Record<string, LanguageEntry>> = deepFreeze(
  {
  "af-ZA": {
    "altNames": [],
    "altScripts": [],
    "code": "af-ZA",
    "endonym": "Afrikaans",
    "fleurs": {
      "config": "af_za"
    },
    "iso639_1": "af",
    "iso639_3": "afr",
    "nameEn": "Afrikaans",
    "region": "ZA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "am-ET": {
    "altNames": [],
    "altScripts": [],
    "code": "am-ET",
    "endonym": "አማርኛ",
    "fleurs": {
      "config": "am_et"
    },
    "iso639_1": "am",
    "iso639_3": "amh",
    "nameEn": "Amharic",
    "region": "ET",
    "script": "Ethi",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          "።",
          "፣",
          "፧"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "ar-EG": {
    "altNames": [],
    "altScripts": [],
    "code": "ar-EG",
    "endonym": "العربية",
    "fleurs": {
      "config": "ar_eg"
    },
    "iso639_1": "ar",
    "iso639_3": "ara",
    "nameEn": "Arabic",
    "region": "EG",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "as-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "as-IN",
    "endonym": "অসমীয়া",
    "fleurs": {
      "config": "as_in"
    },
    "iso639_1": "as",
    "iso639_3": "asm",
    "nameEn": "Assamese",
    "region": "IN",
    "script": "Beng",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "ast-ES": {
    "altNames": [],
    "altScripts": [],
    "code": "ast-ES",
    "endonym": "asturianu",
    "fleurs": {
      "config": "ast_es"
    },
    "iso639_1": null,
    "iso639_3": "ast",
    "nameEn": "Asturian",
    "region": "ES",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "az-AZ": {
    "altNames": [],
    "altScripts": [],
    "code": "az-AZ",
    "endonym": "azərbaycan",
    "fleurs": {
      "config": "az_az"
    },
    "iso639_1": "az",
    "iso639_3": "aze",
    "nameEn": "Azerbaijani",
    "region": "AZ",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "be-BY": {
    "altNames": [],
    "altScripts": [],
    "code": "be-BY",
    "endonym": "беларуская",
    "fleurs": {
      "config": "be_by"
    },
    "iso639_1": "be",
    "iso639_3": "bel",
    "nameEn": "Belarusian",
    "region": "BY",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "bg-BG": {
    "altNames": [],
    "altScripts": [],
    "code": "bg-BG",
    "endonym": "български",
    "fleurs": {
      "config": "bg_bg"
    },
    "iso639_1": "bg",
    "iso639_3": "bul",
    "nameEn": "Bulgarian",
    "region": "BG",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "bn-BD": {
    "altNames": [],
    "altScripts": [],
    "code": "bn-BD",
    "endonym": "বাংলা",
    "fleurs": {
      "config": null
    },
    "iso639_1": "bn",
    "iso639_3": "ben",
    "nameEn": "Bangla (Bangladesh)",
    "region": "BD",
    "script": "Beng",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "bn-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "bn-IN",
    "endonym": "বাংলা",
    "fleurs": {
      "config": "bn_in"
    },
    "iso639_1": "bn",
    "iso639_3": "ben",
    "nameEn": "Bangla (India)",
    "region": "IN",
    "script": "Beng",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "bs-BA": {
    "altNames": [],
    "altScripts": [],
    "code": "bs-BA",
    "endonym": "bosanski",
    "fleurs": {
      "config": "bs_ba"
    },
    "iso639_1": "bs",
    "iso639_3": "bos",
    "nameEn": "Bosnian",
    "region": "BA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ca-ES": {
    "altNames": [],
    "altScripts": [],
    "code": "ca-ES",
    "endonym": "català",
    "fleurs": {
      "config": "ca_es"
    },
    "iso639_1": "ca",
    "iso639_3": "cat",
    "nameEn": "Catalan",
    "region": "ES",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ceb-PH": {
    "altNames": [],
    "altScripts": [],
    "code": "ceb-PH",
    "endonym": "Cebuano",
    "fleurs": {
      "config": "ceb_ph"
    },
    "iso639_1": null,
    "iso639_3": "ceb",
    "nameEn": "Cebuano",
    "region": "PH",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "ckb-IQ": {
    "altNames": [
      "Sorani",
      "Sorani Kurdish",
      "Kurdish (Sorani)"
    ],
    "altScripts": [],
    "code": "ckb-IQ",
    "endonym": "کوردیی ناوەندی",
    "fleurs": {
      "config": "ckb_iq"
    },
    "iso639_1": null,
    "iso639_3": "ckb",
    "nameEn": "Central Kurdish",
    "region": "IQ",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "rtl"
  },
  "cmn-Hans-CN": {
    "altNames": [
      "zh",
      "zh-CN",
      "zh-Hans",
      "Chinese",
      "Mandarin",
      "Simplified Chinese"
    ],
    "altScripts": [],
    "code": "cmn-Hans-CN",
    "endonym": "普通话",
    "fleurs": {
      "config": "cmn_hans_cn"
    },
    "iso639_1": null,
    "iso639_3": "cmn",
    "nameEn": "Mandarin Chinese (China)",
    "region": "CN",
    "script": "Hani",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "grapheme",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "「",
          "」"
        ],
        "sentenceEnders": [
          "。",
          "！",
          "？"
        ]
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "skip"
  },
  "cmn-Hant-TW": {
    "altNames": [
      "zh-TW",
      "zh-Hant",
      "Traditional Chinese"
    ],
    "altScripts": [],
    "code": "cmn-Hant-TW",
    "endonym": "普通话",
    "fleurs": {
      "config": null
    },
    "iso639_1": null,
    "iso639_3": "cmn",
    "nameEn": "Mandarin Chinese (Taiwan)",
    "region": "TW",
    "script": "Hani",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "grapheme",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "「",
          "」"
        ],
        "sentenceEnders": [
          "。",
          "！",
          "？"
        ]
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "skip"
  },
  "cs-CZ": {
    "altNames": [],
    "altScripts": [],
    "code": "cs-CZ",
    "endonym": "čeština",
    "fleurs": {
      "config": "cs_cz"
    },
    "iso639_1": "cs",
    "iso639_3": "ces",
    "nameEn": "Czech",
    "region": "CZ",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "cy-GB": {
    "altNames": [],
    "altScripts": [],
    "code": "cy-GB",
    "endonym": "Cymraeg",
    "fleurs": {
      "config": "cy_gb"
    },
    "iso639_1": "cy",
    "iso639_3": "cym",
    "nameEn": "Welsh",
    "region": "GB",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "da-DK": {
    "altNames": [],
    "altScripts": [],
    "code": "da-DK",
    "endonym": "dansk",
    "fleurs": {
      "config": "da_dk"
    },
    "iso639_1": "da",
    "iso639_3": "dan",
    "nameEn": "Danish",
    "region": "DK",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "de-DE": {
    "altNames": [],
    "altScripts": [],
    "code": "de-DE",
    "endonym": "Deutsch",
    "fleurs": {
      "config": "de_de"
    },
    "iso639_1": "de",
    "iso639_3": "deu",
    "nameEn": "German",
    "region": "DE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "„",
          "“"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "el-GR": {
    "altNames": [],
    "altScripts": [],
    "code": "el-GR",
    "endonym": "Ελληνικά",
    "fleurs": {
      "config": "el_gr"
    },
    "iso639_1": "el",
    "iso639_3": "ell",
    "nameEn": "Greek",
    "region": "GR",
    "script": "Grek",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "·",
          ";"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "en-AU": {
    "altNames": [],
    "altScripts": [],
    "code": "en-AU",
    "endonym": "English",
    "fleurs": {
      "config": null
    },
    "iso639_1": "en",
    "iso639_3": "eng",
    "nameEn": "English (Australia)",
    "region": "AU",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "en-GB": {
    "altNames": [],
    "altScripts": [],
    "code": "en-GB",
    "endonym": "English",
    "fleurs": {
      "config": null
    },
    "iso639_1": "en",
    "iso639_3": "eng",
    "nameEn": "English (United Kingdom)",
    "region": "GB",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "en-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "en-IN",
    "endonym": "English",
    "fleurs": {
      "config": null
    },
    "iso639_1": "en",
    "iso639_3": "eng",
    "nameEn": "English (India)",
    "region": "IN",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "en-US": {
    "altNames": [],
    "altScripts": [],
    "code": "en-US",
    "endonym": "English",
    "fleurs": {
      "config": "en_us"
    },
    "iso639_1": "en",
    "iso639_3": "eng",
    "nameEn": "English (United States)",
    "region": "US",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "es-419": {
    "altNames": [],
    "altScripts": [],
    "code": "es-419",
    "endonym": "español",
    "fleurs": {
      "config": "es_419"
    },
    "iso639_1": "es",
    "iso639_3": "spa",
    "nameEn": "Spanish (Latin America)",
    "region": "419",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "es-ES": {
    "altNames": [],
    "altScripts": [],
    "code": "es-ES",
    "endonym": "español",
    "fleurs": {
      "config": null
    },
    "iso639_1": "es",
    "iso639_3": "spa",
    "nameEn": "Spanish (Spain)",
    "region": "ES",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "es-US": {
    "altNames": [],
    "altScripts": [],
    "code": "es-US",
    "endonym": "español",
    "fleurs": {
      "config": null
    },
    "iso639_1": "es",
    "iso639_3": "spa",
    "nameEn": "Spanish (United States)",
    "region": "US",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "et-EE": {
    "altNames": [],
    "altScripts": [],
    "code": "et-EE",
    "endonym": "eesti",
    "fleurs": {
      "config": "et_ee"
    },
    "iso639_1": "et",
    "iso639_3": "est",
    "nameEn": "Estonian",
    "region": "EE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "eu-ES": {
    "altNames": [],
    "altScripts": [],
    "code": "eu-ES",
    "endonym": "euskara",
    "fleurs": {
      "config": null
    },
    "iso639_1": "eu",
    "iso639_3": "eus",
    "nameEn": "Basque",
    "region": "ES",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "fa-IR": {
    "altNames": [],
    "altScripts": [],
    "code": "fa-IR",
    "endonym": "فارسی",
    "fleurs": {
      "config": "fa_ir"
    },
    "iso639_1": "fa",
    "iso639_3": "fas",
    "nameEn": "Persian",
    "region": "IR",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ff-SN": {
    "altNames": [
      "Fulah",
      "Fulfulde",
      "Pulaar"
    ],
    "altScripts": [],
    "code": "ff-SN",
    "endonym": "Pulaar",
    "fleurs": {
      "config": "ff_sn"
    },
    "iso639_1": "ff",
    "iso639_3": "ful",
    "nameEn": "Fula",
    "region": "SN",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "fi-FI": {
    "altNames": [],
    "altScripts": [],
    "code": "fi-FI",
    "endonym": "suomi",
    "fleurs": {
      "config": "fi_fi"
    },
    "iso639_1": "fi",
    "iso639_3": "fin",
    "nameEn": "Finnish",
    "region": "FI",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "fil-PH": {
    "altNames": [
      "tl",
      "tgl",
      "Tagalog"
    ],
    "altScripts": [],
    "code": "fil-PH",
    "endonym": "Filipino",
    "fleurs": {
      "config": "fil_ph"
    },
    "iso639_1": null,
    "iso639_3": "fil",
    "nameEn": "Filipino",
    "region": "PH",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "fr-CA": {
    "altNames": [],
    "altScripts": [],
    "code": "fr-CA",
    "endonym": "français",
    "fleurs": {
      "config": null
    },
    "iso639_1": "fr",
    "iso639_3": "fra",
    "nameEn": "French (Canada)",
    "region": "CA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "fr-FR": {
    "altNames": [],
    "altScripts": [],
    "code": "fr-FR",
    "endonym": "français",
    "fleurs": {
      "config": "fr_fr"
    },
    "iso639_1": "fr",
    "iso639_3": "fra",
    "nameEn": "French (France)",
    "region": "FR",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ga-IE": {
    "altNames": [],
    "altScripts": [],
    "code": "ga-IE",
    "endonym": "Gaeilge",
    "fleurs": {
      "config": "ga_ie"
    },
    "iso639_1": "ga",
    "iso639_3": "gle",
    "nameEn": "Irish",
    "region": "IE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "gl-ES": {
    "altNames": [],
    "altScripts": [],
    "code": "gl-ES",
    "endonym": "galego",
    "fleurs": {
      "config": "gl_es"
    },
    "iso639_1": "gl",
    "iso639_3": "glg",
    "nameEn": "Galician",
    "region": "ES",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "gu-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "gu-IN",
    "endonym": "ગુજરાતી",
    "fleurs": {
      "config": "gu_in"
    },
    "iso639_1": "gu",
    "iso639_3": "guj",
    "nameEn": "Gujarati",
    "region": "IN",
    "script": "Gujr",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ha-NG": {
    "altNames": [],
    "altScripts": [],
    "code": "ha-NG",
    "endonym": "Hausa",
    "fleurs": {
      "config": "ha_ng"
    },
    "iso639_1": "ha",
    "iso639_3": "hau",
    "nameEn": "Hausa",
    "region": "NG",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "he-IL": {
    "altNames": [
      "iw"
    ],
    "altScripts": [],
    "code": "he-IL",
    "endonym": "עברית",
    "fleurs": {
      "config": "he_il"
    },
    "iso639_1": "he",
    "iso639_3": "heb",
    "nameEn": "Hebrew",
    "region": "IL",
    "script": "Hebr",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "?",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "hi-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "hi-IN",
    "endonym": "हिन्दी",
    "fleurs": {
      "config": "hi_in"
    },
    "iso639_1": "hi",
    "iso639_3": "hin",
    "nameEn": "Hindi",
    "region": "IN",
    "script": "Deva",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "hr-HR": {
    "altNames": [],
    "altScripts": [],
    "code": "hr-HR",
    "endonym": "hrvatski",
    "fleurs": {
      "config": "hr_hr"
    },
    "iso639_1": "hr",
    "iso639_3": "hrv",
    "nameEn": "Croatian",
    "region": "HR",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "hu-HU": {
    "altNames": [],
    "altScripts": [],
    "code": "hu-HU",
    "endonym": "magyar",
    "fleurs": {
      "config": "hu_hu"
    },
    "iso639_1": "hu",
    "iso639_3": "hun",
    "nameEn": "Hungarian",
    "region": "HU",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "hy-AM": {
    "altNames": [],
    "altScripts": [],
    "code": "hy-AM",
    "endonym": "հայերեն",
    "fleurs": {
      "config": "hy_am"
    },
    "iso639_1": "hy",
    "iso639_3": "hye",
    "nameEn": "Armenian",
    "region": "AM",
    "script": "Armn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          "։",
          "՞",
          "՜"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "id-ID": {
    "altNames": [
      "in"
    ],
    "altScripts": [],
    "code": "id-ID",
    "endonym": "Indonesia",
    "fleurs": {
      "config": "id_id"
    },
    "iso639_1": "id",
    "iso639_3": "ind",
    "nameEn": "Indonesian",
    "region": "ID",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ig-NG": {
    "altNames": [],
    "altScripts": [],
    "code": "ig-NG",
    "endonym": "Igbo",
    "fleurs": {
      "config": "ig_ng"
    },
    "iso639_1": "ig",
    "iso639_3": "ibo",
    "nameEn": "Igbo",
    "region": "NG",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "is-IS": {
    "altNames": [],
    "altScripts": [],
    "code": "is-IS",
    "endonym": "íslenska",
    "fleurs": {
      "config": "is_is"
    },
    "iso639_1": "is",
    "iso639_3": "isl",
    "nameEn": "Icelandic",
    "region": "IS",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "it-IT": {
    "altNames": [],
    "altScripts": [],
    "code": "it-IT",
    "endonym": "italiano",
    "fleurs": {
      "config": "it_it"
    },
    "iso639_1": "it",
    "iso639_3": "ita",
    "nameEn": "Italian",
    "region": "IT",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ja-JP": {
    "altNames": [],
    "altScripts": [],
    "code": "ja-JP",
    "endonym": "日本語",
    "fleurs": {
      "config": "ja_jp"
    },
    "iso639_1": "ja",
    "iso639_3": "jpn",
    "nameEn": "Japanese",
    "region": "JP",
    "script": "Jpan",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "grapheme",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "「",
          "」"
        ],
        "sentenceEnders": [
          "。",
          "！",
          "？"
        ]
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "skip"
  },
  "jv-ID": {
    "altNames": [
      "Javanese"
    ],
    "altScripts": [],
    "code": "jv-ID",
    "endonym": "Jawa",
    "fleurs": {
      "config": "jv_id"
    },
    "iso639_1": "jv",
    "iso639_3": "jav",
    "nameEn": "Javanese",
    "region": "ID",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "ka-GE": {
    "altNames": [],
    "altScripts": [],
    "code": "ka-GE",
    "endonym": "ქართული",
    "fleurs": {
      "config": "ka_ge"
    },
    "iso639_1": "ka",
    "iso639_3": "kat",
    "nameEn": "Georgian",
    "region": "GE",
    "script": "Geor",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "kam-KE": {
    "altNames": [],
    "altScripts": [],
    "code": "kam-KE",
    "endonym": "Kikamba",
    "fleurs": {
      "config": "kam_ke"
    },
    "iso639_1": null,
    "iso639_3": "kam",
    "nameEn": "Kamba",
    "region": "KE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "kea-CV": {
    "altNames": [],
    "altScripts": [],
    "code": "kea-CV",
    "endonym": "kabuverdianu",
    "fleurs": {
      "config": "kea_cv"
    },
    "iso639_1": null,
    "iso639_3": "kea",
    "nameEn": "Kabuverdianu",
    "region": "CV",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "kk-KZ": {
    "altNames": [],
    "altScripts": [],
    "code": "kk-KZ",
    "endonym": "қазақ тілі",
    "fleurs": {
      "config": "kk_kz"
    },
    "iso639_1": "kk",
    "iso639_3": "kaz",
    "nameEn": "Kazakh",
    "region": "KZ",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "km-KH": {
    "altNames": [],
    "altScripts": [],
    "code": "km-KH",
    "endonym": "ខ្មែរ",
    "fleurs": {
      "config": "km_kh"
    },
    "iso639_1": "km",
    "iso639_3": "khm",
    "nameEn": "Khmer",
    "region": "KH",
    "script": "Khmr",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "icu",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          "។",
          "៕",
          "?",
          "!"
        ]
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "kn-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "kn-IN",
    "endonym": "ಕನ್ನಡ",
    "fleurs": {
      "config": "kn_in"
    },
    "iso639_1": "kn",
    "iso639_3": "kan",
    "nameEn": "Kannada",
    "region": "IN",
    "script": "Knda",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ko-KR": {
    "altNames": [],
    "altScripts": [],
    "code": "ko-KR",
    "endonym": "한국어",
    "fleurs": {
      "config": "ko_kr"
    },
    "iso639_1": "ko",
    "iso639_3": "kor",
    "nameEn": "Korean",
    "region": "KR",
    "script": "Hang",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "skip"
  },
  "ky-KG": {
    "altNames": [],
    "altScripts": [],
    "code": "ky-KG",
    "endonym": "кыргызча",
    "fleurs": {
      "config": "ky_kg"
    },
    "iso639_1": "ky",
    "iso639_3": "kir",
    "nameEn": "Kyrgyz",
    "region": "KG",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "lb-LU": {
    "altNames": [],
    "altScripts": [],
    "code": "lb-LU",
    "endonym": "Lëtzebuergesch",
    "fleurs": {
      "config": "lb_lu"
    },
    "iso639_1": "lb",
    "iso639_3": "ltz",
    "nameEn": "Luxembourgish",
    "region": "LU",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "lg-UG": {
    "altNames": [],
    "altScripts": [],
    "code": "lg-UG",
    "endonym": "Luganda",
    "fleurs": {
      "config": "lg_ug"
    },
    "iso639_1": "lg",
    "iso639_3": "lug",
    "nameEn": "Ganda",
    "region": "UG",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "ln-CD": {
    "altNames": [],
    "altScripts": [],
    "code": "ln-CD",
    "endonym": "lingála",
    "fleurs": {
      "config": "ln_cd"
    },
    "iso639_1": "ln",
    "iso639_3": "lin",
    "nameEn": "Lingala",
    "region": "CD",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "lo-LA": {
    "altNames": [],
    "altScripts": [],
    "code": "lo-LA",
    "endonym": "ລາວ",
    "fleurs": {
      "config": "lo_la"
    },
    "iso639_1": "lo",
    "iso639_3": "lao",
    "nameEn": "Lao",
    "region": "LA",
    "script": "Laoo",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "icu",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": []
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "lt-LT": {
    "altNames": [],
    "altScripts": [],
    "code": "lt-LT",
    "endonym": "lietuvių",
    "fleurs": {
      "config": "lt_lt"
    },
    "iso639_1": "lt",
    "iso639_3": "lit",
    "nameEn": "Lithuanian",
    "region": "LT",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "luo-KE": {
    "altNames": [],
    "altScripts": [],
    "code": "luo-KE",
    "endonym": "Dholuo",
    "fleurs": {
      "config": "luo_ke"
    },
    "iso639_1": null,
    "iso639_3": "luo",
    "nameEn": "Luo",
    "region": "KE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "lv-LV": {
    "altNames": [],
    "altScripts": [],
    "code": "lv-LV",
    "endonym": "latviešu",
    "fleurs": {
      "config": "lv_lv"
    },
    "iso639_1": "lv",
    "iso639_3": "lav",
    "nameEn": "Latvian",
    "region": "LV",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "mi-NZ": {
    "altNames": [],
    "altScripts": [],
    "code": "mi-NZ",
    "endonym": "Māori",
    "fleurs": {
      "config": "mi_nz"
    },
    "iso639_1": "mi",
    "iso639_3": "mri",
    "nameEn": "Māori",
    "region": "NZ",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "mk-MK": {
    "altNames": [],
    "altScripts": [],
    "code": "mk-MK",
    "endonym": "македонски",
    "fleurs": {
      "config": "mk_mk"
    },
    "iso639_1": "mk",
    "iso639_3": "mkd",
    "nameEn": "Macedonian",
    "region": "MK",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "„",
          "“"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ml-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "ml-IN",
    "endonym": "മലയാളം",
    "fleurs": {
      "config": "ml_in"
    },
    "iso639_1": "ml",
    "iso639_3": "mal",
    "nameEn": "Malayalam",
    "region": "IN",
    "script": "Mlym",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "mn-MN": {
    "altNames": [],
    "altScripts": [],
    "code": "mn-MN",
    "endonym": "монгол",
    "fleurs": {
      "config": "mn_mn"
    },
    "iso639_1": "mn",
    "iso639_3": "mon",
    "nameEn": "Mongolian",
    "region": "MN",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "mr-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "mr-IN",
    "endonym": "मराठी",
    "fleurs": {
      "config": "mr_in"
    },
    "iso639_1": "mr",
    "iso639_3": "mar",
    "nameEn": "Marathi",
    "region": "IN",
    "script": "Deva",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ms-MY": {
    "altNames": [],
    "altScripts": [],
    "code": "ms-MY",
    "endonym": "Melayu",
    "fleurs": {
      "config": "ms_my"
    },
    "iso639_1": "ms",
    "iso639_3": "msa",
    "nameEn": "Malay",
    "region": "MY",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "mt-MT": {
    "altNames": [],
    "altScripts": [],
    "code": "mt-MT",
    "endonym": "Malti",
    "fleurs": {
      "config": "mt_mt"
    },
    "iso639_1": "mt",
    "iso639_3": "mlt",
    "nameEn": "Maltese",
    "region": "MT",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "my-MM": {
    "altNames": [
      "Myanmar"
    ],
    "altScripts": [],
    "code": "my-MM",
    "endonym": "မြန်မာ",
    "fleurs": {
      "config": "my_mm"
    },
    "iso639_1": "my",
    "iso639_3": "mya",
    "nameEn": "Burmese",
    "region": "MM",
    "script": "Mymr",
    "seed": {
      "enabled": true,
      "humanReviewed": true,
      "notes": "Verified by operational use since 2026, not by the harness. CER to be measured in Phase 5. The harness can award beta and experimental on its own; it can never award verified.",
      "tier": "verified"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "grapheme",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          "။",
          "၊"
        ]
      },
      "reportWer": false,
      "wordJoin": " ",
      "wordSegmentation": "none",
      "zawgyiApplies": true
    },
    "waveHint": "asia-nonlatin"
  },
  "nb-NO": {
    "altNames": [
      "no",
      "nor",
      "Norwegian"
    ],
    "altScripts": [],
    "code": "nb-NO",
    "endonym": "norsk bokmål",
    "fleurs": {
      "config": "nb_no"
    },
    "iso639_1": "nb",
    "iso639_3": "nob",
    "nameEn": "Norwegian Bokmål",
    "region": "NO",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ne-NP": {
    "altNames": [],
    "altScripts": [],
    "code": "ne-NP",
    "endonym": "नेपाली",
    "fleurs": {
      "config": "ne_np"
    },
    "iso639_1": "ne",
    "iso639_3": "nep",
    "nameEn": "Nepali",
    "region": "NP",
    "script": "Deva",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "nl-NL": {
    "altNames": [],
    "altScripts": [],
    "code": "nl-NL",
    "endonym": "Nederlands",
    "fleurs": {
      "config": "nl_nl"
    },
    "iso639_1": "nl",
    "iso639_3": "nld",
    "nameEn": "Dutch",
    "region": "NL",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "nso-ZA": {
    "altNames": [
      "Sepedi",
      "Pedi"
    ],
    "altScripts": [],
    "code": "nso-ZA",
    "endonym": "Sesotho sa Leboa",
    "fleurs": {
      "config": "nso_za"
    },
    "iso639_1": null,
    "iso639_3": "nso",
    "nameEn": "Northern Sotho",
    "region": "ZA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "ny-MW": {
    "altNames": [
      "Chichewa",
      "Chewa"
    ],
    "altScripts": [],
    "code": "ny-MW",
    "endonym": "Nyanja",
    "fleurs": {
      "config": "ny_mw"
    },
    "iso639_1": "ny",
    "iso639_3": "nya",
    "nameEn": "Nyanja",
    "region": "MW",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "oc-FR": {
    "altNames": [],
    "altScripts": [],
    "code": "oc-FR",
    "endonym": "occitan",
    "fleurs": {
      "config": "oc_fr"
    },
    "iso639_1": "oc",
    "iso639_3": "oci",
    "nameEn": "Occitan",
    "region": "FR",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "om-ET": {
    "altNames": [],
    "altScripts": [],
    "code": "om-ET",
    "endonym": "Oromoo",
    "fleurs": {
      "config": "om_et"
    },
    "iso639_1": "om",
    "iso639_3": "orm",
    "nameEn": "Oromo",
    "region": "ET",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "or-IN": {
    "altNames": [
      "Oriya"
    ],
    "altScripts": [],
    "code": "or-IN",
    "endonym": "ଓଡ଼ିଆ",
    "fleurs": {
      "config": "or_in"
    },
    "iso639_1": "or",
    "iso639_3": "ori",
    "nameEn": "Odia",
    "region": "IN",
    "script": "Orya",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "pa-Guru-IN": {
    "altNames": [
      "pa-IN",
      "Panjabi"
    ],
    "altScripts": [],
    "code": "pa-Guru-IN",
    "endonym": "ਪੰਜਾਬੀ",
    "fleurs": {
      "config": "pa_in"
    },
    "iso639_1": "pa",
    "iso639_3": "pan",
    "nameEn": "Punjabi",
    "region": "IN",
    "script": "Guru",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "pl-PL": {
    "altNames": [],
    "altScripts": [],
    "code": "pl-PL",
    "endonym": "polski",
    "fleurs": {
      "config": "pl_pl"
    },
    "iso639_1": "pl",
    "iso639_3": "pol",
    "nameEn": "Polish",
    "region": "PL",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ps-AF": {
    "altNames": [],
    "altScripts": [],
    "code": "ps-AF",
    "endonym": "پښتو",
    "fleurs": {
      "config": "ps_af"
    },
    "iso639_1": "ps",
    "iso639_3": "pus",
    "nameEn": "Pashto",
    "region": "AF",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "rtl"
  },
  "pt-BR": {
    "altNames": [],
    "altScripts": [],
    "code": "pt-BR",
    "endonym": "português",
    "fleurs": {
      "config": "pt_br"
    },
    "iso639_1": "pt",
    "iso639_3": "por",
    "nameEn": "Portuguese (Brazil)",
    "region": "BR",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "pt-PT": {
    "altNames": [],
    "altScripts": [],
    "code": "pt-PT",
    "endonym": "português",
    "fleurs": {
      "config": null
    },
    "iso639_1": "pt",
    "iso639_3": "por",
    "nameEn": "Portuguese (Portugal)",
    "region": "PT",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ro-RO": {
    "altNames": [],
    "altScripts": [],
    "code": "ro-RO",
    "endonym": "română",
    "fleurs": {
      "config": "ro_ro"
    },
    "iso639_1": "ro",
    "iso639_3": "ron",
    "nameEn": "Romanian",
    "region": "RO",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ru-RU": {
    "altNames": [],
    "altScripts": [],
    "code": "ru-RU",
    "endonym": "русский",
    "fleurs": {
      "config": "ru_ru"
    },
    "iso639_1": "ru",
    "iso639_3": "rus",
    "nameEn": "Russian",
    "region": "RU",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "rup-BG": {
    "altNames": [],
    "altScripts": [],
    "code": "rup-BG",
    "endonym": null,
    "fleurs": {
      "config": null
    },
    "iso639_1": null,
    "iso639_3": "rup",
    "nameEn": "Aromanian",
    "region": "BG",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "sd-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "sd-IN",
    "endonym": "سنڌي",
    "fleurs": {
      "config": "sd_in"
    },
    "iso639_1": "sd",
    "iso639_3": "snd",
    "nameEn": "Sindhi",
    "region": "IN",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "rtl"
  },
  "si-LK": {
    "altNames": [],
    "altScripts": [],
    "code": "si-LK",
    "endonym": "සිංහල",
    "fleurs": {
      "config": null
    },
    "iso639_1": "si",
    "iso639_3": "sin",
    "nameEn": "Sinhala",
    "region": "LK",
    "script": "Sinh",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "sk-SK": {
    "altNames": [],
    "altScripts": [],
    "code": "sk-SK",
    "endonym": "slovenčina",
    "fleurs": {
      "config": "sk_sk"
    },
    "iso639_1": "sk",
    "iso639_3": "slk",
    "nameEn": "Slovak",
    "region": "SK",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "sl-SI": {
    "altNames": [],
    "altScripts": [],
    "code": "sl-SI",
    "endonym": "slovenščina",
    "fleurs": {
      "config": "sl_si"
    },
    "iso639_1": "sl",
    "iso639_3": "slv",
    "nameEn": "Slovenian",
    "region": "SI",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "sn-ZW": {
    "altNames": [],
    "altScripts": [],
    "code": "sn-ZW",
    "endonym": "chiShona",
    "fleurs": {
      "config": "sn_zw"
    },
    "iso639_1": "sn",
    "iso639_3": "sna",
    "nameEn": "Shona",
    "region": "ZW",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "so-SO": {
    "altNames": [],
    "altScripts": [],
    "code": "so-SO",
    "endonym": "Soomaali",
    "fleurs": {
      "config": "so_so"
    },
    "iso639_1": "so",
    "iso639_3": "som",
    "nameEn": "Somali",
    "region": "SO",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "sq-AL": {
    "altNames": [],
    "altScripts": [],
    "code": "sq-AL",
    "endonym": "shqip",
    "fleurs": {
      "config": null
    },
    "iso639_1": "sq",
    "iso639_3": "sqi",
    "nameEn": "Albanian",
    "region": "AL",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "sr-RS": {
    "altNames": [],
    "altScripts": [
      "Cyrl"
    ],
    "code": "sr-RS",
    "endonym": "српски",
    "fleurs": {
      "config": "sr_rs"
    },
    "iso639_1": "sr",
    "iso639_3": "srp",
    "nameEn": "Serbian",
    "region": "RS",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "„",
          "“"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "su-ID": {
    "altNames": [],
    "altScripts": [],
    "code": "su-ID",
    "endonym": "Basa Sunda",
    "fleurs": {
      "config": null
    },
    "iso639_1": "su",
    "iso639_3": "sun",
    "nameEn": "Sundanese",
    "region": "ID",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "sv-SE": {
    "altNames": [],
    "altScripts": [],
    "code": "sv-SE",
    "endonym": "svenska",
    "fleurs": {
      "config": "sv_se"
    },
    "iso639_1": "sv",
    "iso639_3": "swe",
    "nameEn": "Swedish",
    "region": "SE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "sw-KE": {
    "altNames": [],
    "altScripts": [],
    "code": "sw-KE",
    "endonym": "Kiswahili",
    "fleurs": {
      "config": "sw_ke"
    },
    "iso639_1": "sw",
    "iso639_3": "swa",
    "nameEn": "Swahili",
    "region": "KE",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "ta-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "ta-IN",
    "endonym": "தமிழ்",
    "fleurs": {
      "config": "ta_in"
    },
    "iso639_1": "ta",
    "iso639_3": "tam",
    "nameEn": "Tamil",
    "region": "IN",
    "script": "Taml",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "te-IN": {
    "altNames": [],
    "altScripts": [],
    "code": "te-IN",
    "endonym": "తెలుగు",
    "fleurs": {
      "config": "te_in"
    },
    "iso639_1": "te",
    "iso639_3": "tel",
    "nameEn": "Telugu",
    "region": "IN",
    "script": "Telu",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "tg-TJ": {
    "altNames": [],
    "altScripts": [],
    "code": "tg-TJ",
    "endonym": "тоҷикӣ",
    "fleurs": {
      "config": "tg_tj"
    },
    "iso639_1": "tg",
    "iso639_3": "tgk",
    "nameEn": "Tajik",
    "region": "TJ",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "asia-nonlatin"
  },
  "th-TH": {
    "altNames": [],
    "altScripts": [],
    "code": "th-TH",
    "endonym": "ไทย",
    "fleurs": {
      "config": "th_th"
    },
    "iso639_1": "th",
    "iso639_3": "tha",
    "nameEn": "Thai",
    "region": "TH",
    "script": "Thai",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "icu",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": []
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "tr-TR": {
    "altNames": [],
    "altScripts": [],
    "code": "tr-TR",
    "endonym": "Türkçe",
    "fleurs": {
      "config": "tr_tr"
    },
    "iso639_1": "tr",
    "iso639_3": "tur",
    "nameEn": "Turkish",
    "region": "TR",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "uk-UA": {
    "altNames": [],
    "altScripts": [],
    "code": "uk-UA",
    "endonym": "українська",
    "fleurs": {
      "config": "uk_ua"
    },
    "iso639_1": "uk",
    "iso639_3": "ukr",
    "nameEn": "Ukrainian",
    "region": "UA",
    "script": "Cyrl",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "«",
          "»"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "umb-AO": {
    "altNames": [],
    "altScripts": [],
    "code": "umb-AO",
    "endonym": null,
    "fleurs": {
      "config": "umb_ao"
    },
    "iso639_1": null,
    "iso639_3": "umb",
    "nameEn": "Umbundu",
    "region": "AO",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "ur-PK": {
    "altNames": [],
    "altScripts": [],
    "code": "ur-PK",
    "endonym": "اردو",
    "fleurs": {
      "config": "ur_pk"
    },
    "iso639_1": "ur",
    "iso639_3": "urd",
    "nameEn": "Urdu",
    "region": "PK",
    "script": "Arab",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "۔",
          "؟",
          "!"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "uz-UZ": {
    "altNames": [],
    "altScripts": [],
    "code": "uz-UZ",
    "endonym": "o‘zbek",
    "fleurs": {
      "config": "uz_uz"
    },
    "iso639_1": "uz",
    "iso639_3": "uzb",
    "nameEn": "Uzbek",
    "region": "UZ",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "vi-VN": {
    "altNames": [],
    "altScripts": [],
    "code": "vi-VN",
    "endonym": "Tiếng Việt",
    "fleurs": {
      "config": "vi_vn"
    },
    "iso639_1": "vi",
    "iso639_3": "vie",
    "nameEn": "Vietnamese",
    "region": "VN",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "covered-by-openai"
  },
  "wo-SN": {
    "altNames": [],
    "altScripts": [],
    "code": "wo-SN",
    "endonym": "Wolof",
    "fleurs": {
      "config": "wo_sn"
    },
    "iso639_1": "wo",
    "iso639_3": "wol",
    "nameEn": "Wolof",
    "region": "SN",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "xh-ZA": {
    "altNames": [],
    "altScripts": [],
    "code": "xh-ZA",
    "endonym": "IsiXhosa",
    "fleurs": {
      "config": "xh_za"
    },
    "iso639_1": "xh",
    "iso639_3": "xho",
    "nameEn": "Xhosa",
    "region": "ZA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "yo-NG": {
    "altNames": [],
    "altScripts": [],
    "code": "yo-NG",
    "endonym": "Èdè Yorùbá",
    "fleurs": {
      "config": "yo_ng"
    },
    "iso639_1": "yo",
    "iso639_3": "yor",
    "nameEn": "Yoruba",
    "region": "NG",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  },
  "yue-Hant-HK": {
    "altNames": [
      "zh-HK",
      "Yue"
    ],
    "altScripts": [],
    "code": "yue-Hant-HK",
    "endonym": "粵語",
    "fleurs": {
      "config": "yue_hant_hk"
    },
    "iso639_1": null,
    "iso639_3": "yue",
    "nameEn": "Cantonese",
    "region": "HK",
    "script": "Hani",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 24,
      "cpsMax": 12,
      "lineBreak": "grapheme",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": true,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "「",
          "」"
        ],
        "sentenceEnders": [
          "。",
          "！",
          "？"
        ]
      },
      "reportWer": false,
      "wordJoin": "",
      "wordSegmentation": "none",
      "zawgyiApplies": false
    },
    "waveHint": "skip"
  },
  "zu-ZA": {
    "altNames": [],
    "altScripts": [],
    "code": "zu-ZA",
    "endonym": "isiZulu",
    "fleurs": {
      "config": "zu_za"
    },
    "iso639_1": "zu",
    "iso639_3": "zul",
    "nameEn": "Zulu",
    "region": "ZA",
    "script": "Latn",
    "seed": {
      "enabled": true,
      "humanReviewed": false,
      "notes": null,
      "tier": "experimental"
    },
    "subtitle": {
      "charsPerLineMax": 42,
      "cpsMax": 17,
      "lineBreak": "space",
      "maxLines": 2
    },
    "text": {
      "cerStripsWhitespace": false,
      "normalizers": [
        "nfc",
        "zero-width",
        "collapse-ws"
      ],
      "punctuation": {
        "quotes": [
          "“",
          "”"
        ],
        "sentenceEnders": [
          ".",
          "!",
          "?"
        ]
      },
      "reportWer": true,
      "wordJoin": " ",
      "wordSegmentation": "spaces",
      "zawgyiApplies": false
    },
    "waveHint": "latin-exclusive"
  }
} as Record<string, LanguageEntry>,
);

export const PROVIDER_MATRIX: Readonly<
  Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>
> = deepFreeze(
  {
  "am-ET": {
    "groq": {
      "adaptation": "unknown",
      "probedAt": "never",
      "providerCode": "am-ET",
      "reason": "as km-KH",
      "status": "unknown",
      "supported": false,
      "verdict": "suspected",
      "wordTimestamps": null
    }
  },
  "km-KH": {
    "groq": {
      "adaptation": "unknown",
      "probedAt": "never",
      "providerCode": "km-KH",
      "reason": "Same low-resource family as the measured my-MM failure; unverified. Warn in the picker; do not claim support.",
      "status": "unknown",
      "supported": false,
      "verdict": "suspected",
      "wordTimestamps": null
    }
  },
  "lo-LA": {
    "groq": {
      "adaptation": "unknown",
      "probedAt": "never",
      "providerCode": "lo-LA",
      "reason": "as km-KH",
      "status": "unknown",
      "supported": false,
      "verdict": "suspected",
      "wordTimestamps": null
    }
  },
  "my-MM": {
    "groq": {
      "adaptation": "unknown",
      "evidence": "လာက္းကေက် ရိုရ်းသဲ့ထါတ် … versus Google's correct output on the same 12 s clip. research/language-support-whisper-vs-google.md, 2026-07-30. This is the finding the whole 'accepting a language code proves nothing' rule is built on.",
      "probedAt": "never",
      "providerCode": "my-MM",
      "reason": "Accepts language=my and returns non-words; on autodetect returns romanized Latin.",
      "status": "unknown",
      "supported": false,
      "verdict": "measured-failure",
      "wordTimestamps": null
    }
  },
  "ps-AF": {
    "groq": {
      "adaptation": "unknown",
      "probedAt": "never",
      "providerCode": "ps-AF",
      "reason": "as km-KH",
      "status": "unknown",
      "supported": false,
      "verdict": "suspected",
      "wordTimestamps": null
    }
  },
  "si-LK": {
    "groq": {
      "adaptation": "unknown",
      "probedAt": "never",
      "providerCode": "si-LK",
      "reason": "as km-KH",
      "status": "unknown",
      "supported": false,
      "verdict": "suspected",
      "wordTimestamps": null
    }
  }
} as Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>,
);
