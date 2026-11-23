"""Localized text for verified lookup results, without a second model request."""

# Pair unavailable, reference rate, tether substitute, cached indicator, weather unavailable, forecast.
MESSAGES = {
    "en": (
        "A current {base}/{quote} quote is unavailable.", "1 {base} = {price} {quote}",
        "I couldn’t verify a USD rate. Here’s the tether rate for comparison.", "Cached quote",
        "I couldn’t verify the weather for {city}. Try the city and country together.",
        "{city} · {day}\n{condition} · {low} to {high} {unit}\nChance of precipitation: {rain}%",
    ),
    "fa": (
        "نرخ به‌روز {base}/{quote} در دسترس نیست.", "نرخ هر {base} برابر با {price} {quote} است.",
        "نرخ دلار آمریکا رو نتونستم تأیید کنم. برای مقایسه، این نرخ تتره.", "آخرین نرخ ذخیره‌شده",
        "نتونستم آب‌وهوای {city} رو بررسی کنم. نام شهر و کشور رو با هم بفرست.",
        "آب‌وهوای {city} · {day}\n{condition} · {low} تا {high} {unit}\nاحتمال بارش: {rain}٪",
    ),
    "es": (
        "No hay una cotización actual de {base}/{quote}.", "1 {base} = {price} {quote}",
        "No pude verificar la tasa del dólar. Esta es la de tether para comparar.", "Cotización en caché",
        "No pude consultar el tiempo en {city}. Prueba con la ciudad y el país.",
        "{city} · {day}\n{condition} · de {low} a {high} {unit}\nProbabilidad de precipitación: {rain} %",
    ),
    "fr": (
        "Aucun cours récent pour {base}/{quote}.", "1 {base} = {price} {quote}",
        "Le taux du dollar n’a pas pu être vérifié. Voici celui du tether à titre de comparaison.", "Dernier cours enregistré",
        "La météo de {city} est indisponible. Essaie avec le nom de la ville et du pays.",
        "{city} · {day}\n{condition} · de {low} à {high} {unit}\nRisque de précipitations : {rain} %",
    ),
    "pt-BR": (
        "A cotação atual de {base}/{quote} está indisponível.", "1 {base} = {price} {quote}",
        "Não consegui verificar a cotação do dólar. Veja a do tether para comparar.", "Última cotação armazenada",
        "Não consegui consultar o tempo em {city}. Tente incluir a cidade e o país.",
        "{city} · {day}\n{condition} · de {low} a {high} {unit}\nProbabilidade de precipitação: {rain}%",
    ),
    "ar": (
        "السعر الحالي لزوج {base}/{quote} غير متاح.", "سعر {base} واحد هو {price} {quote}.",
        "لم أتمكن من تأكيد سعر الدولار. هذا سعر تيثر للمقارنة.", "آخر سعر محفوظ",
        "تعذر التحقق من الطقس في {city}. جرّب ذكر المدينة والبلد معًا.",
        "الطقس في {city} · {day}\n{condition} · من {low} إلى {high} {unit}\nاحتمال الهطول: {rain}٪",
    ),
    "de": (
        "Für {base}/{quote} ist kein aktueller Kurs verfügbar.", "1 {base} = {price} {quote}",
        "Der Dollarkurs ließ sich nicht bestätigen. Zum Vergleich ist hier der Tether-Kurs.", "Zwischengespeicherter Kurs",
        "Für {city} sind keine Wetterdaten verfügbar. Gib Stadt und Land gemeinsam an.",
        "{city} · {day}\n{condition} · {low} bis {high} {unit}\nNiederschlagswahrscheinlichkeit: {rain} %",
    ),
    "ja": (
        "{base}/{quote} の最新レートは取得できませんでした。", "1 {base} = {price} {quote}",
        "米ドルのレートを確認できませんでした。比較用にテザーのレートを表示します。", "保存済みのレート",
        "{city} の天気を取得できませんでした。都市名と国名を指定してください。",
        "{city} · {day}\n{condition} · {low}〜{high} {unit}\n降水確率：{rain}%",
    ),
}

CONDITIONS = {
    "en": ("Clear", "Cloudy", "Fog", "Rain", "Snow", "Thunderstorms"),
    "fa": ("صاف", "ابری", "مه‌آلود", "بارانی", "برفی", "رعدوبرق"),
    "es": ("Despejado", "Nublado", "Niebla", "Lluvia", "Nieve", "Tormenta"),
    "fr": ("Dégagé", "Nuageux", "Brouillard", "Pluie", "Neige", "Orages"),
    "pt-BR": ("Céu limpo", "Nublado", "Neblina", "Chuva", "Neve", "Trovoadas"),
    "ar": ("صافٍ", "غائم", "ضباب", "مطر", "ثلوج", "عواصف رعدية"),
    "de": ("Klar", "Bewölkt", "Nebel", "Regen", "Schnee", "Gewitter"),
    "ja": ("晴れ", "曇り", "霧", "雨", "雪", "雷雨"),
}

ASK_CITY = {
    "en": "Which city should I check?",
    "fa": "آب‌وهوای کدوم شهر رو می‌خوای؟",
    "es": "¿Qué ciudad quieres consultar?",
    "fr": "Pour quelle ville veux-tu la météo ?",
    "pt-BR": "De qual cidade você quer saber a previsão?",
    "ar": "لأي مدينة تريد معرفة حالة الطقس؟",
    "de": "Für welche Stadt möchtest du das Wetter wissen?",
    "ja": "どの都市の天気を調べますか？",
}

CURRENT_WEATHER = {
    "en": "Now: {temp} {unit}, {condition}",
    "fa": "الان {temp} {unit}، {condition}",
    "es": "Ahora: {temp} {unit}, {condition}",
    "fr": "Actuellement : {temp} {unit}, {condition}",
    "pt-BR": "Agora: {temp} {unit}, {condition}",
    "ar": "الآن {temp} {unit}، {condition}",
    "de": "Jetzt: {temp} {unit}, {condition}",
    "ja": "現在：{temp} {unit}、{condition}",
}
