# Cleanup eval — 2026-08-14

## Verdict

| language | arm | metric | value | against | delta |
|---|---|---|---|---|---|
| `yo-NG` | current/openai/gpt-oss-20b | content_delta | 0.0952 | 0.0050 | 0.0902 |
| `yo-NG` | current/openai/gpt-oss-20b | cer_punct | 0.0960 | 0.0317 | 0.0643 |
| `so-SO` | current/openai/gpt-oss-20b | content_delta | 0.0239 | 0.0050 | 0.0189 |
| `xh-ZA` | current/openai/gpt-oss-20b | content_delta | 0.0201 | 0.0050 | 0.0151 |
| `ps-AF` | current/openai/gpt-oss-20b | cer_punct | 0.0299 | 0.0167 | 0.0132 |
| `my-MM` | restraint/openai/gpt-oss-20b | cer_punct | 0.0268 | 0.0160 | 0.0108 |
| `xh-ZA` | current/openai/gpt-oss-20b | cer_punct | 0.0514 | 0.0419 | 0.0095 |
| `my-MM` | current/openai/gpt-oss-20b | cer_punct | 0.0213 | 0.0160 | 0.0053 |
| `ha-NG` | current/openai/gpt-oss-20b | content_delta | 0.0094 | 0.0050 | 0.0044 |
| `ps-AF` | current/openai/gpt-oss-20b | content_delta | 0.0064 | 0.0050 | 0.0014 |
| `xh-ZA` | restraint/openai/gpt-oss-20b | content_delta | 0.0051 | 0.0050 | 0.0001 |
| `so-SO` | current/openai/gpt-oss-20b | cer_punct | 0.0435 | 0.0435 | 0.0001 |

## Run

- `2026-08-14T06-02-48-789Z-groq`
- provider **groq**, models `openai/gpt-oss-20b`
- arms control, current, restraint · split dev · n=10 · seed 1
- spent $0.0000

## `my-MM` — Burmese

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.016 | [0.010, 0.022] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.021 | [0.009, 0.035] | 0.0024 | 0.0000 | 0.0120 | 1/9 | 1 |
| restraint | openai/gpt-oss-20b | 0.027 | [0.015, 0.039] | 0.0000 | 0.0000 | 0.0217 | 0/9 | 1 |

**current/openai/gpt-oss-20b** — 1 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":"max completion tokens reached before generating a valid document"}}

