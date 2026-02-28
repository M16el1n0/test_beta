import logging
import sqlite3
import os
import json
import asyncio
import hmac
import hashlib
from aiohttp import web
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, LabeledPrice
from telegram.ext import (
    Application, CommandHandler, MessageHandler, PreCheckoutQueryHandler,
    ContextTypes, ConversationHandler, filters
)

# ─── CONFIG ───────────────────────────────────────────────────────────────────
BOT_TOKEN      = "8700173300:AAFguL_dEKOSUvOep_7iK1MIaiTaaFex2bg"
ADMIN_USERNAME = "m16el1n0"
WEB_APP_URL    = "https://t.me/fleep_gift_bot/GAME"
DB_PATH        = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.db")

# ⚠️ Railway/Render сами выставляют PORT через переменную окружения
PORT = int(os.environ.get("PORT", 8080))

# ─── ПРОМОКОДЫ ────────────────────────────────────────────────────────────────
PROMO_CODES = {
    "VESNA26": 0.20,
}

# ─── ПАКЕТЫ ───────────────────────────────────────────────────────────────────
STAR_PACKAGES = [
    {"stars": 50,   "coins": 50,   "label": "🌱 Старт"},
    {"stars": 100,  "coins": 100,  "label": "⚡ Базовый"},
    {"stars": 250,  "coins": 250,  "label": "🔥 Популярный"},
    {"stars": 500,  "coins": 500,  "label": "💎 Продвинутый"},
    {"stars": 1000, "coins": 1000, "label": "👑 Максимум"},
]

WAIT_MESSAGE, WAIT_BUTTON_LABEL = range(2)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Глобальная ссылка на Application (нужна внутри aiohttp-хэндлеров)
_app: Application | None = None


# ─── DATABASE ─────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id    INTEGER PRIMARY KEY,
            username   TEXT,
            full_name  TEXT,
            gold_coins INTEGER NOT NULL DEFAULT 0
        )
    """)
    try:
        conn.execute("ALTER TABLE users ADD COLUMN gold_coins INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass
    conn.commit()
    conn.close()


def save_user(user):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """INSERT INTO users (user_id, username, full_name, gold_coins)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(user_id) DO UPDATE SET
               username=excluded.username,
               full_name=excluded.full_name""",
        (user.id, user.username, user.full_name)
    )
    conn.commit()
    conn.close()


def get_gold(user_id: int) -> int:
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT gold_coins FROM users WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return row[0] if row else 0


def add_gold(user_id: int, amount: int):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE users SET gold_coins = gold_coins + ? WHERE user_id = ?",
        (amount, user_id)
    )
    conn.commit()
    conn.close()


def get_all_users():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT user_id FROM users").fetchall()
    conn.close()
    return [r[0] for r in rows]


def count_users():
    conn = sqlite3.connect(DB_PATH)
    n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    conn.close()
    return n


# ─── HELPERS ──────────────────────────────────────────────────────────────────
def make_even(n: int) -> int:
    return n if n % 2 == 0 else n - 1


def calc_coins(base: int, promo: str | None) -> int:
    coins = base
    if promo and promo.upper() in PROMO_CODES:
        coins = int(coins * (1 + PROMO_CODES[promo.upper()]))
    return make_even(coins)


def verify_telegram_data(init_data: str) -> bool:
    """
    Проверяем подпись initData от Telegram WebApp.
    Защита от подделки запросов к /create-invoice.
    """
    try:
        pairs = {}
        hash_val = None
        for part in init_data.split("&"):
            k, _, v = part.partition("=")
            if k == "hash":
                hash_val = v
            else:
                pairs[k] = v

        if not hash_val:
            return False

        check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed   = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, hash_val)
    except Exception:
        return False


# ─── HTTP: /create-invoice ────────────────────────────────────────────────────
# Фронт делает POST /create-invoice → бот создаёт invoice_link → фронт
# вызывает tg.openInvoice(link) → нативная оплата прямо внутри WebApp.

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


async def handle_create_invoice(request: web.Request) -> web.Response:
    # Preflight CORS
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=CORS_HEADERS)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400, headers=CORS_HEADERS)

    stars  = body.get("stars")
    coins  = body.get("coins")
    promo  = (body.get("promo") or "").upper() or None
    # init_data нужен для верификации пользователя
    init_data = body.get("init_data", "")

    # Проверяем подпись Telegram
    if not verify_telegram_data(init_data):
        logger.warning("Invalid initData signature")
        return web.json_response({"error": "Unauthorized"}, status=403, headers=CORS_HEADERS)

    if not stars or not coins:
        return web.json_response({"error": "Missing fields"}, status=400, headers=CORS_HEADERS)

    pkg = next((p for p in STAR_PACKAGES if p["stars"] == int(stars)), None)
    if not pkg:
        return web.json_response({"error": "Invalid package"}, status=400, headers=CORS_HEADERS)

    # Считаем коины на сервере — не доверяем фронту
    final_coins = calc_coins(pkg["coins"], promo)
    promo_valid = promo and promo in PROMO_CODES
    bonus_pct   = int(PROMO_CODES[promo] * 100) if promo_valid else 0

    # user_id из initData
    try:
        user_obj = json.loads(
            next(v for k, v in (p.partition("=")[::2] for p in init_data.split("&")) if k == "user")
        )
        user_id = user_obj["id"]
    except Exception:
        return web.json_response({"error": "Cannot parse user"}, status=400, headers=CORS_HEADERS)

    desc = f"🟡 {final_coins} золотых коинов"
    if promo_valid:
        desc += f" (+{bonus_pct}% по промокоду {promo})"

    payload = f"stars_{stars}_{final_coins}_{user_id}"

    try:
        invoice_link = await _app.bot.create_invoice_link(
            title=f"{pkg['label']} — {stars} ⭐",
            description=desc,
            payload=payload,
            currency="XTR",
            prices=[LabeledPrice("Звёзды Telegram", int(stars))],
        )
    except Exception as e:
        logger.error(f"create_invoice_link error: {e}")
        return web.json_response({"error": "Telegram API error"}, status=500, headers=CORS_HEADERS)

    return web.json_response(
        {"invoice_link": invoice_link, "coins": final_coins},
        headers=CORS_HEADERS
    )


async def handle_health(request: web.Request) -> web.Response:
    return web.Response(text="OK")


# ─── BOT HANDLERS ─────────────────────────────────────────────────────────────
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    save_user(user)
    keyboard = [[InlineKeyboardButton("🎮 Play!", url=WEB_APP_URL)]]
    await update.message.reply_text(
        "👋 Приветствуем в *FLEEP GIFT*!\n\n"
        "Нажми кнопку ниже, чтобы открыть приложение 🎉\n\n"
        "💡 Пополнить коины: /topup\n"
        "💰 Баланс: /balance",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


async def balance_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    save_user(user)
    gold = get_gold(user.id)
    await update.message.reply_text(
        f"💰 *Твой баланс*\n\n🟡 Золотые коины: *{gold}*",
        parse_mode="Markdown"
    )


async def topup(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    save_user(user)
    args = ctx.args or []

    if not args:
        lines = [f"  /topup {p['stars']} — 🟡 {p['coins']} коинов  {p['label']}" for p in STAR_PACKAGES]
        await update.message.reply_text(
            "⭐ *Пополнение золотых коинов*\n\n"
            "1 звезда Telegram = 1 🟡 золотой коин\n\n"
            + "\n".join(lines) +
            "\n\n`/topup 100` — 100 звёзд\n"
            "`/topup 250 VESNA26` — с промокодом +20%",
            parse_mode="Markdown"
        )
        return

    try:
        stars = int(args[0])
    except ValueError:
        await update.message.reply_text("❌ Укажи количество звёзд числом. Например: /topup 100")
        return

    promo = args[1].upper() if len(args) > 1 else None
    pkg   = next((p for p in STAR_PACKAGES if p["stars"] == stars), None)

    if not pkg:
        valid = ", ".join(str(p["stars"]) for p in STAR_PACKAGES)
        await update.message.reply_text(f"❌ Пакет {stars} звёзд не найден.\nДоступные: {valid}")
        return

    promo_valid = promo and promo in PROMO_CODES
    if promo and not promo_valid:
        await update.message.reply_text(f"⚠️ Промокод «{promo}» не найден. Продолжаем без него.")
        promo = None

    final_coins = calc_coins(pkg["coins"], promo)
    bonus_pct   = int(PROMO_CODES[promo] * 100) if promo_valid else 0
    desc = f"🟡 {final_coins} золотых коинов"
    if promo_valid:
        desc += f" (+{bonus_pct}% по промокоду {promo})"

    payload = f"stars_{stars}_{final_coins}_{user.id}"
    await update.message.reply_invoice(
        title=f"{pkg['label']} — {stars} ⭐",
        description=desc,
        payload=payload,
        currency="XTR",
        prices=[LabeledPrice("Звёзды Telegram", stars)],
    )


async def pre_checkout(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.pre_checkout_query
    parts = query.invoice_payload.split("_")
    if len(parts) == 4 and parts[0] == "stars":
        await query.answer(ok=True)
    else:
        await query.answer(ok=False, error_message="Неверный запрос. Попробуй ещё раз.")


async def successful_payment(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    payment = update.message.successful_payment
    payload = payment.invoice_payload
    user    = update.effective_user

    try:
        _, stars_str, coins_str, _ = payload.split("_")
        coins = int(coins_str)
        stars = int(stars_str)
    except Exception:
        logger.error(f"Cannot parse payload: {payload}")
        await update.message.reply_text("✅ Оплата прошла! Напиши в поддержку — начислим вручную.")
        return

    add_gold(user.id, coins)
    new_balance = get_gold(user.id)
    logger.info(f"Payment OK: user={user.id} +{coins} gold, balance={new_balance}")

    await update.message.reply_text(
        f"✅ *Оплата прошла!*\n\n"
        f"⭐ Оплачено: *{stars} звёзд*\n"
        f"🟡 Начислено: *{coins} коинов*\n\n"
        f"💰 Баланс: *{new_balance} 🟡*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🎮 Открыть игру", url=WEB_APP_URL)
        ]])
    )


async def admin(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user.username != ADMIN_USERNAME:
        await update.message.reply_text("⛔ Доступ запрещён.")
        return ConversationHandler.END
    total = count_users()
    await update.message.reply_text(
        f"🛠 *Админ-панель FLEEP GIFT*\n\n👥 Пользователей: *{total}*\n\nВведи текст рассылки:",
        parse_mode="Markdown"
    )
    return WAIT_MESSAGE


async def receive_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    ctx.user_data["broadcast_text"] = update.message.text
    await update.message.reply_text(
        "✅ Текст сохранён.\n\nВведи *подпись кнопки*:", parse_mode="Markdown"
    )
    return WAIT_BUTTON_LABEL


async def receive_button_label(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    label  = update.message.text
    text   = ctx.user_data.get("broadcast_text", "")
    users  = get_all_users()
    kb     = InlineKeyboardMarkup([[InlineKeyboardButton(label, url=WEB_APP_URL)]])
    ok = fail = 0
    await update.message.reply_text(f"📤 Рассылка на {len(users)} пользователей...")
    for uid in users:
        try:
            await ctx.bot.send_message(chat_id=uid, text=text, reply_markup=kb)
            ok += 1
        except Exception as e:
            logger.warning(f"Cannot send to {uid}: {e}")
            fail += 1
    await update.message.reply_text(
        f"✅ *Готово!*\n📬 Доставлено: {ok}\n❌ Ошибок: {fail}", parse_mode="Markdown"
    )
    return ConversationHandler.END


async def cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Рассылка отменена.")
    return ConversationHandler.END


# ─── MAIN ─────────────────────────────────────────────────────────────────────
async def run():
    global _app
    init_db()

    _app = Application.builder().token(BOT_TOKEN).build()

    _app.add_handler(CommandHandler("start", start))
    _app.add_handler(CommandHandler("balance", balance_cmd))
    _app.add_handler(CommandHandler("topup", topup))
    _app.add_handler(PreCheckoutQueryHandler(pre_checkout))
    _app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment))

    admin_conv = ConversationHandler(
        entry_points=[CommandHandler("admin", admin)],
        states={
            WAIT_MESSAGE:      [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_message)],
            WAIT_BUTTON_LABEL: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_button_label)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    _app.add_handler(admin_conv)

    # ─── HTTP сервер для /create-invoice ──────────────────────────────────────
    http = web.Application()
    http.router.add_get("/",               handle_health)
    http.router.add_options("/create-invoice", handle_create_invoice)
    http.router.add_post("/create-invoice",    handle_create_invoice)

    runner = web.AppRunner(http)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    logger.info(f"HTTP server started on port {PORT}")

    # ─── Telegram polling ─────────────────────────────────────────────────────
    async with _app:
        await _app.initialize()
        await _app.start()
        await _app.updater.start_polling()
        logger.info("Bot started!")
        await asyncio.Event().wait()  # крутимся вечно


def main():
    asyncio.run(run())


if __name__ == "__main__":
    main()