```

**restraint/openai/gpt-oss-20b** — 1 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1529
  - in : ယခင်က ring ၏ ceo ဖြစ်သူ ဂျမီစီမင်အော့ဖ် သည် သူ၏ကားထားသည့်နေရာရှိ ဆိုင်မှနေ၍ သူ၏တံခါးဘဲလ်သံကို မကြားရသည့်အချိန်မှစကာ ကုမ္ပဏီကို စတင်ခဲ့ခြင်းဖြစ်သည်ဟု မှတ်ချက်ပြုပြောကြားခဲ့ပါသည်
  - out: ယခင်က ring ၏ ceo ဖြစ်သူ ဂျမီစီမင်အော့ဖ်၊ သူ၏ကားထားသည့်နေရာရှိ ဆိုင်မှနေ၍၊ သူ၏တံခါးဘဲလ်သံကို မကြားရသည့်အချိန်မှစကာ၊ ကုမ္ပဏီကို စတင်ခဲ့ခြင်းဖြစ်သည်ဟု၊ မှတ်ချက်ပြုပြောကြားခဲ့ပါသည်။

## `yo-NG` — Yoruba

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.032 | [0.024, 0.042] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.096 | [0.041, 0.194] | 0.0952 | 0.0000 | 0.0279 | 6/7 | 3 |
| restraint | openai/gpt-oss-20b | 0.018 | [0.009, 0.029] | 0.0011 | 0.0000 | 0.0099 | 1/9 | 1 |

**current/openai/gpt-oss-20b** — 3 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**restraint/openai/gpt-oss-20b** — 1 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1629
  - in : awon iroyin miin wipe bii eyan mejo lo ku iroyin osise jeri pe o to 30 to sise sugbon a o tii mo awon onka ipari
  - out: awọn iroyin miín wípé bíi ẹ̀yàn méjì lọ́kù iroyin ọ̀sìṣẹ́ jèrè pé ó tó 30 tó ṣe sí, ṣùgbọ́n a ó ti mọ̀ àwọn onkà ipari.
- id 1535
  - in : o ṣe àmúlò ìmọ̀ ẹ̀rọ tí orísun rè jẹ́ sátáláìtì èyí tí o yàtò sí àfiwé ìmọ̀ ẹ̀rọ orílẹ̀ àtijó láti fi àyè gba àwọn adarí láti tọ́ka sí ọkọ̀ òfuurufú ní pàtó àti láti fún àwọn awako ní àwọn iròyìn tó ṣe déédéé 
  - out: O ṣe àmúlò ìmọ̀ ẹ̀rọ tí orísun rẹ̀ jẹ́ satẹlaiti, èyí tí o yàtò sí àfiwé ìmọ̀ ẹ̀rọ orílẹ̀-èdè àtijọ́, láti fi àyè gba àwọn adarí láti tọ́ka sí ọkọ̀ òfuurufú ní pàtó, àti láti fún àwọn awako ní àwọn iròyìn tó ṣe déédéé.

**restraint/openai/gpt-oss-20b — segments it rewrote**

- id 1633
  - in : nínú ọkọ̀ akérò aláràọ̀tọ̀ gbogbo ènìyàn nì ó lọ́pọ̀ àti ìgbárùkùtì ìlànà ìrìnlọrìnbọ̀ tó dá l´rí àwọn ọkọ̀ aláàdáni
  - out: Nínú ọkọ̀ akérò aláràọ̀tọ̀ gbogbo ènìyàn nì ó lọ́pọ̀ àti ìgbárùkùtì ìlànà ìrìnlọrìnbọ̀ tó dá l´rí àwọn ọkọ̀ aláàdini.

## `ps-AF` — Pashto

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.017 | [0.011, 0.027] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.030 | [0.021, 0.039] | 0.0064 | 0.0000 | 0.0223 | 4/9 | 1 |
| restraint | openai/gpt-oss-20b | 0.014 | [0.005, 0.024] | 0.0000 | 0.0000 | 0.0136 | 0/10 | 0 |

**current/openai/gpt-oss-20b** — 1 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1535
  - in : دا سټلایټ پر اساس ټکنالوژي استعمالوي او پخوانۍ د ground radar اساس ټکنالوژي یې ختمه کړله تر څو هوایي ترافیکي کنټرول کوونکي د جهاز د کوچني څېز په اړه دقیق وي او پلوټانو ته ډیر دقیق معلومات ورکړي
  - out: دا سټلایټ پر اساس ټکنالوژي استعمالوي، او پخوانۍ د ground radar اساس ټکنالوژي یې ختمه کړله، تر څو هوایي ترافیکي کنټرول کوونکي د جهاز د کوچنی څیز په اړه دقیق وي، او پلوټانو ته ډیر دقیق معلومات ورکړي.
- id 1548
  - in : کله چې ته یو چاته ټیلیفون کوي چې هغه له تا څخه زرګونه میله لرې وي نو تاسې له سټلایټ استفاده کوئ
  - out: کله چې ته یو چا ته ټیلیفون کوې، چې هغه له تا څخه زرګونه میله لرې وي، نو تاسې له سټلایټ استفاده کوئ۔

## `so-SO` — Somali

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.043 | [0.035, 0.053] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.044 | [0.031, 0.058] | 0.0239 | 0.0000 | 0.0252 | 7/7 | 3 |
| restraint | openai/gpt-oss-20b | 0.030 | [0.024, 0.037] | 0.0021 | 0.0000 | 0.0173 | 2/9 | 1 |

**current/openai/gpt-oss-20b** — 3 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**restraint/openai/gpt-oss-20b** — 1 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1606
  - in : waxaa dib u dhisay burtiqiiska ayagoo ugu magac day casa branca waxa ay baneeyen kadib dhul gariirki 1755
  - out: Waxaa dib u dhisay burtuqaalka ayagoo ugu magac day Casa Branca, waxa ay baneeyeen kadib dhul gariirkii 1755.
- id 1633
  - in : khadkan gaadiid ee debecsa ee qof kasta si ugu xiran yahay una taageerayo waa mid ku dhisan baabuur gaar loo leeyahay
  - out: Khadkan gaadiidka ee debecsa, ee qof kasta si uu ugu xiran yahay una taageerayo waa mid ku dhisan baabuur gaar loo leeyahay.

**restraint/openai/gpt-oss-20b — segments it rewrote**

- id 1612
  - in : biyaha ka soo dadanayo buurta qeybta dhirir keedu yahay 100 talaabo
  - out: Biyaha ka soo dadanayo buurta qeybta dhirir keudu yahay 100 talaabo.
- id 1606
  - in : waxaa dib u dhisay burtiqiiska ayagoo ugu magac day casa branca waxa ay baneeyen kadib dhul gariirki 1755
  - out: Waxaa dib u dhisay burtiqiiska ayagoo ugu magac day casa blanca, waxa ay baneeyen kadib dhul gariirki 1755.

## `ha-NG` — Hausa

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.036 | [0.030, 0.040] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.028 | [0.017, 0.041] | 0.0094 | 0.0000 | 0.0254 | 4/10 | 0 |
| restraint | openai/gpt-oss-20b | 0.022 | [0.016, 0.028] | 0.0009 | 0.0000 | 0.0154 | 1/10 | 0 |

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1643
  - in : lambun ya dauki fili mai fadin 19,500 km² kuma ya rabu har kashi 14 kowanne na tallafa wa dabbobin daji dabam
  - out: lambun ya dauki fili mai fadin 19,500 km², kuma ya rabu har kashi 14, kowanne na tallafa wa dabbobin daji daban-daban.
- id 1646
  - in : akwai gaɓar teku mai rairayi da dama sakamakon zagaye tasoshin jiragen ruwa biyu da auckland ta yi fitattun cikinsu suna cikin yankuna uku
  - out: Akwai gaɓar teku mai ra'ayi da dama, sakamakon zagaye tasoshin jiragen ruwa biyu da Auckland ta yi fitattun cikinsu, suna cikin yankuna uku.

**restraint/openai/gpt-oss-20b — segments it rewrote**

- id 1606
  - in : yan portugal sun rushe shi sannan suka sake gina shi a karkashin sunan casa branca amma suka watsar da shi bayan wata girgizar kasa a 1755
  - out: Yan portugal sun rushe shi, sannan suka sake gina shi a karkashin sunan casa blanca, amma suka watsar da shi bayan wata girgizar kasa a 1755.

## `xh-ZA` — Xhosa

10 segment(s), 10 distinct sentence id(s).

| arm | model | cer_punct | ci95 | content_delta | entity_drift | length_delta | rewritten | failed |
|---|---|---|---|---|---|---|---|---|
| **control** | — | 0.042 | [0.031, 0.054] | 0.0000 | 0.0000 | 0.0000 | 0/10 | 0 |
| current | openai/gpt-oss-20b | 0.051 | [0.032, 0.077] | 0.0201 | 0.0000 | 0.0256 | 4/7 | 3 |
| restraint | openai/gpt-oss-20b | 0.029 | [0.017, 0.043] | 0.0051 | 0.0000 | 0.0082 | 2/10 | 0 |

**current/openai/gpt-oss-20b** — 3 call(s) failed. First failure, in the provider's own words:

```
LLM call failed: HTTP 400 — {"error":{"message":"Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}

```

**current/openai/gpt-oss-20b — segments it rewrote**

- id 1644
  - in : uthe ebuzwa izimvo zakhe u-miller uthe u-mark uthethe kakhulu engxoxwenibendizilungiselela ngoku andimvanga ukuba ebesithini.
  - out: uthe ebuzwa izimvo zakhe u-Miller, uthe u-Mark uthethe kakhulu engxoxweni, bidinga silungiselela ngoku, andimvanga ukuba ebesithini.
- id 1524
  - in : zininzi iziphumo zokuhlala nezepolitiki njengosetyenziwa kwenkqubo ye-metric utshintsho kwi-absolutism ukuya kwi-republicanism ne-nationalism futhi nokholo lokuba ilizwe lelabantu balo hayi umphathi yedwa
  - out: zininzi iziphumo zokuhlala nezepolitiki, njengosetyenziwa kwenkqubo ye-metric utshintsho kwi-absolutism ukuya kwi-republicanism ne-nationalism, kwaye nokholo lokuba ilizwe lelabantu balo hayi umphathi yedwa.

**restraint/openai/gpt-oss-20b — segments it rewrote**

- id 1631
  - in : ubukumkani obutsha base-egypt yamandulo babumangalisiwe zizikhumbuzo zabo zangaphambili ezazingaphezulu kweminyaka eliwaka ubudala
  - out: Ubufakazi obutsha base-egypt yamandulo babumangalisiwe zizikhumbuzo zabo zangaphambili ezazingaphezulu kweminyaka eliwaka ubudala.
- id 1644
  - in : uthe ebuzwa izimvo zakhe u-miller uthe u-mark uthethe kakhulu engxoxwenibendizilungiselela ngoku andimvanga ukuba ebesithini.
  - out: Uthe ebuzwa izimvo zakhe u-miller uthe u-mark uthethe kakhulu engxoxwenibendizilungiselela ngoku andimvanga kuba ebesithini.

## Methodology

- Input is FLEURS column 3 (`transcription`, lowercased and unpunctuated); the reference
  is column 2 (`raw_transcription`, punctuated and cased). Scored with punctuation kept
  and case preserved, which is the one place in this harness that happens.
- **`content_delta` is a contract check, not a quality score.** Both sides are stripped of
  punctuation, case and whitespace; a compliant pass leaves them identical, so the value
  must be 0.000. The gate tolerates 0.005 only because Unicode
  normalization differs across providers — about one character in two hundred.
- `entity_drift` is the multiset symmetric difference over ALL-CAPS runs, digit strings
  and — in a non-Latin script — Latin tokens. It is what names an acronym being replaced
  by a pronoun; raw CER moves by two characters for that edit. Gate: 0.02.
- The pass condition is **beating the do-nothing control, per language**, not clearing a
  threshold. Thresholds get tuned until they pass; a control cannot be.
- FLEURS is read Wikipedia sentences — clean, careful, single-speaker, no code-switching.
  Every number here overstates newsroom performance.
