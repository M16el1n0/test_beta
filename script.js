// ===== TELEGRAM WEBAPP =====
let tg = window.Telegram?.WebApp;
const MIN_GAME_STAKE = 10;
const MIN_TOPUP_COINS = 1;
let freeCaseCooldownUntilMs = 0;
let freeCaseCooldownTimer = null;

// The backend authenticates every Mini App request with Telegram initData.
// Keep the iOS-safe archive code intact and add the signed value centrally so
// all payment, balance, referral and inventory requests use the same auth.
(function installTelegramAuthBridge() {
    if (window.__fleepApiAuthFetch || typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        let url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        if (!/https:\/\/138-16-153-215\.nip\.io\/api(?:\/|$)/.test(url)) {
            return nativeFetch(input, init);
        }
        const options = Object.assign({}, init || {});
        try {
            const headers = new Headers(options.headers || (input && input.headers) || {});
            const initData = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) ||
                (tg && tg.initData) || '';
            if (initData) headers.set('X-Telegram-Init-Data', initData);
            options.headers = headers;
        } catch (e) {}
        return nativeFetch(input, options);
    };
    window.__fleepApiAuthFetch = true;
})();

// iOS: expand() иногда не срабатывает с первого раза (аппка открывается «половинкой»),
// поэтому дёргаем ready()/expand() несколько раз. Всё в try — на старом iOS не должно ронять старт.
function initTelegramWebApp() {
    const w = window.Telegram && window.Telegram.WebApp;
    if (!w) return false;
    tg = w; // iOS: пере-захват — нативный объект мог появиться ПОЗЖЕ парсинга этого скрипта
    try { w.ready(); } catch (e) {}
    try { w.expand(); } catch (e) {}
    try { w.setHeaderColor('#000000'); } catch (e) {}
    try { w.setBackgroundColor('#000000'); } catch (e) {}
    try { w.setBottomBarColor('#000000'); } catch (e) {}
    return true;
}
window.__tgSdkReady = initTelegramWebApp;
initTelegramWebApp();
// Поллинг вместо жёстко ограниченных 3 попыток: SDK с telegram.org на слабой сети может
// грузиться дольше 1.2с (см. client_diag — noTG вплоть до STEP 10), поэтому пробуем до ~20с
// вместо того чтобы бросать попытки после 1200мс.
(function pollTgReady() {
    const startedAt = Date.now();
    let tries = 0;
    const t = setInterval(function () {
        tries++;
        if (initTelegramWebApp()) {
            clearInterval(t);
            __diag('tgReady-found +' + (Date.now() - startedAt) + 'ms tries=' + tries);
            return;
        }
        if (tries > 60) {
            clearInterval(t);
            __diag('tgReady-giveup +' + (Date.now() - startedAt) + 'ms nativeProxy=' + (!!window.TelegramWebviewProxy));
        }
    }, 300);
})();

// iOS-КРИТИЧНО: если Telegram-пользователь появился ПОЗЖЕ старта (нативный WebApp инжектится
// с задержкой), заново подтягиваем его данные с сервера — иначе имя/баланс остаются пустыми
// («аппка грузится, но данных нет»). Срабатывает один раз, как только появился реальный user.
function refreshTgUser() {
    const w = window.Telegram && window.Telegram.WebApp;
    if (w) tg = w;
    const telegramUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (telegramUser && String(telegramUser.id) !== activeTelegramUserId) {
        switchTelegramAccount(telegramUser.id);
    }
    if (telegramUser) {
        // A referral deep link can open the Mini App directly. Bind it on the
        // server at launch; the old bot /start flow remains idempotent too.
        bindMiniAppReferral();
        if (!window.__freeCaseCooldownSynced) {
            window.__freeCaseCooldownSynced = true;
            refreshFreeCaseCooldown();
        }
    }
    if (!window.__tgUserSynced && telegramUser) {
        window.__tgUserSynced = true;
        try { if (typeof updateHeaderUsername === 'function') updateHeaderUsername(); } catch (e) {}
        try { if (typeof syncGoldFromServer === 'function') syncGoldFromServer(); } catch (e) {}
        try { if (typeof pullNftDeposits === 'function') pullNftDeposits(); } catch (e) {}
        try { if (typeof loadServerTaskProgress === 'function') loadServerTaskProgress(); } catch (e) {}
        try { if (typeof restoreServerMinesSession === 'function') restoreServerMinesSession(); } catch (e) {}
        try { if (typeof updateBalance === 'function') updateBalance(); } catch (e) {}
    }
}
[60, 250, 600, 1200, 2500, 4000].forEach(function (ms) { setTimeout(refreshTgUser, ms); });
try { window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.onEvent &&
      window.Telegram.WebApp.onEvent('viewportChanged', refreshTgUser); } catch (e) {}


// Форсируем тёмный фон — работает даже без Telegram
(function forceDarkMode() {
    const r = document.documentElement;
    const b = document.body;
    // Перебиваем CSS переменные Telegram
    r.style.setProperty('--tg-theme-bg-color', '#000000', 'important');
    r.style.setProperty('--tg-theme-secondary-bg-color', '#0d0d1a', 'important');
    r.style.setProperty('--tg-theme-text-color', '#ffffff', 'important');
    r.style.setProperty('--tg-color-scheme', 'dark', 'important');
    // Принудительный фон
    r.style.background = '#000000';
    r.style.backgroundColor = '#000000';
    if (b) {
        b.style.background = '#000000';
        b.style.backgroundColor = '#000000';
    }
    // ВРЕМЕННО ОТКЛЮЧЕНО (диагностика зависания на iOS): MutationObserver, следивший за
    // Telegram inline-style инъекциями, подозревается в бесконечном пинг-понге с нативным
    // кодом Telegram (обе стороны переписывают style друг за другом) — это забивает очередь
    // микрозадач и не даёт исполниться вообще ничему, включая обычный setTimeout. Тёмный фон
    // и так форсируется через CSS !important (style.css), так что просто убираем наблюдатель.
})();
function getTgUser() {
    if (tg?.initDataUnsafe?.user) return tg.initDataUnsafe.user;
    return null;
}

// ===== БД в localStorage =====
const DB = {
    get: (key, def = null) => {
        try {
            const scopedKey = key === 'userData' && window.__fleepActiveUserId
                ? `userData:${window.__fleepActiveUserId}`
                : key;
            const v = localStorage.getItem(scopedKey);
            return v ? JSON.parse(v) : def;
        } catch(e) { return def; }
    },
    set: (key, val) => {
        try {
            const scopedKey = key === 'userData' && window.__fleepActiveUserId
                ? `userData:${window.__fleepActiveUserId}`
                : key;
            localStorage.setItem(scopedKey, JSON.stringify(val));
        } catch(e) {}
    }
};

// ===== ДЕФОЛТНЫЕ ДАННЫЕ =====
function getDefaultUserData() {
    return {
        balance: { silver: 10000, gold: 100 },
        registrationDate: new Date().toISOString(),
        lastVisit: new Date().toISOString(),
        lastDailyBonus: null,
        stats: { gamesPlayed: 0, gamesWon: 0, gamesLost: 0, totalWon: 0, maxCoefficient: 0 },
        gameHistory: [],
        rocketHistory: [],
        casesHistory: [],
        tasks: { 1: false, 2: false, 3: false, 4: false, 5: false },
        // Подтверждённые сервером награды. Старый tasks-флаг мог быть выставлен
        // локально даже тогда, когда монеты не дошли до сервера.
        serverTaskClaims: {},
        taskProgress: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        inventory: [],
        consecutiveWins: 0,
        depositStreak: 0,
        lastDailyCase: null
    };
}

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function fixedNumber(value, fallback = 0) {
    return finiteNumber(value, fallback).toFixed(2);
}
function historyCoefficient(entry) {
    return finiteNumber(entry?.coefficient ?? entry?.multiplier ?? entry?.coef, 1);
}

let userData = getDefaultUserData();
let activeTelegramUserId = null;
let serverSyncGeneration = 0;

function switchTelegramAccount(userId) {
    const nextId = String(userId || '').trim();
    if (!nextId || nextId === activeTelegramUserId) return false;
    activeTelegramUserId = nextId;
    window.__fleepActiveUserId = nextId;
    serverSyncGeneration++;
    serverSynced = false;
    serverSyncInFlight = false;
    serverBalanceRevision = 0;
    balanceMutationVersion++;
    userData = Object.assign(getDefaultUserData(), DB.get('userData', getDefaultUserData()) || {});
    updateBalance();
    updateStats();
    updateTasks();
    updateProfileInfo();
    updateGameHistory();
    updateCasesHistory();
    //syncGoldFromServer();
    return true;
}

// Уведомление админу о выигрыше NFT (fire-and-forget, не блокирует UI).
function notifyAdminNftWin(gift) {
    try {
        if (!gift) return;
        const isNft = gift.isNFT === true || (typeof gift.type === 'string' && gift.type.indexOf('nft_') === 0);
        if (!isNft) return;
        const userId = tg?.initDataUnsafe?.user?.id;
        if (!userId) return;
        const username = tg?.initDataUnsafe?.user?.username || '';
        const emoji = gift.emoji || (typeof GIFT_EMOJIS !== 'undefined' && GIFT_EMOJIS[gift.type]) || '🎁';
        fetch(BACKEND_URL + '/notify_nft_win', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, username, gift_name: gift.name || 'NFT', gift_emoji: emoji, gift_value: gift.value || 0 })
        }).catch(() => {});
    } catch (e) {}
}

// Учёт отыгрыша (вейджер): суммарно поставленное серебро. Нужно для правила «13× стоимости подарка для вывода».
function addWager(amount) {
    amount = Math.floor(Number(amount) || 0);
    if (amount <= 0) return;
    if (!userData.stats) userData.stats = {};
    userData.stats.totalWagered = (userData.stats.totalWagered || 0) + amount;
}

// ===== КОНФИГ ИГРЫ МИНЫ =====
const gameConfig = { size: 5, mines: 3 };

// RTP (доля возврата игроку). 0.95 = казино держит 5% на КАЖДОМ шаге кэшаута —
// матожидание всегда в пользу заведения, но выплаты растут честно с риском.
// Хочешь жёстче — понизь (0.90 = казино +10%), мягче — подними (макс. держи <1.0).
// Множители мин повторяют EDGE/Stake (сетка 25 клеток, house-edge 1%):
// при 3 минах открытия дают 1.13x, 1.29x, 1.49x, 1.72x, 2.01x … (coef = RTP / вероятность выживания).
const HOUSE_RTP = 0.99;

let gameState = {
    isPlaying: false,
    currentBet: 100,
    betType: 'silver',
    currentCoefficient: 1.0,
    currentPayout: null,
    totalCells: 9,
    revealedCells: 0,
    minesLeft: 1,
    gameBoard: [],
    minesPositions: [],
    canCashOut: false
};

// ===== КОНФИГ РАКЕТКИ =====
let rocketGameState = {
    isPlaying: false,
    isRoundActive: false,
    currentCoefficient: 1.0,
    currentBet: 100,
    betType: 'silver',
    rocketPosition: 0,
    roundCountdown: 5,
    startTime: 0,
    crashPoint: 1.1,
    trailPoints: []
};

let currentNewGift = null;

// ===== СИСТЕМА ПОДАРКОВ (с редкостью) =====
// rare: 15-99 монет  |  epic: 100-499  |  legendary: 500+
const GIFT_SYSTEM = {
    gifts: [
        // ── RARE (15–99 монет) ──
        { type: 'heart',     name: 'Сердце',           tier: 'rare',      minValue: 15,  maxValue: 15,  weight: 30 },
        { type: 'bear',      name: 'Плюшевый медведь', tier: 'rare',      minValue: 15,  maxValue: 15,  weight: 30 },
        { type: 'rose',      name: 'Роза',             tier: 'rare',      minValue: 25,  maxValue: 25,  weight: 25 },
        { type: 'gift',      name: 'Подарок',          tier: 'rare',      minValue: 25,  maxValue: 25,  weight: 20 },
        // ── EPIC (100–499 монет) ──
        { type: 'cake',      name: 'Торт',             tier: 'epic',      minValue: 50, maxValue: 50, weight: 12 },
        { type: 'bouquet',   name: 'Букет',            tier: 'epic',      minValue: 50, maxValue: 50, weight: 12 },
        { type: 'rocket',    name: 'Ракета',           tier: 'epic',      minValue: 50, maxValue: 50, weight: 10 },
        { type: 'champagne', name: 'Шампанское',       tier: 'epic',      minValue: 50, maxValue: 50, weight: 8  },
        // ── LEGENDARY (500+ монет) ──
        { type: 'cup',       name: 'Кубок',            tier: 'legendary', minValue: 100, maxValue: 100, weight: 5  },
        { type: 'ring',      name: 'Кольцо',           tier: 'legendary', minValue: 100, maxValue: 100, weight: 4  },
        { type: 'diamond',   name: 'Алмаз',            tier: 'legendary', minValue: 100, maxValue: 100, weight: 2  }
    ],
    getRarity(value) {
        if (value >= 500) return 'legendary';
        if (value >= 100) return 'epic';
        if (value >= 15)  return 'rare';
        return 'common';
    },
    getRandomGift(winAmount) {
        // Подарок должен СООТВЕТСТВОВАТЬ выигрышу по диапазону цены:
        // minValue ≤ выигрыш ≤ maxValue (иначе «медведь за 15-50» выпадал на выигрыш 110).
        let eligible = this.gifts.filter(g => winAmount >= g.minValue && winAmount <= g.maxValue);
        // Если выигрыш выше всех диапазонов — берём самые дорогие подарки (по minValue).
        if (!eligible.length) {
            const byMin = this.gifts.filter(g => winAmount >= g.minValue);
            if (!byMin.length) return null;
            const topMin = Math.max(...byMin.map(g => g.minValue));
            eligible = byMin.filter(g => g.minValue === topMin);
        }
        // Взвешенный случайный выбор
        const totalWeight = eligible.reduce((s, g) => s + g.weight, 0);
        let rnd = Math.random() * totalWeight;
        for (const g of eligible) {
            rnd -= g.weight;
            if (rnd <= 0) return g;
        }
        return eligible[eligible.length - 1];
    }
};

// ===== ИНИЦИАЛИЗАЦИЯ =====
// ── ВРЕМЕННАЯ ДИАГНОСТИКА iOS: шлём имя каждого шага на /api/clientlog ДО его выполнения,
// чтобы по логу увидеть, на каком именно шаге виснет главный поток на iPhone. Убрать после дебага.
const __DIAG_ENABLED = (() => {
  try { return new URLSearchParams(location.search).get('diag') === '1'; }
  catch (e) { return false; }
})();
function __diag(step){ try{
  if (!__DIAG_ENABLED) return;
  var __w=(window.Telegram&&window.Telegram.WebApp)||null;
  var __tg=__w?('tg:'+(__w.platform||'?')+'/'+(__w.version||'?')+'/user='+(__w.initDataUnsafe&&__w.initDataUnsafe.user?'YES':'no')+'/idata='+((__w.initData||'').length)):'noTG';
  var b=JSON.stringify({ua:navigator.userAgent,stage:'STEP '+step+' '+__tg,errs:''});
  if(navigator.sendBeacon){navigator.sendBeacon('https://138-16-153-215.nip.io/api/clientlog',new Blob([b],{type:'application/json'}));}
  else{fetch('https://138-16-153-215.nip.io/api/clientlog',{method:'POST',headers:{'Content-Type':'application/json'},body:b,keepalive:true}).catch(function(){});}
}catch(e){} }
document.addEventListener('DOMContentLoaded', function() {
    try {
        __diag('0-start');
        loadUserData();               __diag('1-loadUserData-ok');
        setupEventListeners();        __diag('2-setupEventListeners-ok');
        showSection('game');          __diag('3-showSection-ok');
        updateDailyBonusButton();     __diag('4-dailyBonus-ok');
        updateRocketUI();             __diag('5-rocketUI-ok');
        updateRocketPrevRounds();     __diag('6-rocketPrev-ok');
        startRocketCountdown();       __diag('7-rocketCountdown-ok');
        updateHeaderUsername();       __diag('8-headerUsername-ok');
        simulateOnlineCounts();       __diag('9-onlineCounts-ok');
        renderCaseCards();            __diag('10-renderCaseCards-ok');
        // Сигнал для iOS safety-net (см. index.html): аппка успешно поднялась — фолбэк не нужен.
        window.__APP_BOOTED = true;
        var fb = document.getElementById('__boot_fallback');
        if (fb) fb.remove();
        __diag('post-boot visState=' + document.visibilityState + ' hidden=' + document.hidden);
        setTimeout(function(){ __diag('post-boot-alive-500ms visState=' + document.visibilityState); }, 500);
    } catch(e) {
        try{ var bb=JSON.stringify({ua:navigator.userAgent,stage:'INIT-THROW',errs:(e&&e.message||e)+' | '+((e&&e.stack||'').split('\n').slice(0,3).join(' <> '))});
             if(navigator.sendBeacon){navigator.sendBeacon('https://138-16-153-215.nip.io/api/clientlog',new Blob([bb],{type:'application/json'}));} }catch(_){}
        console.error('INIT ERROR:', e);
        // Показываем ошибку на экране для дебага
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'position:fixed;top:70px;left:0;right:0;background:#f87171;color:#fff;padding:12px;font-size:12px;z-index:99999;word-break:break-all;';
        errDiv.textContent = 'Init error: ' + e.message + ' at ' + e.stack?.split('\n')[1];
        document.body.appendChild(errDiv);
        setTimeout(() => errDiv.remove(), 10000);
    }
});

function updateHeaderUsername() {
    const tgUser = getTgUser();
    const el = document.getElementById('header-username');
    if (!el) return;
    if (tgUser) {
        el.textContent = (tgUser.username ? tgUser.username.toUpperCase() : tgUser.first_name.toUpperCase());
    } else {
        el.textContent = 'PLAYER';
    }
    // Аватарка Telegram в шапке главного меню (как в профиле)
    if (tgUser?.photo_url) {
        const img = document.getElementById('header-tg-photo');
        const em  = document.getElementById('header-avatar-emoji');
        if (img) { img.src = tgUser.photo_url; img.style.display = 'block'; }
        if (em)  { em.style.display = 'none'; }
    }
}

function simulateOnlineCounts() {
    const counts = {
        'online-rocket': [25, 45],
        'online-mines': [18, 38],
        'online-roulette': [40, 70],
        'online-cases': [10, 25]
    };
    function update() {
        for (const [id, [min, max]] of Object.entries(counts)) {
            const el = document.getElementById(id);
            if (el) {
                const n = Math.floor(Math.random() * (max - min + 1)) + min;
                el.textContent = n + ' ОНЛАЙН';
            }
        }
    }
    update();
    setInterval(update, 8000);
}

function loadUserData() {
    const saved = DB.get('userData');
    if (saved) userData = Object.assign(getDefaultUserData(), saved);
    if (!userData.serverTaskClaims || typeof userData.serverTaskClaims !== 'object') userData.serverTaskClaims = {};
    userData.lastVisit = new Date().toISOString();
    saveUserData();
    updateBalance();
    updateStats();
    updateTasks();
    updateProfileInfo();
    updateGameHistory();
    updateCasesHistory();
    // Серверный bootstrap запускается только после появления подписанной Telegram-
    // идентичности в refreshTgUser(). Иначе при раннем WebView-инжекте он выполнялся
    // дважды: здесь и ещё раз в refreshTgUser(), повторно перерисовывая инвентарь.
}

// Автоприём NFT: подарки, которые юзер прислал боту, бот принял и записал на сервере —
// подтягиваем их в инвентарь и помечаем забранными, чтобы не задваивать.
async function pullNftDeposits() {
    try {
        const userId = tg?.initDataUnsafe?.user?.id;
        if (!userId) return;
        const initData = await waitForTelegramInitData();
        const authHeaders = initData ? { 'X-Telegram-Init-Data': initData } : {};
        const r = await fetch(BACKEND_URL + '/nft_deposits?user_id=' + userId, { headers: authHeaders });
        if (!r.ok) return;
        const d = await r.json();
        const deps = (d && d.deposits) || [];
        if (!deps.length) return;
        // Claim first on the server. The old client-side temporary row was
        // not saleable because it had no matching gift_inventory record.
        const serverClaimIds = deps.map(dep => Number(dep.id)).filter(Number.isSafeInteger);
        const serverClaimResponse = await fetch(BACKEND_URL + '/nft_deposits/claim', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ user_id: userId, ids: serverClaimIds })
        });
        if (!serverClaimResponse.ok) return;
        await syncServerInventory();
        if (typeof showNotif === 'function' && deps.length)
            showNotif('🎁 Принят подарок: ' + deps.map(x => x.name).join(', '), 'success');
        return;
        // Помечаем забранными на сервере
        if (typeof showNotif === 'function' && deps.length)
            showNotif('🎁 Принят подарок: ' + deps.map(x => x.name).join(', '), 'success');
    } catch (e) { /* тихо — не критично для старта */ }
}

function saveUserData() {
    DB.set('userData', userData);
    // Backup inventory count to detect loss
    try {
        const invCount = (userData.inventory || []).length;
        DB.set('invCount', invCount);
    } catch(e) {}
    // Сохраняем локальный UI-кеш и только немонетарное состояние на сервере.
    // Баланс никогда не отправляется обратно как authoritative значение.
    pushStateToServer();
}

// ===== СОХРАНЕНИЕ СОСТОЯНИЯ НА СЕРВЕР (D1) =====
let serverSynced = false;   // true после первой загрузки состояния с сервера
let serverSyncInFlight = false;
let serverBalanceRevision = 0;
let balanceMutationVersion = 0;
let _pushTimer = null;
function pushStateToServer() {
    if (!serverSynced) return;
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) return;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => {
        // Balance and inventory are server-owned. Persist only non-monetary UI state.
        const stateForServer = JSON.parse(JSON.stringify(userData));
        delete stateForServer.balance;
        delete stateForServer.inventory;
        delete stateForServer.balance_revision;
        fetch(BACKEND_URL + '/save_state', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ user_id: userId, data: JSON.stringify(stateForServer) })
        }).catch(()=>{});
    }, 500);
    return;
}

function parseAuthoritativeBalanceValue(value) {
    const number = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function readAuthoritativeBalanceSnapshot(data) {
    const balance = data && data.balance && typeof data.balance === 'object' ? data.balance : (data || {});
    const gold = parseAuthoritativeBalanceValue(balance.gold_coins ?? balance.gold);
    const silver = parseAuthoritativeBalanceValue(balance.silver_coins ?? balance.silver);
    const revision = parseAuthoritativeBalanceValue(data?.balance_revision ?? data?.revision ?? balance.balance_revision);
    return gold === null || silver === null ? null : { gold, silver, revision };
}

// ===== СИНХРОНИЗАЦИЯ ЗОЛОТА С TELEGRAM CLOUDSTORAGE =====
function syncGoldFromCloud() {
    // Balance-like deep-link parameters are untrusted input. The only source
    // of a balance snapshot is the authenticated /balance or mutation response.
    return false;
}

function showGoldSyncNotif(gold) {
    showNotif(`🟡 Баланс обновлён: ${gold} коинов`, '#f59e0b');
}

function showNotif(text, color = '#8b5cf6') {
    const notif = document.createElement('div');
    notif.style.cssText = `
        position:fixed;top:20px;left:50%;transform:translateX(-50%);
        background:${color};
        color:#fff;padding:12px 22px;border-radius:14px;
        font-weight:800;font-size:0.9rem;z-index:9999;
        box-shadow:0 8px 30px rgba(0,0,0,0.5);
        text-align:center;white-space:nowrap;
        animation:notifSlide .3s ease;
    `;
    notif.textContent = text;
    // CSS анимация
    if (!document.getElementById('notif-style')) {
        const s = document.createElement('style');
        s.id = 'notif-style';
        s.textContent = '@keyframes notifSlide{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}';
        document.head.appendChild(s);
    }
    document.body.appendChild(notif);
    setTimeout(() => { notif.style.opacity = '0'; notif.style.transition = 'opacity .3s'; setTimeout(() => notif.remove(), 300); }, 2500);
}

// ===== ОБРАБОТЧИКИ СОБЫТИЙ =====
function setupEventListeners() {
    // Кнопки размера поля мин — ТОЛЬКО те, у которых есть data-size.
    // Раньше селектор ловил ВСЕ .mines-toggle (валюта ракетки/кейсов, пресеты ставок),
    // и клик по такой кнопке писал gameConfig.size = parseInt(undefined) = NaN,
    // из-за чего счётчик мин показывал NaN и не давал выбирать количество.
    document.querySelectorAll('.mines-toggle[data-size]').forEach(btn => {
        btn.addEventListener('click', function() {
            const s = parseInt(this.dataset.size);
            if (!s) return;
            document.querySelectorAll('.mines-toggle[data-size]').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            gameConfig.size = s;
            // При смене поля нормализуем число мин под новый максимум
            const maxMines = Math.max(1, gameConfig.size * gameConfig.size - 1);
            gameConfig.mines = Math.max(1, Math.min(maxMines, parseInt(gameConfig.mines) || 1));
            updateCoefficients();
        });
    });
    // Старые кнопки (совместимость)
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            gameConfig.size = parseInt(this.dataset.size);
            updateCoefficients();
        });
    });
    document.querySelectorAll('.mine-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.mine-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            gameConfig.mines = parseInt(this.dataset.mines);
            updateCoefficients();
        });
    });
}

// ===== НАВИГАЦИЯ =====
function showSection(section) {
    const el = document.getElementById('welcome');
    if (el) el.style.display = 'none';
    // Если пользователь был внутри игры и уходит через нижнее меню —
    // сбрасываем полноэкранный игровой режим, иначе список игр останется
    // скрытым и экран «Играть» окажется пустым (игра не запускается).
    if (document.body.classList.contains('game-open')) {
        backToGamesList();
    }
    ['game-section','profile-section','tasks-section','inventory-section'].forEach(id => {
        const s = document.getElementById(id);
        if (s) s.classList.remove('active-section');
    });
    // Форсируем тёмный фон на body и html (Telegram может перебивать)
    document.body.style.setProperty('background','#000','important');
    document.body.style.setProperty('background-color','#000','important');
    document.documentElement.style.setProperty('background','#000','important');
    document.querySelectorAll('.nav-button').forEach(b => b.classList.remove('active-btn'));

    // Восстановить нижнюю навигацию и скрыть кнопку назад
    const nav = document.querySelector('.navigation');
    if (nav) nav.style.bottom = '';
    const backBtn = document.getElementById('global-back-btn');
    if (backBtn) backBtn.style.display = 'none';

    if (section === 'game') {
        document.getElementById('game-section').classList.add('active-section');
        const n = document.getElementById('nav-game'); if(n) n.classList.add('active-btn');
    } else if (section === 'profile') {
        document.getElementById('profile-section').classList.add('active-section');
        const n = document.getElementById('nav-profile'); if(n) n.classList.add('active-btn');
        updateStats();
        updateProfileInfo();
        updateProfileGifts();
    } else if (section === 'tasks') {
        document.getElementById('tasks-section').classList.add('active-section');
        const n = document.getElementById('nav-tasks'); if(n) n.classList.add('active-btn');
        if (typeof loadChannelTasks === 'function') loadChannelTasks();
    } else if (section === 'inventory') {
        const invSec = document.getElementById('inventory-section');
        invSec.classList.add('active-section');
        invSec.style.setProperty('background','#0d0d1a','important');
        invSec.style.setProperty('color','#fff','important');
        const n = document.getElementById('nav-inventory'); if(n) n.classList.add('active-btn');
        setTimeout(updateInventory, 30);
    } else if (section === 'rating') {
        // Rating section placeholder
        const n = document.getElementById('nav-rating'); if(n) n.classList.add('active-btn');
    }
}

function _createGameHeader(gameName) {
    const existing = document.getElementById('game-mini-header');
    if (existing) existing.remove();

    const gold   = userData.balance.gold   || 0;
    const silver = userData.balance.silver || 0;

    const h = document.createElement('div');
    h.id = 'game-mini-header';
    h.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:600;
        background:rgba(10,10,20,0.95);
        backdrop-filter:blur(12px);
        border-bottom:1px solid rgba(123,92,255,0.2);
        display:flex;align-items:center;
        padding:10px 14px;gap:10px;
        box-shadow:0 2px 20px rgba(0,0,0,0.5);
    `;
    h.innerHTML = `
        <button onclick="backToGamesList()" style="
            width:36px;height:36px;border-radius:50%;border:none;
            background:rgba(123,92,255,0.15);color:#fff;
            font-size:1.1rem;cursor:pointer;flex-shrink:0;
            display:flex;align-items:center;justify-content:center;">←</button>
        <div style="font-size:0.78rem;font-weight:800;color:#fff;flex:1;letter-spacing:0.5px;">${gameName.toUpperCase()}</div>
        <div style="display:flex;align-items:center;gap:8px;">
            <div style="display:flex;align-items:center;gap:4px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:5px 10px;">
                <span style="font-size:0.65rem;font-weight:900;color:#fbbf24;">🟡</span>
                <span id="gmh-gold" style="font-size:0.8rem;font-weight:800;color:#fbbf24;">${gold}</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:5px 10px;">
                <span style="font-size:0.65rem;font-weight:900;color:#c084fc;">F</span>
                <span id="gmh-silver" style="font-size:0.8rem;font-weight:800;color:#c084fc;">${silver}</span>
            </div>
        </div>
    `;
    document.body.appendChild(h);
}

function _removeGameHeader() {
    const el = document.getElementById('game-mini-header');
    if (el) el.remove();
}

// Патчим updateBalance чтобы обновлял и мини-хедер
function legacyUpdateBalanceWithHeader() {
    const _origUpdateBalance = typeof updateBalance === 'function' ? updateBalance : null;
    if (_origUpdateBalance) _origUpdateBalance();
    const gmhGold   = document.getElementById('gmh-gold');
    const gmhSilver = document.getElementById('gmh-silver');
    if (gmhGold)   gmhGold.textContent   = userData.balance.gold   || 0;
    if (gmhSilver) gmhSilver.textContent = userData.balance.silver || 0;
}

function selectGame(game) {
    const gameSection = document.getElementById('game-section');
    const cardsList = gameSection ? gameSection.querySelector('.game-cards-list') : null;
    const title = gameSection ? gameSection.querySelector('.game-section-title') : null;
    if (cardsList) cardsList.style.display = 'none';
    if (title) title.style.display = 'none';

    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';

    document.querySelectorAll('.game-container').forEach(el => el.style.display = 'none');

    const target = document.getElementById(game + '-game');
    if (target) {
        target.style.display = 'block';
        target.classList.add('game-fullscreen');
        target.style.paddingTop = '58px';
    }

    document.body.classList.add('game-open');
    const nav = document.querySelector('.navigation');
    if (nav) nav.style.bottom = '-120px';
    const backBtn = document.getElementById('global-back-btn');
    if (backBtn) backBtn.style.display = 'none'; // скрываем старую кнопку

    // Скрываем back-to-list-btn внутри игры (у нас теперь хедер)
    document.querySelectorAll('.back-to-list-btn, .game-screen-header').forEach(el => el.style.display = 'none');

    const names = { rocket: 'Ракетка', mines: 'Мины', cases: 'Кейсы' };
    _createGameHeader(names[game] || game);
    if (game === 'cases') refreshFreeCaseCooldown();
}

function backToGamesList() {
    document.querySelectorAll('.game-container').forEach(el => {
        el.style.display = 'none';
        el.classList.remove('game-fullscreen');
        el.style.paddingTop = '';
    });
    document.querySelectorAll('.back-to-list-btn, .game-screen-header').forEach(el => el.style.display = '');

    const gameSection = document.getElementById('game-section');
    const cardsList = gameSection ? gameSection.querySelector('.game-cards-list') : null;
    const title = gameSection ? gameSection.querySelector('.game-section-title') : null;
    if (cardsList) cardsList.style.display = '';
    if (title) title.style.display = '';

    const header = document.querySelector('.header');
    if (header) header.style.display = '';

    document.body.classList.remove('game-open');
    const nav = document.querySelector('.navigation');
    if (nav) nav.style.bottom = '';
    const backBtn = document.getElementById('global-back-btn');
    if (backBtn) backBtn.style.display = 'none';

    _removeGameHeader();
}

// ===== БЕЗОПАСНЫЕ ХЕЛПЕРЫ =====
function $id(id) { return document.getElementById(id); }
function setText(id, val) { const el = $id(id); if (el) el.textContent = val; }
function setHTML(id, html) { const el = $id(id); if (el) el.innerHTML = html; }

// ===== БАЛАНС =====
function updateBalance() {
    const gold = userData.balance.gold;
    const silver = userData.balance.silver;
    setText('header-gold-flip', gold);
    setText('header-silver-flip', silver);
    setHTML('game-balance',    `${silver} <span class="coin-symbol silver">F</span>`);
    setHTML('current-balance', `${silver} <span class="coin-symbol silver">F</span>`);
    setHTML('user-balance',    `${silver} <span class="coin-symbol silver">F</span>`);
    setText('user-gold-flip',  gold);
    setText('user-silver-flip',silver);
    setHTML('rocket-balance',  `${silver} <span class="coin-symbol silver">F</span>`);
    setText('cases-balance-val', silver);
    setText('cases-gold-val', gold);
    // Новый дизайн мины
    setText('game-balance-val', silver);
    // Мини-хедер внутри игры (ракетка/мины/кейсы) — обновляем в реальном времени
    const gmhGold   = document.getElementById('gmh-gold');
    const gmhSilver = document.getElementById('gmh-silver');
    if (gmhGold)   gmhGold.textContent   = gold;
    if (gmhSilver) gmhSilver.textContent = silver;
    checkBetValidity();
}

// ===== СТАВКИ МИНЫ =====
function checkBetValidity() {
    const bet = gameState.currentBet;
    const balance = userData.balance[gameState.betType];
    const warning = $id('balance-warning');
    const playBtn = $id('play-btn');
    if (!warning || !playBtn) return;
    if (bet < MIN_GAME_STAKE || bet > balance) {
        warning.style.display = 'flex';
        warning.textContent = bet < MIN_GAME_STAKE ? `Минимальная ставка — ${MIN_GAME_STAKE}` : 'Недостаточно средств!';
        playBtn.disabled = true;
        playBtn.style.opacity = '0.5';
    } else {
        warning.style.display = 'none';
        playBtn.disabled = false;
        playBtn.style.opacity = '1';
    }
}

function updateBetDisplay() {
    setText('current-bet', gameState.currentBet);
    const win = Math.floor(gameState.currentBet * gameState.currentCoefficient);
    setText('potential-win', win);
    // Новый дизайн
    const inp = document.getElementById('mines-bet-input');
    if (inp) inp.value = gameState.currentBet;
    setText('potential-win-new', win + ' F');
    checkBetValidity();
}

function changeBet(amount) {
    gameState.currentBet = Math.max(MIN_GAME_STAKE, gameState.currentBet + amount);
    updateBetDisplay();
}

function setBet(amount) {
    gameState.currentBet = Math.max(MIN_GAME_STAKE, amount);
    updateBetDisplay();
}

// Новые функции управления для нового дизайна
function minesBetInputChange(val) {
    gameState.currentBet = Math.max(MIN_GAME_STAKE, parseInt(val) || MIN_GAME_STAKE);
    updateBetDisplay();
}

function minesSetMax() {
    gameState.currentBet = Math.max(MIN_GAME_STAKE, userData.balance[gameState.betType]);
    updateBetDisplay();
}

function mineCountChange(delta) {
    // Защита от NaN: если size/mines где-то испортились — восстанавливаем валидные значения.
    const size = parseInt(gameConfig.size) || 3;
    gameConfig.size = size;
    const maxMines = Math.max(1, size * size - 1);
    const cur = parseInt(gameConfig.mines) || 1;
    gameConfig.mines = Math.max(1, Math.min(maxMines, cur + delta));
    setText('mines-count-display', gameConfig.mines);
    updateCoefficients();
}

function updateCoefficients() {
    // Нормализуем значения, чтобы дисплей никогда не показывал NaN
    gameConfig.size  = parseInt(gameConfig.size)  || 3;
    gameConfig.mines = parseInt(gameConfig.mines) || 1;
    const sizeCoef  = { 3: 1.2, 5: 1.5 };
    const minesCoef = { 1: 1.35, 2: 1.8, 3: 2.2, 5: 3.0 };
    const sc = sizeCoef[gameConfig.size]   || 1.5;
    const mc = minesCoef[gameConfig.mines] || 2.0;
    gameState.baseCoefficient = sc * mc;
    // До начала игры показываем 1.00
    if (!gameState.isPlaying) {
        gameState.currentCoefficient = 1.00;
    }
    setText('size-coef',  sc + 'x');
    setText('mine-coef',  mc + 'x');
    setText('total-coef', fixedNumber(gameState.currentCoefficient, 1) + 'x');
    setText('mines-count-display', gameConfig.mines);
    updateBetDisplay();
}

// ===== ИГРА МИНЫ =====
function legacyStartGame() {
    // Нормализуем состояние — на некоторых устройствах size/mines приходили строкой,
    // а balance/betType могли быть не заданы → игра «не запускалась».
    if (!userData.balance) userData.balance = { gold: 0, silver: 0 };
    if (gameState.betType !== 'gold' && gameState.betType !== 'silver') gameState.betType = 'silver';
    gameConfig.size  = parseInt(gameConfig.size)  || 3;
    gameConfig.mines = parseInt(gameConfig.mines) || 1;
    const bet = Math.floor(Number(gameState.currentBet) || 0);
    gameState.currentBet = bet;
    const bal = Number(userData.balance[gameState.betType]) || 0;
    if (bet < MIN_GAME_STAKE) { alert(`Минимальная ставка — ${MIN_GAME_STAKE}`); return; }
    if (bet > bal) {
        alert('Недостаточно средств!'); return;
    }
    if (gameConfig.mines >= gameConfig.size * gameConfig.size) {
        alert('Слишком много мин!'); return;
    }
    // Сначала СТРОИМ и ПОКАЗЫВАЕМ поле — и только при успехе списываем ставку.
    // Иначе при ошибке рендера деньги спишутся, а игры не будет (баг «списало и не дало играть»).
    try {
        gameState.isPlaying = true;
        gameState.currentCoefficient = 1.00;
        // Инициализируем baseCoefficient чтобы не было NaN
        const sizeCoef  = { 3: 1.2, 5: 1.5 };
        const minesCoef = { 1: 1.35, 2: 1.8, 3: 2.2, 5: 3.0 };
        gameState.baseCoefficient = (sizeCoef[gameConfig.size] || 1.5) * (minesCoef[gameConfig.mines] || 2.0);
        gameState.totalCells = gameConfig.size * gameConfig.size;
        gameState.revealedCells = 0;
        gameState.survivalProb = 1;
        gameState.minesLeft = gameConfig.mines;
        gameState.gameBoard = [];
        gameState.minesPositions = [];
        gameState.canCashOut = false;

        createGameBoard();
        placeMines();

        const board = $id('game-board');
        const minesGame = $id('mines-game');
        const settings = minesGame ? minesGame.querySelector('.mines-settings-new') || minesGame.querySelector('.game-settings') : null;
        if (!board) throw new Error('game-board not found');
        board.classList.remove('hidden');
        if (settings) settings.style.display = 'none';

        updateGameInterface();
        const cb = $id('cashout-btn'); if (cb) cb.disabled = true;
    } catch (e) {
        // Поле не построилось — ставку НЕ списываем, откатываем состояние
        gameState.isPlaying = false;
        console.error('startGame failed:', e);
        alert('Не удалось запустить игру (' + (e && e.message ? e.message : 'ошибка') + '). Ставка не списана.');
        return;
    }

    // Поле успешно показано — теперь списываем ставку
    // Legacy local money mutation removed; Telegram games use /game/mines/start.
    if (gameState.betType === 'silver') addWager(bet);
    saveUserData();
    updateBalance();
}

function createGameBoard() {
    const grid = $id('mines-grid');
    if (!grid) throw new Error('mines-grid not found');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${gameConfig.size}, 1fr)`;
    // Адаптируем размер эмодзи под размер поля
    const fontSize = gameConfig.size <= 3 ? '2rem' : gameConfig.size <= 5 ? '1.5rem' : '1rem';
    grid.style.fontSize = fontSize;
    gameState.gameBoard = [];
    for (let i = 0; i < gameState.totalCells; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.index = i;
        cell.innerHTML = minesCellIconHTML();
        cell.addEventListener('click', () => revealCell(i));
        grid.appendChild(cell);
        gameState.gameBoard.push({ isMine: false, isRevealed: false, element: cell });
    }
}

// Иконка-обложка клетки мин: случайный NFT-токен вместо флип-коина
function minesCellIconHTML() {
    try {
        if (typeof NFT_GIFTS !== 'undefined' && NFT_GIFTS.length) {
            const g = NFT_GIFTS[Math.floor(Math.random() * NFT_GIFTS.length)];
            return '<img class="cell-nft-img" src="' + g.img + '" alt="">';
        }
    } catch (e) {}
    return '<span class="cell-f-letter">F</span>';
}

function placeMines() {
    const positions = new Set();
    while (positions.size < gameConfig.mines) {
        const pos = Math.floor(Math.random() * gameState.totalCells);
        positions.add(pos);
    }
    positions.forEach(pos => {
        gameState.gameBoard[pos].isMine = true;
        gameState.minesPositions.push(pos);
    });
}

function legacyRevealCell(index) {
    if (!gameState.isPlaying || gameState.gameBoard[index].isRevealed) return;
    const cell = gameState.gameBoard[index];
    cell.isRevealed = true;
    cell.element.classList.add('revealed');

    if (cell.isMine) {
        cell.element.classList.add('mine');
        endGameLose();
    } else {
        cell.element.classList.add('safe');
        gameState.revealedCells++;
        gameState.canCashOut = true;
        // Честный house-edge: коэффициент = RTP / вероятность_выживания.
        // Вероятность, что ЭТА клетка безопасна = (осталось безопасных)/(осталось клеток).
        const safeCells = gameState.totalCells - gameConfig.mines;
        const alreadySafe = gameState.revealedCells - 1; // до этого клика
        const cellsLeft = gameState.totalCells - alreadySafe;
        const safeLeft  = safeCells - alreadySafe;
        gameState.survivalProb = (gameState.survivalProb || 1) * (safeLeft / cellsLeft);
        gameState.currentCoefficient = Math.max(HOUSE_RTP / gameState.survivalProb, 1.00);
        const cb = $id('cashout-btn');
        if (cb) cb.disabled = false;
        updateGameInterface();

        if (gameState.revealedCells >= safeCells) endGameWin();
    }
}

function updateGameInterface() {
    setText('current-coef', fixedNumber(gameState.currentCoefficient, 1) + 'x');
    const serverPayout = Number(gameState.currentPayout);
    const win = gameState.currentPayout !== null && Number.isFinite(serverPayout)
        ? Math.max(0, Math.floor(serverPayout))
        : Math.floor(gameState.currentBet * gameState.currentCoefficient);
    setText('current-win', win);
    setText('mines-left', gameState.minesLeft);
}

function legacyCashOut() {
    if (!gameState.isPlaying || !gameState.canCashOut) return;
    const win = Math.floor(gameState.currentBet * gameState.currentCoefficient);
    // Если выпадает подарок/NFT — деньги здесь НЕ начисляем: их выдаст модалка выбора
    // (продать → value на баланс, либо забрать → NFT в инвентарь + остаток).
    // Раньше был баг: win начислялся сразу И модалка начисляла ещё раз (двойное).
    const giftPrize = (win >= 15) ? GIFT_SYSTEM.getRandomGift(win) : null;
    // Legacy local payout removed; Telegram games settle on the backend.
    userData.stats.gamesPlayed++; userData.stats.minesPlayed=(userData.stats.minesPlayed||0)+1;
    userData.stats.gamesWon++;
    userData.stats.totalWon += win;
    userData.consecutiveWins = (userData.consecutiveWins || 0) + 1;
    if (gameState.currentCoefficient > userData.stats.maxCoefficient)
        userData.stats.maxCoefficient = gameState.currentCoefficient;
    saveUserData();
    updateBalance();
    updateStats();
    addToGameHistory(true, gameState.currentBet, win, gameState.currentCoefficient);
    updateTasks();
    gameState.isPlaying = false;
    revealAllMines();
    if (giftPrize) {
        setTimeout(() => showGiftChoiceModal(giftPrize, win), 800);
    } else if (win > 0) {
        setTimeout(() => showCoinWinModal(win, gameState.betType), 800);
    }
    setTimeout(newGame, 1500);
}

function endGameLose() {
    gameState.isPlaying = false;
    userData.stats.gamesPlayed++;
    userData.stats.gamesLost++;
    userData.consecutiveWins = 0;
    saveUserData();
    updateStats();
    addToGameHistory(false, gameState.currentBet, 0, gameState.currentCoefficient);
    updateTasks();
    revealAllMines();
    setTimeout(newGame, 1500);
}

function endGameWin() {
    const win = Math.floor(gameState.currentBet * gameState.currentCoefficient);
    // Подарок/NFT — деньги начисляет модалка выбора, не здесь (иначе двойное начисление).
    const giftPrize = (win >= 15) ? GIFT_SYSTEM.getRandomGift(win) : null;
    // Legacy local payout removed; Telegram games settle on the backend.
    userData.stats.gamesPlayed++;
    userData.stats.gamesWon++;
    userData.stats.totalWon += win;
    userData.consecutiveWins = (userData.consecutiveWins || 0) + 1;
    if (gameState.currentCoefficient > userData.stats.maxCoefficient)
        userData.stats.maxCoefficient = gameState.currentCoefficient;
    saveUserData();
    updateBalance();
    updateStats();
    addToGameHistory(true, gameState.currentBet, win, gameState.currentCoefficient);
    updateTasks();
    gameState.isPlaying = false;
    if (giftPrize) {
        setTimeout(() => showGiftChoiceModal(giftPrize, win), 800);
    } else if (win > 0) {
        setTimeout(() => showCoinWinModal(win, gameState.betType), 800);
    }
    setTimeout(newGame, 1500);
}

function revealAllMines() {
    gameState.minesPositions.forEach(pos => {
        const cell = gameState.gameBoard[pos];
        if (cell && !cell.isRevealed) {
            cell.element.classList.add('revealed','mine');
        }
    });
}

function newGame() {
    gameState.isPlaying = false;
    gameState.currentPayout = null;
    const board = $id('game-board');
    const minesGame = $id('mines-game');
    const settings = minesGame ? minesGame.querySelector('.mines-settings-new') || minesGame.querySelector('.game-settings') : null;
    if (board) board.classList.add('hidden');
    if (settings) settings.style.display = 'flex';
    updateBetDisplay();
    updateBalance();
}

function endGame() { newGame(); }

function addToGameHistory(isWin, bet, win, coef) {
    userData.gameHistory.unshift({
        timestamp: new Date().toISOString(), bet, win,
        payout: win,
        profit: isWin ? win - bet : -bet,
        coefficient: coef, isWin
    });
    if (userData.gameHistory.length > 20)
        userData.gameHistory = userData.gameHistory.slice(0, 20);
    saveUserData();
    updateGameHistory();
}

function openHistoryModal(game) {
    const modal = document.getElementById('history-modal');
    const mines = document.getElementById('history-list');
    const rocket = document.getElementById('rocket-history-list');
    const title = document.getElementById('history-modal-title');
    if (!modal) return;
    if (game === 'rocket') {
        if (mines) mines.style.display = 'none';
        if (rocket) rocket.style.display = 'flex';
        if (title) title.innerHTML = '<i class="fas fa-history"></i> История — Ракетка';
        if (typeof updateRocketHistory === 'function') updateRocketHistory();
    } else {
        if (rocket) rocket.style.display = 'none';
        if (mines) mines.style.display = 'flex';
        if (title) title.innerHTML = '<i class="fas fa-history"></i> История — Мины';
        if (typeof updateGameHistory === 'function') updateGameHistory();
    }
    modal.classList.add('open');
}

function closeHistoryModal() {
    const modal = document.getElementById('history-modal');
    if (modal) modal.classList.remove('open');
}

function updateGameHistory() {
    const list = $id('history-list');
    if (!list) return;
    list.innerHTML = '';
    (userData.gameHistory || []).slice(0, 30).forEach(game => {
        const d = new Date(game.timestamp);
        const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const item = document.createElement('div');
        item.className = `history-item ${game.isWin ? 'win' : 'lose'}`;
        const payout = Math.max(0, Math.floor(Number(game.payout ?? game.win) || 0));
        const profit = Math.floor(Number(game.profit ?? (game.isWin ? payout - game.bet : -game.bet)) || 0);
        const outcome = game.isWin ? `+${payout}F` : `-${game.bet}F`;
        const note = game.isWin ? ` <small title="Чистая прибыль">(чистыми ${profit >= 0 ? '+' : ''}${profit}F)</small>` : '';
        item.innerHTML = `<span>${time}</span><span>Ставка: ${game.bet}F</span><span>${outcome}${note}</span><span>${fixedNumber(game.coefficient, 1)}x</span>`;
        list.appendChild(item);
    });
}

// ===== РАКЕТКА =====
function updateRocketUI() {
    setText('rocket-current-bet', rocketGameState.currentBet);
    const inp = $id('rocket-bet-input');
    if (inp) inp.value = rocketGameState.currentBet;
    checkRocketBetValidity();
    updateRocketHistory();
}

function checkRocketBetValidity() {
    const bet = rocketGameState.currentBet;
    const balance = userData.balance[rocketGameState.betType];
    const w1 = $id('rocket-balance-warning');
    const w2 = $id('rocket-balance-warning2');
    const tooLow = bet < MIN_GAME_STAKE || bet > balance;
    if (w1) w1.style.display = tooLow ? 'block' : 'none';
    if (w2) w2.style.display = tooLow ? 'block' : 'none';
}

function changeRocketBet(amount) {
    rocketGameState.currentBet = Math.max(MIN_GAME_STAKE, rocketGameState.currentBet + amount);
    const inp = document.getElementById('rocket-bet-input');
    if (inp) inp.value = rocketGameState.currentBet;
    updateRocketUI();
}

function setRocketBet(amount) {
    rocketGameState.currentBet = Math.max(MIN_GAME_STAKE, amount);
    const inp = document.getElementById('rocket-bet-input');
    if (inp) inp.value = rocketGameState.currentBet;
    // Обновляем дисплей в шторке
    const betDisp = document.getElementById('rocket-bet-display');
    const winDisp = document.getElementById('rocket-win-display');
    const curr = rocketGameState.betType === 'gold' ? 'G' : 'F';
    if (betDisp) betDisp.textContent = amount + ' ' + curr;
    if (winDisp) winDisp.textContent = (amount * 2) + ' ' + curr;
    updateRocketUI();
}

function setRocketCurrency(type) {
    rocketGameState.betType = type;
    // Обновляем дисплей
    setRocketBet(rocketGameState.currentBet);
    const silver = document.getElementById('rocket-currency-silver');
    const gold   = document.getElementById('rocket-currency-gold');
    if (silver && gold) {
        if (type === 'silver') {
            silver.style.borderColor = '#7b5cff';
            silver.style.background  = 'rgba(123,92,255,0.25)';
            silver.style.color = '#fff';
            gold.style.borderColor = '#2a2a3a';
            gold.style.background  = '#1a1a2a';
            gold.style.color = '#aaa';
        } else {
            gold.style.borderColor = '#f59e0b';
            gold.style.background  = 'rgba(245,158,11,0.2)';
            gold.style.color = '#fcd34d';
            silver.style.borderColor = '#2a2a3a';
            silver.style.background  = '#1a1a2a';
            silver.style.color = '#aaa';
        }
    }
    checkRocketBetValidity();
}

function setMinesCurrency(type) {
    gameState.betType = type;
    const silver = document.getElementById('mines-currency-silver');
    const gold   = document.getElementById('mines-currency-gold');
    if (!silver || !gold) return;
    if (type === 'silver') {
        silver.style.borderColor = '#7b5cff';
        silver.style.background  = 'rgba(123,92,255,0.2)';
        const sF = silver.querySelector('span:first-child');
        const sL = silver.querySelectorAll('span')[1];
        if (sF) { sF.style.color = '#c084fc'; sF.style.textShadow = '0 0 12px rgba(192,132,252,0.9)'; }
        if (sL) sL.style.color = '#c084fc';
        gold.style.borderColor = '#2a2a3a';
        gold.style.background  = 'rgba(255,255,255,0.05)';
        const gF = gold.querySelector('span:first-child');
        const gL = gold.querySelectorAll('span')[1];
        if (gF) { gF.style.color = '#f0a500'; gF.style.textShadow = '0 0 8px rgba(240,165,0,0.3)'; }
        if (gL) gL.style.color = '#aaa';
    } else {
        gold.style.borderColor = '#f59e0b';
        gold.style.background  = 'rgba(245,158,11,0.15)';
        const gF = gold.querySelector('span:first-child');
        const gL = gold.querySelectorAll('span')[1];
        if (gF) { gF.style.color = '#fcd34d'; gF.style.textShadow = '0 0 14px rgba(252,211,77,0.9)'; }
        if (gL) gL.style.color = '#fcd34d';
        silver.style.borderColor = '#2a2a3a';
        silver.style.background  = 'rgba(255,255,255,0.05)';
        const sF = silver.querySelector('span:first-child');
        const sL = silver.querySelectorAll('span')[1];
        if (sF) { sF.style.color = '#c084fc'; sF.style.textShadow = '0 0 8px rgba(192,132,252,0.3)'; }
        if (sL) sL.style.color = '#aaa';
    }
}

function openRocketBetSheet() {
    if (rocketGameState.isRoundActive) return; // нельзя ставить во время раунда
    const sheet = $id('rocket-bet-sheet');
    if (sheet) sheet.style.display = 'block';
    updateRocketUI();
}

function closeRocketBetSheet(e) {
    const sheet = $id('rocket-bet-sheet');
    if (sheet && (!e || e.target === sheet)) sheet.style.display = 'none';
}

function confirmRocketBet() {
    closeRocketBetSheet();
    startRocketGame();
}

function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.42) return 1.0 + Math.random() * 0.2;
    if (r < 0.68) return 1.2 + Math.random() * 0.3;
    if (r < 0.85) return 1.5 + Math.random() * 1.0;
    if (r < 0.94) return 2.5 + Math.random() * 2.5;
    if (r < 0.985) return 5.0 + Math.random() * 5.0;
    return 10.0 + Math.random() * 40.0;
}

function legacyStartRocketGame() {
    if (rocketGameState.isRoundActive) return;
    if (rocketGameState.currentBet > userData.balance[rocketGameState.betType]) {
        alert('Недостаточно средств!'); return;
    }
    // Legacy local money mutation removed; Telegram games use /game/rocket/start.
    if (rocketGameState.betType === 'silver') addWager(rocketGameState.currentBet);
    saveUserData();
    updateBalance();

    rocketGameState.isPlaying = true;
    rocketGameState.isRoundActive = true;
    rocketGameState.currentCoefficient = 1.0;
    rocketGameState.startTime = Date.now();
    rocketGameState.crashPoint = generateCrashPoint();

    // Кнопка → "Забрать"
    const playBtn = $id('rocket-play-btn');
    const cashBtn = $id('rocket-cashout-btn');
    if (playBtn) playBtn.style.display = 'none';
    if (cashBtn) {
        cashBtn.style.display = 'block';
        cashBtn.textContent = `ЗАБРАТЬ ×${fixedNumber(rocketGameState.currentCoefficient, 1)}`;
    }

    animateRocket();

    // Минимум 1200 мс полёта — иначе на низком крэше (≈1.0×) кнопка «Забрать» рушится
    // раньше, чем игрок успевает по ней тапнуть (баг «ракетка не нажимается»).
    // t = log(crashPoint) / log(1.10). Момент краша проверяется В КАДРЕ анимации
    // (см. animate), а не отдельным setTimeout — иначе таймер краша обгонял отрисовку,
    // кнопка «Забрать» оставалась видимой лишний кадр и тап в этот миг терялся
    // (жалоба «иногда нельзя забрать деньги»). Теперь краш и скрытие кнопки атомарны.
    rocketGameState._crashAtMs = Math.max(Math.log(rocketGameState.crashPoint) / Math.log(1.10) * 1000, 1200);
}

function animateRocket() {
    const rocketEl = $id('rocket-emoji');
    const cvs      = $id('rocket-canvas');
    const ctx      = cvs ? cvs.getContext('2d') : null;
    if (!rocketEl || !cvs) return;

    cvs.width  = cvs.offsetWidth  || cvs.parentElement.offsetWidth || 400;
    cvs.height = cvs.offsetHeight || 340;
    const W = cvs.width;
    const H = cvs.height;

    rocketEl.style.display = 'block';
    rocketEl.style.opacity = '1';
    rocketGameState.trailPoints = [];

    let lastElapsed = 0;

    // Ракета на экране всегда в этой точке (25% ширины, 75% высоты)
    const rocketPctX = 0.50;
    const rocketPctY = 0.50;

    // Мировые координаты растут: X — линейно, Y — вверх с коэфом
    // Масштаб: сколько пикселей мира = 1 пиксель экрана изначально
    const speedX = 80; // мировых px/сек по горизонтали

    function animate() {
        if (!rocketGameState.isRoundActive && !rocketGameState._continueAfterCashout) return;
        const elapsed = (Date.now() - rocketGameState.startTime) / 1000;
        lastElapsed = elapsed;

        rocketGameState.currentCoefficient = Math.pow(1.10, elapsed);

        // Краш проверяем ЗДЕСЬ, в том же кадре, где рисуется кнопка «Забрать» — так тап
        // никогда не теряется на границе раунда (кнопка прячется атомарно с крашем).
        if (rocketGameState.isRoundActive && (Date.now() - rocketGameState.startTime) >= (rocketGameState._crashAtMs || Infinity)) {
            endRocketGame(false, rocketGameState.crashPoint);
            return;
        }

        const coef = rocketGameState.currentCoefficient;

        if (rocketGameState._continueAfterCashout && rocketGameState._lastRocketResultLabel) {
            renderRocketResultLabel();
        } else {
            setText('rocket-coefficient', '×' + fixedNumber(coef, 1));
        }
        if (rocketGameState.isRoundActive) {
            const cashBtn = $id('rocket-cashout-btn');
            if (cashBtn) cashBtn.textContent = `ЗАБРАТЬ ×${fixedNumber(coef, 1)}`;
        }

        // Мировая позиция ракеты
        const worldX = elapsed * speedX;
        const worldY = -(coef - 1) * 350;

        // Стартовая точка — левый нижний угол
        const startSX = W * 0.10;
        const startSY = H * 0.88;
        const targetSX = W * 0.50;
        const targetSY = H * 0.50;

        // До центра — ракета просто летит по экрану
        // После центра — камера следит
        const rawSX = startSX + worldX;
        const rawSY = startSY + worldY;
        const camX = rawSX > targetSX ? worldX - (targetSX - startSX) : 0;
        const camY = rawSY < targetSY ? worldY - (targetSY - startSY) : 0;

        // Сохраняем точку следа
        rocketGameState.trailPoints.push({ wx: worldX, wy: worldY });

        // Экранные координаты точки мира
        function toScreen(wx, wy) {
            return { x: startSX + wx - camX, y: startSY + wy - camY };
        }

        // Рисуем
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#080814';
        ctx.fillRect(0, 0, W, H);

        // Сетка — прокручивается с камерой + плавное покачивание
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        const gridX = 80, gridY = 60;
        const floatX = Math.sin(elapsed * 0.4) * 6;
        const floatY = Math.cos(elapsed * 0.3) * 4;
        const offX = ((-camX + floatX) % gridX + gridX) % gridX;
        const offY = ((-camY + floatY) % gridY + gridY) % gridY;
        for (let x = offX - gridX; x < W + gridX; x += gridX) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = offY - gridY; y < H + gridY; y += gridY) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        const tp = rocketGameState.trailPoints;
        if (tp.length > 1) {
            const origin = toScreen(0, 0);
            const pts = tp.map(p => toScreen(p.wx, p.wy));
            const last = pts[pts.length - 1];

            // Заливка
            ctx.beginPath();
            ctx.moveTo(origin.x, origin.y);
            for (const p of pts) ctx.lineTo(p.x, p.y);
            ctx.lineTo(last.x, origin.y);
            ctx.closePath();
            const fillGrad = ctx.createLinearGradient(0, last.y, 0, origin.y);
            fillGrad.addColorStop(0, 'rgba(123,92,255,0.3)');
            fillGrad.addColorStop(1, 'rgba(123,92,255,0.03)');
            ctx.fillStyle = fillGrad;
            ctx.fill();

            // Линия следа
            ctx.beginPath();
            ctx.moveTo(origin.x, origin.y);
            for (const p of pts) ctx.lineTo(p.x, p.y);
            const lineGrad = ctx.createLinearGradient(origin.x, origin.y, last.x, last.y);
            lineGrad.addColorStop(0, 'rgba(123,92,255,0.3)');
            lineGrad.addColorStop(1, 'rgba(200,160,255,1)');
            ctx.strokeStyle = lineGrad;
            ctx.lineWidth = 4;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();

            // Свечение
            const glow = ctx.createRadialGradient(last.x, last.y, 0, last.x, last.y, 24);
            glow.addColorStop(0, 'rgba(200,160,255,0.7)');
            glow.addColorStop(1, 'rgba(123,92,255,0)');
            ctx.beginPath();
            ctx.arc(last.x, last.y, 24, 0, Math.PI * 2);
            ctx.fillStyle = glow;
            ctx.fill();
        }

        // Позиция ракеты на экране
        const rPos = toScreen(worldX, worldY);
        const sx = rPos.x;
        const sy = rPos.y;
        const wobble = Math.sin(elapsed * 3) * 2;
        rocketEl.style.left      = sx + 'px';
        rocketEl.style.top       = sy + 'px';
        rocketEl.style.transform = `translate(-50%,-50%) rotate(${-45 + wobble}deg)`;

        rocketGameState._elapsed = elapsed;
        rocketGameState._W = W; rocketGameState._H = H;
        rocketGameState._rocketScreenX = sx;
        rocketGameState._rocketScreenY = sy;

        requestAnimationFrame(animate);
    }
    animate();
}


// ТЗ (риск-модель): даже при выводе есть шанс «слива» — гарантированно безубыточной
// стратегии на низких иксах больше нет. На x1 шанс заметно ниже, чем на высоких иксах,
// но НЕ равен нулю; плавно растёт с множителем и ограничен потолком.
function rocketSlipChance(mult) {
    const m = Math.max(1, Number(mult) || 1);
    const p = 0.03 + (m - 1) * 0.03;   // x1 → 3%, x2 → 6%, x5 → 15% …
    return Math.min(p, 0.25);          // потолок 25%
}

// Слив при попытке вывода: ставка теряется, подарок/выигрыш не начисляется.
function rocketCashoutSlip(multiplier) {
    const bet = rocketGameState.currentBet;
    const result = { timestamp: new Date().toISOString(), bet, win: 0, coefficient: multiplier, isWin: false, slip: true };
    userData.rocketHistory.unshift(result);
    if (userData.rocketHistory.length > 20) userData.rocketHistory = userData.rocketHistory.slice(0, 20);
    userData.stats.rocketPlayed = (userData.stats.rocketPlayed || 0) + 1; updateTasks();
    saveUserData(); updateBalance(); updateStats(); updateRocketHistory();

    const cashBtn = $id('rocket-cashout-btn');
    if (cashBtn) cashBtn.style.display = 'none';
    setText('rocket-coefficient', '✗ Сорвалось');
    if (typeof showNotif === 'function') showNotif('Не успел — подарок сорвался на ×' + fixedNumber(multiplier, 1), 'error');

    rocketGameState.isRoundActive = false;
    rocketGameState.isPlaying = false;
    rocketGameState._continueAfterCashout = false;
    setTimeout(() => { crashAnimateRocket(); startRocketCountdown(); }, 900);
}

function legacyCashOutRocket() {
    if (!rocketGameState.isPlaying || !rocketGameState.isRoundActive) return;

    const multiplier = rocketGameState.currentCoefficient;
    // Риск-модели «слива» — проверяем ДО начисления выигрыша.
    if (Math.random() < rocketSlipChance(multiplier)) { rocketCashoutSlip(multiplier); return; }
    const winAmount  = Math.floor(rocketGameState.currentBet * multiplier);

    // Подарок/NFT — деньги начисляет модалка выбора, не здесь (иначе двойное начисление).
    const giftPrize = (winAmount >= 15) ? GIFT_SYSTEM.getRandomGift(winAmount) : null;
    // Начисляем выигрыш (только если это не подарок — иначе выдаст модалка)
    // Legacy local payout removed; Telegram games settle on the backend.
    userData.stats.totalWon += winAmount;
    saveUserData();
    updateBalance();

    // Записываем в историю
    const result = { timestamp: new Date().toISOString(), bet: rocketGameState.currentBet,
                     win: winAmount, coefficient: multiplier, isWin: true };
    userData.rocketHistory.unshift(result);
    if (userData.rocketHistory.length > 20) userData.rocketHistory = userData.rocketHistory.slice(0,20);
    userData.stats.rocketPlayed=(userData.stats.rocketPlayed||0)+1; updateTasks();

    // Подарок
    if (giftPrize) {
        setTimeout(() => showGiftChoiceModal(giftPrize, winAmount), 1200);
    }

    updateStats();
    updateRocketHistory();

    // Прячем кнопку забрать, НО ракетка продолжает лететь до краша
    const cashBtn = $id('rocket-cashout-btn');
    if (cashBtn) cashBtn.style.display = 'none';

    // Показываем «забрал» на коэффициенте
    setText('rocket-coefficient', '✓ ×' + fixedNumber(multiplier, 1));

    // Флаг: раунд закончился для игрока, но анимация продолжается
    rocketGameState.isRoundActive = false;
    rocketGameState._continueAfterCashout = true;

    // Ждём краша (оставшееся время) — потом запускаем сброс
    const elapsed    = rocketGameState._elapsed || 0;
    const crashCoef  = rocketGameState.crashPoint;
    // Когда 1.06^t = crashCoef → t = log(crashCoef)/log(1.06)
    const crashTime  = Math.log(crashCoef) / Math.log(1.10);
    const remaining  = Math.max((crashTime - elapsed) * 1000, 500);

    setTimeout(() => {
        rocketGameState._continueAfterCashout = false;
        rocketGameState.isPlaying = false;
        crashAnimateRocket();
        startRocketCountdown();
    }, remaining);
}

function legacyEndRocketGame(isWin, multiplier) {
    rocketGameState.isRoundActive = false;
    rocketGameState.isPlaying     = false;
    rocketGameState._continueAfterCashout = false;

    if (!isWin) {
        // Краш — записываем проигрыш
        const result = { timestamp: new Date().toISOString(), bet: rocketGameState.currentBet,
                         win: 0, coefficient: multiplier, isWin: false };
        userData.rocketHistory.unshift(result);
        if (userData.rocketHistory.length > 20) userData.rocketHistory = userData.rocketHistory.slice(0,20);
        saveUserData();
        updateBalance();
        updateStats();
        updateRocketHistory();
        updateRocketPrevRounds();
    }

    // Восстановить кнопки
    const playBtn = $id('rocket-play-btn');
    const cashBtn = $id('rocket-cashout-btn');
    if (cashBtn) cashBtn.style.display = 'none';
    if (playBtn) {
        playBtn.style.display = 'block';
        playBtn.disabled = true;
        playBtn.style.opacity = '0.5';
    }

    crashAnimateRocket();
    startRocketCountdown();
}

function crashAnimateRocket() {
    const rocketEl = $id('rocket-emoji');
    const cvs      = $id('rocket-canvas');
    const ctx      = cvs ? cvs.getContext('2d') : null;
    if (!rocketEl) { setTimeout(resetRocketEmoji, 400); return; }

    const W = rocketGameState._W || 400;
    const H = rocketGameState._H || 340;
    let rx  = rocketGameState._rocketScreenX || parseFloat(rocketEl.style.left) || W * 0.8;
    let ry  = rocketGameState._rocketScreenY || parseFloat(rocketEl.style.top)  || H * 0.5;
    let spin = -45, vy = 0;
    const crashStart = Date.now();

    function fall() {
        const ft   = (Date.now() - crashStart) / 1000;
        const prog = Math.min(ft / 1.4, 1);
        vy  += 2.8; ry += vy * 0.5; rx += 1.2; spin += 15;
        const op = Math.max(0, 1 - prog * 1.5);
        rocketEl.style.top       = ry + 'px';
        rocketEl.style.left      = rx + 'px';
        rocketEl.style.transform = `translate(-50%,-50%) rotate(${spin}deg)`;
        rocketEl.style.opacity   = op;

        if (ctx) {
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#080814'; ctx.fillRect(0, 0, W, H);
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
            for (let x = 0; x < W; x += W/6){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
            for (let y = 0; y < H; y += H/5){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

            // Рисуем сохранённый след
            const tp = rocketGameState.trailPoints;
            if (tp && tp.length > 1) {
                ctx.beginPath();
                ctx.moveTo(tp[0].x, tp[0].y);
                for (let i = 1; i < tp.length; i++) ctx.lineTo(tp[i].x, tp[i].y);
                ctx.strokeStyle = 'rgba(180,140,255,0.5)';
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.stroke();
            }
        }

        if (prog < 1) requestAnimationFrame(fall);
        else resetRocketEmoji();
    }
    requestAnimationFrame(fall);
}

function resetRocketEmoji() {
    const r = $id('rocket-emoji');
    const c = $id('rocket-canvas');
    const W = c ? (c.offsetWidth  || 400) : 400;
    const H = c ? (c.offsetHeight || 340) : 340;
    if (r) {
        r.style.display   = 'block';
        r.style.opacity   = '1';
        r.style.left      = (W * 0.10) + 'px';
        r.style.top       = (H * 0.88) + 'px';
        r.style.transform = 'translate(-50%,-50%) rotate(-45deg)';
    }
    if (c) {
        const ctx = c.getContext('2d');
        if (ctx) {
            ctx.fillStyle = '#080814'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
            for (let x = 0; x < c.width; x += c.width/6)  { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,c.height); ctx.stroke(); }
            for (let y = 0; y < c.height; y += c.height/5) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(c.width,y);  ctx.stroke(); }
        }
    }
    rocketGameState.isPlaying = false;
    if (rocketGameState._lastRocketResultLabel) renderRocketResultLabel();
    else setText('rocket-coefficient', '×1.00');
    updateRocketPrevRounds();
}

function updateRocketPrevRounds() {
    const container = $id('rocket-prev-rounds');
    if (!container) return;
    container.innerHTML = '';
    const last8 = (userData.rocketHistory || []).slice(0, 8);
    last8.forEach(r => {
        const pill = document.createElement('div');
        const coefficient = historyCoefficient(r);
        const coef = coefficient.toFixed(2);
        const crashed = !r.isWin;
        const color = crashed
            ? (coefficient < 2 ? '#e74c3c' : coefficient < 5 ? '#e67e22' : '#8e44ad')
            : '#27ae60';
        pill.style.cssText = `
            padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;
            color:#fff;background:${color};flex-shrink:0;cursor:default;
        `;
        pill.textContent = '×' + coef;
        container.appendChild(pill);
    });
}

function updateRocketHistory() {
    const list = $id('rocket-history-list');
    if (!list) return;
    list.innerHTML = '';
    (userData.rocketHistory || []).slice(0,30).forEach(g => {
        const d = new Date(g.timestamp);
        const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const item = document.createElement('div');
        item.className = `history-item ${g.isWin ? 'win':'lose'}`;
        item.innerHTML = `<span>${time}</span><span>Ставка: ${g.bet}F</span><span>${g.isWin?'+'+g.win:'-'+g.bet}F</span><span>×${fixedNumber(historyCoefficient(g), 1)}</span>`;
        list.appendChild(item);
    });
}

function startRocketCountdown() {
    // Ракетка пока оффлайн (одиночный режим) — таймер обратного отсчёта раунда убран.
    // Когда игра станет онлайн (общие раунды), вернём отсчёт.
    rocketGameState.roundCountdown = 0;
    const status = $id('round-status');
    if (status) status.style.display = 'none';
    const playBtn = $id('rocket-play-btn');
    if (playBtn) {
        playBtn.style.display = 'block';
        playBtn.disabled = false;
        playBtn.style.opacity = '1';
    }
}

// ===== ПРОФИЛЬ =====
function updateStats() {
    const s = userData.stats;
    setText('games-played', s.gamesPlayed || 0);
    setText('games-won',    s.gamesWon    || 0);
    setText('games-lost',   s.gamesLost   || 0);
    const wr = s.gamesPlayed > 0 ? Math.round((s.gamesWon/s.gamesPlayed)*100) : 0;
    setText('win-rate',        wr);
    setText('total-won',       s.totalWon || 0);
    setText('total-won-gold',  userData.balance.gold || 0);
    setText('max-coef',        fixedNumber(s.maxCoefficient, 0));
    renderProfileHistory();
}


function renderProfileHistory() {
    const list = document.getElementById('profile-history-list');
    if (!list) return;
    const allHistory = [
        ...(userData.gameHistory || []).map(g => ({...g, type: 'Мины'})),
        ...(userData.rocketHistory || []).map(g => ({...g, type: 'Ракета'})),
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 15);

    if (!allHistory.length) {
        list.innerHTML = '<p class="prf-hist-empty">История пуста</p>';
        return;
    }
    list.innerHTML = allHistory.map(g => {
        const d = new Date(g.timestamp);
        const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const cls = g.isWin ? 'win' : 'lose';
        const payout = Math.max(0, Math.floor(Number(g.payout ?? g.win) || 0));
        const profit = Math.floor(Number(g.profit ?? (g.isWin ? payout - g.bet : -g.bet)) || 0);
        const result = g.isWin
            ? `<span class="prf-hist-win" title="Чистая прибыль: ${profit >= 0 ? '+' : ''}${profit} F">+${payout} F</span>`
            : `<span class="prf-hist-lose">-${g.bet} F</span>`;
        return `<div class="prf-hist-item ${cls}">
            <span style="color:#6b7280">${time}</span>
            <span style="color:#9ca3af">${g.type}</span>
            <span style="color:#9ca3af">x${fixedNumber(historyCoefficient(g), 1)}</span>
            ${result}
        </div>`;
    }).join('');
}

function updateProfileInfo() {
    const regDate  = new Date(userData.registrationDate);
    const lastVisit = new Date(userData.lastVisit);
    setText('reg-date',   regDate.toLocaleDateString('ru-RU'));
    setText('last-visit', lastVisit.toLocaleDateString('ru-RU'));
    const tgUser = getTgUser();
    const userName = tgUser
        ? (tgUser.username ? '@'+tgUser.username : tgUser.first_name)
        : `Игрок#${Math.abs(regDate.getTime() % 10000).toString().padStart(4,'0')}`;
    setText('user-name', userName);

    // Фото профиля Telegram
    if (tgUser?.photo_url) {
        const img = document.getElementById('prf-tg-photo');
        const em  = document.getElementById('prf-avatar-emoji');
        if (img) { img.src = tgUser.photo_url; img.style.display = 'block'; }
        if (em)  { em.style.display = 'none'; }
    }

    updateDailyBonusButton();
}

function switchProfTab(tab) {
    ['stats','gifts','refs','hist'].forEach(t => {
        const btn = document.getElementById('ptab-' + t);
        const panel = document.getElementById('ppanel-' + t);
        const active = (t === tab);
        if (btn) btn.classList.toggle('active', active);
        if (panel) panel.classList.toggle('active', active);
    });
    if (tab === 'stats') { updateStats(); }
    if (tab === 'gifts') { updateProfileGifts(); }
    if (tab === 'refs') { loadReferralData(); }
}

function updateProfileGifts() {
    var grid    = document.getElementById('prf-gifts-grid');
    var empty   = document.getElementById('prf-gifts-empty');
    var counter = document.getElementById('prf-gifts-total');
    if (!grid) return;
    var inv = (userData.inventory || []).filter(function(g) {
        return g.status === 'active' || g.status === 'withdrawn';
    });
    if (counter) counter.textContent = inv.length;
    if (!inv.length) {
        grid.innerHTML = '';
        if (empty) { empty.style.display = 'flex'; empty.style.flexDirection = 'column'; empty.style.alignItems = 'center'; }
        return;
    }
    if (empty) empty.style.display = 'none';
    grid.innerHTML = '';
    var items = inv.slice(-9).reverse();
    items.forEach(function(g) {
        var isW  = (g.status === 'withdrawn');
        var card = document.createElement('div');
        card.className = 'prf-gift-mini';
        if (isW) card.style.opacity = '0.5';
        card.addEventListener('click', function() { showSection('inventory'); });
        var iconDiv = document.createElement('div');
        iconDiv.className = 'prf-gift-mini-emoji';
        iconDiv.innerHTML = (typeof giftIcon === 'function') ? giftIcon(g, 52) : (GIFT_EMOJIS[g.type] || '🎁');
        var valDiv = document.createElement('div');
        valDiv.className = 'prf-gift-mini-val';
        valDiv.textContent = (g.currency === 'gold' ? '🟡 ' : 'F ') + (g.minValue || g.value || 0);
        var lblDiv = document.createElement('div');
        lblDiv.className = 'prf-gift-mini-lbl';
        lblDiv.textContent = isW ? 'Выведен' : (g.name || 'Подарок');
        card.appendChild(iconDiv); card.appendChild(valDiv); card.appendChild(lblDiv);
        grid.appendChild(card);
    });
}

let referralData = null;

function renderReferralData(data) {
    const total = Number(data?.total) || 0;
    const active = Number(data?.active) || 0;
    const earned = Number(data?.accrued) || 0;
    const rate = Number(data?.rate) || 0;
    setText('ref-total-count', total);
    setText('ref-active-count', active);
    setText('ref-earned', earned + ' F');
    setText('ref-rate', rate + '%');
    const caption = $id('ref-link-caption');
    const linkInput = $id('ref-link-value');
    if (linkInput) linkInput.value = String(data?.link || '');
    if (caption) caption.textContent = data?.code
        ? `Код: ${data.code} · ставка: ${rate}% · доступно: ${Number(data.available) || 0} F`
        : 'Реферальная ссылка пока не создана';
    const retry = $id('ref-retry-btn');
    if (retry) retry.style.display = 'none';

    const list = $id('ref-friends-list');
    if (!list) return;
    list.textContent = '';
    const friends = Array.isArray(data?.friends) ? data.friends : [];
    if (!friends.length) {
        list.textContent = 'Пока нет приглашённых пользователей';
        list.style.color = '#8b8ba7';
        list.style.fontSize = '.8rem';
        return;
    }
    friends.forEach(friend => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#151522;border:1px solid #292942;border-radius:12px;';
        const name = document.createElement('div');
        name.style.cssText = 'min-width:0;color:#fff;font-weight:800;font-size:.82rem;';
        name.textContent = friend.name || 'Пользователь';
        const details = document.createElement('div');
        details.style.cssText = 'text-align:right;white-space:nowrap;font-size:.7rem;';
        details.innerHTML = `<span style="color:${friend.active ? '#4ade80' : '#8b8ba7'};font-weight:800;">${friend.active ? 'АКТИВЕН' : 'НЕАКТИВЕН'}</span><br><span style="color:#8b8ba7;">начислено: ${Number(friend.earned) || 0} F</span>`;
        row.appendChild(name);
        row.appendChild(details);
        list.appendChild(row);
    });
}

async function loadReferralData(force = false) {
    if (referralData && !force) {
        renderReferralData(referralData);
        return referralData;
    }
    const list = $id('ref-friends-list');
    if (list && !referralData) list.textContent = 'Загрузка рефералов…';
    try {
        const initData = await waitForTelegramInitData(5000);
        const headers = initData ? { 'X-Telegram-Init-Data': initData } : {};
        const response = await fetch(BACKEND_URL + '/referral/me', { method: 'GET', headers, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data || data.error) throw new Error(data?.error || 'referral_load_failed');
        referralData = data;
        renderReferralData(data);
        return data;
    } catch (e) {
        if (list) {
            list.textContent = e?.message === 'unauthorized'
                ? 'Откройте приложение через Telegram, чтобы загрузить рефералку.'
                : 'Не удалось загрузить рефералы. Нажмите «Повторить загрузку».';
            list.style.color = '#f87171';
        }
        const retry = $id('ref-retry-btn');
        if (retry) retry.style.display = 'block';
        return null;
    }
}

async function copyRefLink() {
    if (!referralData?.link) await loadReferralData(true);
    const link = referralData?.link;
    if (!link) {
        showNotif('Реферальная ссылка пока недоступна.', '#f87171');
        return;
    }
    if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => {
            showNotif('📋 Ссылка скопирована!', '#8b5cf6');
        }).catch(() => { alert(link); });
    } else {
        alert(link);
    }
}

// ===== ЕЖЕДНЕВНЫЙ БОНУС =====
async function claimDailyBonus() {
    const now = new Date();
    const last = userData.lastDailyBonus ? new Date(userData.lastDailyBonus) : null;
    if (last) {
        const diff = (now - last) / (1000*60*60);
        if (diff < 24) {
            const rem = Math.ceil(24 - diff);
            alert(`Следующий бонус через ${rem} ч.`); return;
        }
    }
    try {
        const result = await fleepGameApi('/daily/claim', {
            action_id: fleepActionId('daily_claim')
        });
        applyRocketServerBalance(result, true);
        userData.lastDailyBonus = now.toISOString();
        saveUserData();
        updateDailyBonusButton();
        alert(`+${Number(result.reward) || 100} серебряных F-коинов!`);
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (e?.data?.error === 'daily_bonus_already_claimed') {
            userData.lastDailyBonus = now.toISOString();
            saveUserData();
            updateDailyBonusButton();
            alert('Ежедневный бонус уже получен.');
        } else {
            showNotif('Не удалось получить ежедневный бонус. Попробуйте ещё раз.', '#f87171');
        }
    }
}

function updateDailyBonusButton() {
    const now  = new Date();
    const last = userData.lastDailyBonus ? new Date(userData.lastDailyBonus) : null;
    const canClaim = !last || (now - last) / (1000*60*60) >= 24;
    ['daily-bonus-btn','rocket-daily-bonus-btn'].forEach(id => {
        const btn = $id(id);
        if (!btn) return;
        btn.disabled = !canClaim;
        btn.style.opacity = canClaim ? '1' : '0.5';
    });
    if (last && !canClaim) {
        const rem = Math.ceil(24 - (now-last)/(1000*60*60));
        setText('next-bonus', `Через ${rem} ч.`);
    } else {
        setText('next-bonus', 'Доступен!');
    }
}

// ===== ЗАДАНИЯ =====
const TASKS = {
    1: { name:'Заряди казну',     target:1, reward:50,  rewardType:'gold',   type:'deposit100'  },
    2: { name:'Сапёр-миллионер',  target:5, reward:25,  rewardType:'silver', type:'minesPlayed' },
    3: { name:'Космо-кэшаут',     target:5, reward:25,  rewardType:'silver', type:'rocketPlayed'},
};
let serverTaskProgress = {};

function isServerTaskClaimed(id) {
    return !!(userData.serverTaskClaims && userData.serverTaskClaims[id]);
}

function getTaskProgress(id) {
    const remote = serverTaskProgress && serverTaskProgress[id];
    if (remote && Number.isFinite(Number(remote.progress))) return Math.max(0, Number(remote.progress));
    const tp = userData.taskProgress || {};
    const t = TASKS[id].type;
    if (t==='deposit100')  return (tp.deposit100  ? 1 : 0);
    if (t==='minesPlayed') return Math.min(userData.stats.minesPlayed  ||0, TASKS[id].target);
    if (t==='rocketPlayed')return Math.min(userData.stats.rocketPlayed ||0, TASKS[id].target);
    if (t==='casesOpened') return Math.min(tp.casesOpened||0, TASKS[id].target);
    return 0;
}

function updateTasks() {
    for (let i=1; i<=3; i++) {
        const prog = getTaskProgress(i);
        const target = TASKS[i].target;
        const fill = document.getElementById('task-'+i+'-progress');
        const text = document.getElementById('task-'+i+'-text');
        const btn  = document.getElementById('task-'+i+'-btn');
        if (fill) fill.style.width = Math.min((prog/target)*100,100)+'%';
        if (text) text.textContent = Math.min(prog,target)+'/'+target;
        if (btn)  btn.disabled = prog < target || isServerTaskClaimed(i) || claimingTaskIds.has(i);
        const card = document.getElementById('task-'+i);
        if (card) card.classList.toggle('task-done', isServerTaskClaimed(i));
    }
    let c=0,r=0; for(let i=1;i<=3;i++){if(isServerTaskClaimed(i)){c++;r+=TASKS[i].reward;}}
    const tc=document.getElementById('tasks-completed'); if(tc)tc.textContent=c;
    const tr=document.getElementById('total-rewards');   if(tr)tr.textContent=r;
    const qh=document.getElementById('quest-hero-count'); if(qh)qh.textContent=c+'/3';
}

async function loadServerTaskProgress() {
    try {
        const initData = await waitForTelegramInitData();
        const headers = initData ? { 'X-Telegram-Init-Data': initData } : {};
        const response = await fetch(BACKEND_URL + '/task/progress', { headers, cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.tasks) {
            serverTaskProgress = data.tasks;
            Object.keys(data.tasks).forEach(id => {
                if (data.tasks[id]?.claimed) userData.serverTaskClaims[id] = true;
            });
            updateTasks();
        }
    } catch (e) { /* server may not be ready outside Telegram */ }
}

const claimingTaskIds = new Set();

// Награда задания выдаётся только сервером. Раньше здесь баланс менялся
// локально, а следующий /save_balance на iPhone возвращал серверное значение
// обратно — визуально кнопка срабатывала, но монеты не зачислялись.
async function claimTaskReward(id) {
    id = Math.floor(Number(id));
    const task = TASKS[id];
    if (!task || isServerTaskClaimed(id) || getTaskProgress(id) < task.target || claimingTaskIds.has(id)) return;

    claimingTaskIds.add(id);
    updateTasks();
    try {
        const result = await fleepGameApi('/task/claim', {
            task_id: id,
            action_id: fleepActionId('task_claim')
        });

        // Баланс и факт выдачи приходят из одного серверного ответа.
        applyRocketServerBalance(result, true);
        userData.serverTaskClaims[id] = true;
        userData.tasks[id] = true;
        saveUserData();
        updateTasks();

        const cur = task.rewardType === 'gold' ? '🟡' : 'F';
        const amount = Number(result.reward) || task.reward;
        if (typeof showNotif === 'function') {
            showNotif(result.already_claimed
                ? '✅ Награда за это задание уже была выдана'
                : '🎉 +' + amount + ' ' + cur + ' получено!', '#7b5cff');
        }
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        const error = e && e.data && e.data.error;
        if (typeof showNotif === 'function') {
            const message = error === 'unauthorized'
                ? '⚠️ Откройте игру через Telegram заново'
                : error === 'task_not_complete'
                    ? '⚠️ Задание ещё не выполнено'
                    : '⚠️ Не удалось забрать награду. Попробуйте ещё раз';
            showNotif(message, '#f87171');
        }
    } finally {
        claimingTaskIds.delete(id);
        updateTasks();
    }
}

// ===== КЕЙСЫ — КОНФИГ =====
const CASE_CONFIG = {
    daily:    { name: 'Ежедневный',        emoji: '📅', free: true,   dailyOnly: true, silverCost: 0, goldCost: 0 },
    free:     { name: 'Free',              emoji: '🍀', free: true,   dailyOnly: true, referralGate: true, silverCost: 0, goldCost: 0 },
    strike:   { name: 'СТРАЙК',           emoji: '⚡', strike: true, silverCost: 0,   goldCost: 0   },
    stars15:  { name: '15 звёзд',          emoji: '⭐', free: false,  silverCost: 15,  goldCost: 15  },
    stars25:  { name: '25 звёзд',          emoji: '⭐', free: false,  silverCost: 25,  goldCost: 25  },
    stars50:  { name: '50 звёзд',          emoji: '⭐', free: false,  silverCost: 50,  goldCost: 50  },
    stars67:  { name: '67 звёзд',          emoji: '🌟', free: false,  silverCost: 67,  goldCost: 67  },
    stars100: { name: '100 звёзд',         emoji: '💫', free: false,  silverCost: 100, goldCost: 100 },
    stars200:  { name: 'Лям 200',    emoji: '🌠', free: false, silverCost: 200,  goldCost: 200  },
    stars500:  { name: '500 звёзд',  emoji: '🌌', free: false, silverCost: 500,  goldCost: 500  },
    stars1000: { name: 'Покой в богатстве', emoji: '👑', free: false, silverCost: 1000, goldCost: 1000 },
    stars2000: { name: 'Олигарх',    emoji: '💠', free: false, silverCost: 2000, goldCost: 2000 },
};

// ===== ПИКСЕЛЬ-АРТ SVG ИКОНКИ КЕЙСОВ =====
const CASE_PIXEL_ICONS = {
    daily: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#22aa44"/><rect x="4" y="2" width="1" height="2" fill="#22aa44"/><rect x="11" y="2" width="1" height="2" fill="#22aa44"/><rect x="5" y="2" width="6" height="1" fill="#0a1a0a"/>
        <rect x="2" y="4" width="12" height="3" fill="#33cc55"/><rect x="2" y="4" width="1" height="3" fill="#1a7730"/><rect x="13" y="4" width="1" height="3" fill="#1a7730"/><rect x="3" y="4" width="4" height="1" fill="#66ee88"/>
        <rect x="2" y="7" width="12" height="1" fill="#155522"/><rect x="7" y="6" width="2" height="2" fill="#55ff77"/><rect x="7" y="7" width="2" height="1" fill="#22cc44"/>
        <rect x="2" y="8" width="12" height="4" fill="#29a843"/><rect x="2" y="8" width="1" height="4" fill="#1a7730"/><rect x="13" y="8" width="1" height="4" fill="#1a7730"/>
        <rect x="2" y="12" width="12" height="1" fill="#155522"/><rect x="2" y="13" width="12" height="1" fill="#0f3d18"/>
        <rect x="3" y="4" width="1" height="1" fill="#88ffaa"/><rect x="12" y="4" width="1" height="1" fill="#88ffaa"/><rect x="3" y="12" width="1" height="1" fill="#88ffaa"/><rect x="12" y="12" width="1" height="1" fill="#88ffaa"/>
        <rect x="6" y="9" width="4" height="1" fill="#ccffdd"/><rect x="6" y="10" width="3" height="1" fill="#ccffdd"/><rect x="6" y="11" width="1" height="1" fill="#ccffdd"/><rect x="6" y="12" width="1" height="1" fill="#ccffdd"/>
    </svg>`,
    strike: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#dd9900"/><rect x="4" y="2" width="1" height="2" fill="#dd9900"/><rect x="11" y="2" width="1" height="2" fill="#dd9900"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#ffcc00"/><rect x="2" y="4" width="1" height="3" fill="#996600"/><rect x="13" y="4" width="1" height="3" fill="#996600"/><rect x="3" y="4" width="4" height="1" fill="#ffee88"/>
        <rect x="2" y="7" width="12" height="1" fill="#774400"/><rect x="7" y="6" width="2" height="2" fill="#ffee44"/><rect x="7" y="7" width="2" height="1" fill="#cc8800"/>
        <rect x="2" y="8" width="12" height="4" fill="#e8a800"/><rect x="2" y="8" width="1" height="4" fill="#996600"/><rect x="13" y="8" width="1" height="4" fill="#996600"/>
        <rect x="2" y="12" width="12" height="1" fill="#774400"/><rect x="2" y="13" width="12" height="1" fill="#553300"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffff99"/><rect x="12" y="4" width="1" height="1" fill="#ffff99"/><rect x="3" y="12" width="1" height="1" fill="#ffff99"/><rect x="12" y="12" width="1" height="1" fill="#ffff99"/>
        <rect x="9" y="9" width="2" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="7" y="10" width="3" height="1" fill="#fff5aa"/><rect x="6" y="11" width="2" height="1" fill="#fff5aa"/><rect x="7" y="12" width="2" height="1" fill="#fff5aa"/>
    </svg>`,
    peace: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#8855dd"/><rect x="4" y="2" width="1" height="2" fill="#8855dd"/><rect x="11" y="2" width="1" height="2" fill="#8855dd"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#9966ee"/><rect x="2" y="4" width="1" height="3" fill="#4422aa"/><rect x="13" y="4" width="1" height="3" fill="#4422aa"/><rect x="3" y="4" width="4" height="1" fill="#ccaaff"/>
        <rect x="2" y="7" width="12" height="1" fill="#331188"/><rect x="7" y="6" width="2" height="2" fill="#bb99ff"/><rect x="7" y="7" width="2" height="1" fill="#7744cc"/>
        <rect x="2" y="8" width="12" height="4" fill="#8855cc"/><rect x="2" y="8" width="1" height="4" fill="#4422aa"/><rect x="13" y="8" width="1" height="4" fill="#4422aa"/>
        <rect x="2" y="12" width="12" height="1" fill="#331188"/><rect x="2" y="13" width="12" height="1" fill="#220066"/>
        <rect x="3" y="4" width="1" height="1" fill="#eeddff"/><rect x="12" y="4" width="1" height="1" fill="#eeddff"/><rect x="3" y="12" width="1" height="1" fill="#eeddff"/><rect x="12" y="12" width="1" height="1" fill="#eeddff"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/><rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
    </svg>`,
    stars15: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#3388cc"/><rect x="4" y="2" width="1" height="2" fill="#3388cc"/><rect x="11" y="2" width="1" height="2" fill="#3388cc"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#44aadd"/><rect x="2" y="4" width="1" height="3" fill="#225588"/><rect x="13" y="4" width="1" height="3" fill="#225588"/><rect x="3" y="4" width="4" height="1" fill="#99ddff"/>
        <rect x="2" y="7" width="12" height="1" fill="#113366"/><rect x="7" y="6" width="2" height="2" fill="#88ccff"/><rect x="7" y="7" width="2" height="1" fill="#3377bb"/>
        <rect x="2" y="8" width="12" height="4" fill="#3399cc"/><rect x="2" y="8" width="1" height="4" fill="#225588"/><rect x="13" y="8" width="1" height="4" fill="#225588"/>
        <rect x="2" y="12" width="12" height="1" fill="#113366"/><rect x="2" y="13" width="12" height="1" fill="#0a2244"/>
        <rect x="3" y="4" width="1" height="1" fill="#bbeeff"/><rect x="12" y="4" width="1" height="1" fill="#bbeeff"/><rect x="3" y="12" width="1" height="1" fill="#bbeeff"/><rect x="12" y="12" width="1" height="1" fill="#bbeeff"/>
        <rect x="7" y="9" width="2" height="1" fill="#ffffff"/><rect x="6" y="10" width="4" height="1" fill="#ffffff"/><rect x="7" y="11" width="2" height="1" fill="#ffffff"/><rect x="7" y="9" width="2" height="3" fill="#ffffff"/>
    </svg>`,
    stars25: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#2299cc"/><rect x="4" y="2" width="1" height="2" fill="#2299cc"/><rect x="11" y="2" width="1" height="2" fill="#2299cc"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#33bbdd"/><rect x="2" y="4" width="1" height="3" fill="#116688"/><rect x="13" y="4" width="1" height="3" fill="#116688"/><rect x="3" y="4" width="4" height="1" fill="#88eeff"/>
        <rect x="2" y="7" width="12" height="1" fill="#0a4455"/><rect x="7" y="6" width="2" height="2" fill="#77ddff"/><rect x="7" y="7" width="2" height="1" fill="#2288aa"/>
        <rect x="2" y="8" width="12" height="4" fill="#22aacc"/><rect x="2" y="8" width="1" height="4" fill="#116688"/><rect x="13" y="8" width="1" height="4" fill="#116688"/>
        <rect x="2" y="12" width="12" height="1" fill="#0a4455"/><rect x="2" y="13" width="12" height="1" fill="#062233"/>
        <rect x="3" y="4" width="1" height="1" fill="#aaffff"/><rect x="12" y="4" width="1" height="1" fill="#aaffff"/><rect x="3" y="12" width="1" height="1" fill="#aaffff"/><rect x="12" y="12" width="1" height="1" fill="#aaffff"/>
        <rect x="7" y="9" width="2" height="1" fill="#ffffff"/><rect x="6" y="10" width="4" height="1" fill="#ffffff"/><rect x="7" y="11" width="2" height="1" fill="#ffffff"/><rect x="7" y="9" width="2" height="3" fill="#ffffff"/>
        <rect x="6" y="9" width="1" height="1" fill="#ffffff" opacity="0.5"/><rect x="9" y="11" width="1" height="1" fill="#ffffff" opacity="0.5"/>
    </svg>`,
    stars50: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#7799bb"/><rect x="4" y="2" width="1" height="2" fill="#7799bb"/><rect x="11" y="2" width="1" height="2" fill="#7799bb"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#99bbcc"/><rect x="2" y="4" width="1" height="3" fill="#556677"/><rect x="13" y="4" width="1" height="3" fill="#556677"/><rect x="3" y="4" width="4" height="1" fill="#cceeff"/>
        <rect x="2" y="7" width="12" height="1" fill="#334455"/><rect x="7" y="6" width="2" height="2" fill="#bbddee"/><rect x="7" y="7" width="2" height="1" fill="#778899"/>
        <rect x="2" y="8" width="12" height="4" fill="#889aaa"/><rect x="2" y="8" width="1" height="4" fill="#556677"/><rect x="13" y="8" width="1" height="4" fill="#556677"/>
        <rect x="2" y="12" width="12" height="1" fill="#334455"/><rect x="2" y="13" width="12" height="1" fill="#223344"/>
        <rect x="3" y="4" width="1" height="1" fill="#ddeeff"/><rect x="12" y="4" width="1" height="1" fill="#ddeeff"/><rect x="3" y="12" width="1" height="1" fill="#ddeeff"/><rect x="12" y="12" width="1" height="1" fill="#ddeeff"/>
        <rect x="7" y="9" width="2" height="1" fill="#eef4ff"/><rect x="6" y="10" width="4" height="1" fill="#eef4ff"/><rect x="7" y="11" width="2" height="1" fill="#eef4ff"/><rect x="7" y="9" width="2" height="3" fill="#eef4ff"/>
    </svg>`,
    stars67: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#cc2222"/><rect x="4" y="2" width="1" height="2" fill="#cc2222"/><rect x="11" y="2" width="1" height="2" fill="#cc2222"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#dd3333"/><rect x="2" y="4" width="1" height="3" fill="#881111"/><rect x="13" y="4" width="1" height="3" fill="#881111"/><rect x="3" y="4" width="4" height="1" fill="#ff8888"/>
        <rect x="2" y="7" width="12" height="1" fill="#660000"/><rect x="7" y="6" width="2" height="2" fill="#ff7777"/><rect x="7" y="7" width="2" height="1" fill="#bb2222"/>
        <rect x="2" y="8" width="12" height="4" fill="#cc2222"/><rect x="2" y="8" width="1" height="4" fill="#881111"/><rect x="13" y="8" width="1" height="4" fill="#881111"/>
        <rect x="2" y="12" width="12" height="1" fill="#660000"/><rect x="2" y="13" width="12" height="1" fill="#440000"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffaaaa"/><rect x="12" y="4" width="1" height="1" fill="#ffaaaa"/><rect x="3" y="12" width="1" height="1" fill="#ffaaaa"/><rect x="12" y="12" width="1" height="1" fill="#ffaaaa"/>
        <rect x="7" y="9" width="2" height="1" fill="#ffeeee"/><rect x="6" y="9" width="1" height="1" fill="#ffeeee"/><rect x="9" y="9" width="1" height="1" fill="#ffeeee"/>
        <rect x="6" y="10" width="4" height="1" fill="#ffeeee"/><rect x="7" y="10" width="1" height="1" fill="#cc2222"/><rect x="9" y="10" width="1" height="1" fill="#cc2222"/>
        <rect x="7" y="11" width="1" height="1" fill="#ffeeee"/><rect x="9" y="11" width="1" height="1" fill="#ffeeee"/>
        <rect x="7" y="12" width="1" height="1" fill="#ffeeee"/><rect x="8" y="12" width="1" height="1" fill="#ffeeee"/><rect x="9" y="12" width="1" height="1" fill="#ffeeee"/>
    </svg>`,
    stars100: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`,
    stars200: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`,
    stars500: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`,
    stars1000: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`,
    stars2000: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`,
    stars5000: `<svg class="case-pixel-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="1" width="6" height="1" fill="#aa4400"/><rect x="4" y="2" width="1" height="2" fill="#aa4400"/><rect x="11" y="2" width="1" height="2" fill="#aa4400"/><rect x="5" y="2" width="6" height="1" fill="#111111"/>
        <rect x="2" y="4" width="12" height="3" fill="#cc5500"/><rect x="2" y="4" width="1" height="3" fill="#773300"/><rect x="13" y="4" width="1" height="3" fill="#773300"/><rect x="3" y="4" width="4" height="1" fill="#ff9955"/>
        <rect x="2" y="7" width="12" height="1" fill="#552200"/><rect x="7" y="6" width="2" height="2" fill="#ff8844"/><rect x="7" y="7" width="2" height="1" fill="#993300"/>
        <rect x="2" y="8" width="12" height="4" fill="#bb4400"/><rect x="2" y="8" width="1" height="4" fill="#773300"/><rect x="13" y="8" width="1" height="4" fill="#773300"/>
        <rect x="2" y="12" width="12" height="1" fill="#552200"/><rect x="2" y="13" width="12" height="1" fill="#331100"/>
        <rect x="3" y="4" width="1" height="1" fill="#ffcc99"/><rect x="12" y="4" width="1" height="1" fill="#ffcc99"/><rect x="3" y="12" width="1" height="1" fill="#ffcc99"/><rect x="12" y="12" width="1" height="1" fill="#ffcc99"/>
        <rect x="6" y="9" width="1" height="1" fill="#fff5aa"/><rect x="8" y="9" width="1" height="1" fill="#fff5aa"/><rect x="10" y="9" width="1" height="1" fill="#fff5aa"/>
        <rect x="6" y="10" width="5" height="1" fill="#fff5aa"/><rect x="6" y="11" width="5" height="1" fill="#fff5aa"/>
        <rect x="7" y="9" width="1" height="1" fill="#ffee44"/><rect x="9" y="9" width="1" height="1" fill="#ffee44"/>
    </svg>`
};

const CASE_UI_CONFIG = {
    daily:    { topClass: 'case-top-free',   cardClass: 'case-card-free',   priceClass: 'free',    priceLabel: 'Бесплатно',          glowFilter: 'drop-shadow(0 0 10px rgba(74,222,128,0.7))' },
    free:     { topClass: 'case-top-free',   cardClass: 'case-card-free',   priceClass: 'free',    priceLabel: 'Бесплатно',          glowFilter: 'drop-shadow(0 0 10px rgba(52,211,153,0.8))' },
    strike:   { topClass: 'case-top-gold',   cardClass: 'case-card-gold',   priceClass: '',        priceLabel: '7 дней депозита',    glowFilter: 'drop-shadow(0 0 10px rgba(252,211,77,0.8))' },
    peace:    { topClass: 'case-top-peace',  cardClass: 'case-card-peace',  priceClass: 'peace',   priceLabel: '555 F',    glowFilter: 'drop-shadow(0 0 10px rgba(139,92,246,0.8))' },
    stars15:  { topClass: 'case-top-silver', cardClass: 'case-card-silver', priceClass: '',        priceLabel: '15 🟡 звёзд',        glowFilter: 'drop-shadow(0 0 10px rgba(148,163,184,0.7))' },
    stars25:  { topClass: 'case-top-silver', cardClass: 'case-card-silver', priceClass: '',        priceLabel: '25 🟡 звёзд',        glowFilter: 'drop-shadow(0 0 10px rgba(148,163,184,0.7))' },
    stars50:  { topClass: 'case-top-silver', cardClass: 'case-card-silver', priceClass: '',        priceLabel: '50 🟡 звёзд',        glowFilter: 'drop-shadow(0 0 10px rgba(148,163,184,0.7))' },
    stars67:  { topClass: 'case-top-epic',   cardClass: 'case-card-epic',   priceClass: 'special', priceLabel: '67 🟡 звёзд',        glowFilter: 'drop-shadow(0 0 10px rgba(239,68,68,0.8))' },
    stars100: { topClass: 'case-top-epic',   cardClass: 'case-card-epic',   priceClass: 'special', priceLabel: '100 🟡 звёзд',       glowFilter: 'drop-shadow(0 0 10px rgba(239,68,68,0.8))' },
    stars200:  { topClass: 'case-top-blue', cardClass: 'case-card-blue', priceClass: 'special', priceLabel: '200 🟡 звёзд',  glowFilter: 'drop-shadow(0 0 10px rgba(96,165,250,0.8))' },
    stars500:  { topClass: 'case-top-violet', cardClass: 'case-card-violet', priceClass: 'special', priceLabel: '500 🟡 звёзд',  glowFilter: 'drop-shadow(0 0 10px rgba(167,139,250,0.8))' },
    stars1000: { topClass: 'case-top-crown', cardClass: 'case-card-crown', priceClass: 'special', priceLabel: '1000 🟡 звёзд', glowFilter: 'drop-shadow(0 0 10px rgba(252,211,77,0.9))' },
    stars2000: { topClass: 'case-top-teal', cardClass: 'case-card-teal', priceClass: 'special', priceLabel: '2000 🟡 звёзд', glowFilter: 'drop-shadow(0 0 12px rgba(45,212,191,0.9))' },
    stars5000: { topClass: 'case-top-crimson', cardClass: 'case-card-crimson', priceClass: 'special', priceLabel: '5000 🟡 звёзд', glowFilter: 'drop-shadow(0 0 14px rgba(248,113,113,1))' }
};

const CASE_TIER_ARTWORK = {
    basic: 'assets/case-artwork-pen.svg?v=1',
    premium: 'assets/case-artwork-rich-reference.png?v=1',
    luxury: 'assets/case-artwork-lux-reference.png?v=1'
};

const CASE_TIER_BY_TYPE = {
    daily: 'basic',
    free: 'basic',
    strike: 'basic',
    stars15: 'basic',
    stars25: 'premium',
    stars50: 'premium',
    stars67: 'premium',
    stars100: 'premium',
    stars200: 'premium',
    stars500: 'premium',
    stars1000: 'luxury',
    stars2000: 'luxury'
};

function getCaseArtworkTier(type) {
    return CASE_TIER_BY_TYPE[type] || 'basic';
}

// В карточках показываем только саму модель кейса.
// Декоративные NFT, подарки, монеты и персонажи были частью исходных сцен,
// поэтому для лобби используются очищенные версии ассетов.
const CASE_TEMPLATE_ARTWORK = {
    daily: 'assets/cases/clean/case-free.png',
    free: 'assets/cases/clean/case-free.png',
    strike: 'assets/cases/clean/case-strike.png',
    stars15: 'assets/cases/clean/case-15-stars-v3.png',
    stars25: 'assets/cases/clean/case-25-stars.png',
    stars50: 'assets/cases/clean/case-50-stars-v3.png',
    stars67: 'assets/cases/clean/case-67-stars.png',
    stars100: 'assets/cases/clean/case-100-stars.png',
    stars200: 'assets/cases/clean/case-200.png',
    stars500: 'assets/cases/clean/case-500-stars-v4.png',
    stars1000: 'assets/cases/clean/case-oligarch-1000.png',
    stars2000: 'assets/cases/clean/case-oligarch.png'
};

// Per-asset perceived-size normalization.  The scale is applied to the whole
// prepared composition — never to an isolated chest or a cropped scene.
const CASE_ARTWORK_FIT = {
    stars1000: { scale: 0.88 },
    stars2000: { scale: 1.13 }
};

function getCaseArtwork(type) {
    return { asset: CASE_TEMPLATE_ARTWORK[type] || '' };
}

function caseArtworkMarkup(type, mode = 'card') {
    const src = CASE_TEMPLATE_ARTWORK[type];
    const cfg = CASE_CONFIG[type];
    if (!src) {
        const fallbackIcon = CASE_PIXEL_ICONS[type] || CASE_PIXEL_ICONS.daily;
        return `
            <div class="case-legacy-artwork" role="img" aria-label="Иллюстрация кейса «${cfg ? cfg.name : type}»">
                ${fallbackIcon}
            </div>`;
    }

    const wrapperClass = mode === 'modal'
        ? 'case-template-wrap case-template-wrap-modal'
        : 'case-template-wrap';
    const fit = mode === 'card' ? CASE_ARTWORK_FIT[type] : null;
    const fitStyle = fit ? ` style="--case-art-scale: ${fit.scale}"` : '';
    const stars67Mark = type === 'stars67'
        ? '<span class="case-67-number" aria-label="67"><span class="case-67-six">6</span><span class="case-67-seven">7</span></span>'
        : '';

    return `
        <div class="${wrapperClass}"${fitStyle}>
            <img class="case-template-image" src="${src}" alt="Кейс «${cfg ? cfg.name : type}»" loading="lazy" decoding="async">
        </div>${stars67Mark}`;
}

function renderCaseCards() {
    const grid = document.querySelector('.cases-new-grid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.classList.add('case-visual-grid');
    const tierMeta = {
        basic: {
            title: 'БАЗОВЫЕ',
            subtitle: 'Для старта и ежедневных наград'
        },
        premium: {
            title: 'ПРЕМИУМ',
            subtitle: 'Звёздные кейсы с усиленными наградами'
        },
        luxury: {
            title: 'ЛЮКС',
            subtitle: 'Главные кейсы коллекции'
        }
    };
    const tierOrder = ['basic', 'premium', 'luxury'];
    const order = [
        'daily', 'free', 'stars15', 'strike',
        'stars25', 'stars50', 'stars67', 'stars100', 'stars200', 'stars500',
        'stars1000', 'stars2000'
    ];
    const cardsByTier = tierOrder.reduce((result, tier) => {
        result[tier] = [];
        return result;
    }, {});

    order.forEach(type => {
        const cfg = CASE_CONFIG[type];
        const ui = CASE_UI_CONFIG[type];
        if (!cfg || !ui) return;

        // Единые расценки: бесплатные/страйк — как есть, остальные — серебро/золото.
        let priceLabel = ui.priceLabel;
        if (!cfg.free && !cfg.strike) priceLabel = `${cfg.goldCost} ⚪/🟡`;

        const tier = getCaseArtworkTier(type);
        const card = document.createElement('div');
        card.className = `case-new-card ${ui.cardClass}`;
        card.dataset.caseType = type;
        card.dataset.tier = tier;
        card.dataset.artworkTier = tier;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Открыть кейс «${cfg.name}»`);
        card.onclick = () => {
            if (type === 'free' && isFreeCaseCooldownActive()) {
                showNotif('🎁 Free Case будет доступен через ' + formatFreeCaseCooldown(freeCaseCooldownSecondsLeft()) + '.', '#fbbf24');
                return;
            }
            selectCase(type);
        };
        card.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (type === 'free' && isFreeCaseCooldownActive()) {
                    showNotif('🎁 Free Case будет доступен через ' + formatFreeCaseCooldown(freeCaseCooldownSecondsLeft()) + '.', '#fbbf24');
                    return;
                }
                selectCase(type);
            }
        };
        card.innerHTML = `
            <div class="case-new-top ${ui.topClass}">
                ${caseArtworkMarkup(type)}
                <div class="case-stars-num">${priceLabel}</div>
            </div>
            <div class="case-new-info">
                <div class="case-new-name">${cfg.name}</div>
                <div class="case-new-price ${ui.priceClass}">${priceLabel}</div>
            </div>`;
        if (cardsByTier[tier]) cardsByTier[tier].push(card);
    });

    tierOrder.forEach(tier => {
        const meta = tierMeta[tier];
        const group = document.createElement('section');
        group.className = `case-tier-group case-tier-group-${tier}`;
        group.dataset.tier = tier;
        group.innerHTML = `
            <div class="case-tier-divider">
                <div class="case-tier-title">${meta.title}</div>
                <div class="case-tier-subtitle">${meta.subtitle}</div>
            </div>
            <div class="case-tier-cards"></div>`;
        const cards = group.querySelector('.case-tier-cards');
        cardsByTier[tier].forEach(card => cards.appendChild(card));
        grid.appendChild(group);
    });
    renderFreeCaseCooldownCard();
}

function freeCaseCooldownSecondsLeft() {
    return Math.max(0, Math.ceil((freeCaseCooldownUntilMs - Date.now()) / 1000));
}

function formatFreeCaseCooldown(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join(':');
}

function isFreeCaseCooldownActive() {
    return freeCaseCooldownSecondsLeft() > 0;
}

function cooldownUntilFromServer(data) {
    const direct = Number(data?.free_case_cooldown_until_ms || data?.cooldown_until_ms) || 0;
    if (direct > Date.now()) return direct;
    const seconds = Number(data?.free_case_cooldown_seconds || data?.cooldown_seconds) || 0;
    if (seconds > 0) return Date.now() + seconds * 1000;
    const openedAt = Date.parse(data?.opened_at || '');
    return Number.isFinite(openedAt) ? openedAt + 24 * 60 * 60 * 1000 : 0;
}

function renderFreeCaseCooldownCard() {
    const card = document.querySelector('.case-new-card[data-case-type="free"]');
    if (!card) return;
    const active = isFreeCaseCooldownActive();
    card.classList.toggle('case-cooldown', active);
    card.tabIndex = active ? -1 : 0;
    card.setAttribute('aria-disabled', active ? 'true' : 'false');
    card.setAttribute('aria-label', active
        ? 'Free Case закрыт. Откроется через ' + formatFreeCaseCooldown(freeCaseCooldownSecondsLeft())
        : 'Открыть кейс «Free»');
    let overlay = card.querySelector('.free-case-cooldown-overlay');
    if (!active) {
        if (overlay) overlay.remove();
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'free-case-cooldown-overlay';
        overlay.setAttribute('role', 'status');
        overlay.innerHTML =
            '<div class="free-case-chains" aria-hidden="true">'
            + '<span class="free-case-chain free-case-chain-left">⛓⛓⛓⛓⛓⛓⛓⛓</span>'
            + '<span class="free-case-chain free-case-chain-right">⛓⛓⛓⛓⛓⛓⛓⛓</span>'
            + '</div>'
            + '<div class="free-case-lock-top">'
            + '<div class="free-case-lock-timer" data-free-case-timer>24:00:00</div>'
            + '<div class="free-case-lock-title"><span class="free-case-lock-icon" aria-hidden="true">🔒</span> ЗАБЛОКИРОВАНО</div>'
            + '</div>';
        card.appendChild(overlay);
    }
    const timer = overlay.querySelector('[data-free-case-timer]');
    if (timer) timer.textContent = formatFreeCaseCooldown(freeCaseCooldownSecondsLeft());
}

function setFreeCaseCooldown(data) {
    const hasAvailability = data && ('free_case_available' in data || 'available' in data || 'free_case_cooldown_until_ms' in data || 'cooldown_until_ms' in data || 'opened_at' in data);
    if (!hasAvailability) return;
    if (data.free_case_available === true || data.available === true) freeCaseCooldownUntilMs = 0;
    else freeCaseCooldownUntilMs = cooldownUntilFromServer(data);
    renderFreeCaseCooldownCard();
    if (isFreeCaseCooldownActive() && !freeCaseCooldownTimer) {
        freeCaseCooldownTimer = setInterval(() => {
            renderFreeCaseCooldownCard();
            if (!isFreeCaseCooldownActive()) {
                clearInterval(freeCaseCooldownTimer);
                freeCaseCooldownTimer = null;
            }
        }, 1000);
    }
}

async function refreshFreeCaseCooldown() {
    if (!tg?.initData && !tg?.initDataUnsafe?.user) return;
    const access = await checkFreeAccess();
    if (access && access.reason !== 'check_failed' && access.reason !== 'unauthorized') setFreeCaseCooldown(access);
}

// ===== КЕЙСЫ - ПОДАРКИ С ЦЕНАМИ =====
// CASE_GIFTS — используются в спин-анимации кейса
// tier: rare(15-99) | epic(100-499) | legendary(500+)
const CASE_GIFTS = [
    { type: 'heart',     name: 'Сердце',           emoji: '❤️',  value: 15,  tier: 'rare',      weight: 28 },
    { type: 'bear',      name: 'Мишка',            emoji: '🐻',  value: 15,  tier: 'rare',      weight: 25 },
    { type: 'rose',      name: 'Роза',             emoji: '🌹',  value: 25,  tier: 'rare',      weight: 22 },
    { type: 'gift',      name: 'Подарок',          emoji: '🎁',  value: 25,  tier: 'rare',      weight: 18 },
    { type: 'cake',      name: 'Торт',             emoji: '🎂',  value: 50, tier: 'epic',      weight: 12 },
    { type: 'rocket',    name: 'Ракета',           emoji: '🚀',  value: 50, tier: 'epic',      weight: 10 },
    { type: 'champagne', name: 'Шампанское',       emoji: '🍾',  value: 50, tier: 'epic',      weight: 9  },
    { type: 'bouquet',   name: 'Букет',            emoji: '💐',  value: 50, tier: 'epic',      weight: 6  },
    { type: 'cup',       name: 'Кубок',            emoji: '🏆',  value: 100, tier: 'legendary', weight: 3  },
    { type: 'ring',      name: 'Кольцо',           emoji: '💍',  value: 100, tier: 'legendary', weight: 2  },
    { type: 'diamond',   name: 'Алмаз',            emoji: '💎',  value: 100,tier: 'legendary', weight: 1  }
];


// ===== ПЕР-КЕЙСОВЫЕ ПУЛЫ ПРИЗОВ =====
// displayPct — что показывается пользователю (список шансов в модалке)
// weight     — реальный вес для розыгрыша (может НЕ совпадать с displayPct)
const CASE_GIFT_POOLS = {
    daily: [
        { type:'coin1',  name:'1 F',   emoji:'⭐', value:1,    tier:'common', displayPct:64,   weight:80 },
        { type:'coin2',  name:'2 F',   emoji:'⭐', value:2,    tier:'common', displayPct:15,   weight:10 },
        { type:'coin5',  name:'5 F',   emoji:'⭐', value:5,    tier:'common', displayPct:5,    weight:5  },
        { type:'coin10', name:'10 F',  emoji:'⭐', value:10,   tier:'common', displayPct:4,    weight:3  },
        { type:'bear',    name:'Мишка',  emoji:'🐻', value:15,   tier:'rare',      displayPct:3,    weight:1 },
        { type:'rose',    name:'Роза',   emoji:'🌹', value:25,   tier:'rare',      displayPct:3,    weight:1 },
        { type:'rocket',  name:'Ракета', emoji:'🚀', value:50,  tier:'epic',      displayPct:3,    weight:0 },
        { type:'diamond', name:'Алмаз',  emoji:'💎', value:100, tier:'legendary', displayPct:2,    weight:0 },
        { type:'nft_instant_ramen', name:'Дошик',    emoji:'🍜', value:500, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_bow_tie',       name:'Бабочка',  emoji:'🎀', value:200, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    free: [
        { type:'coin1',  name:'1 F',   emoji:'⭐', value:1,  tier:'common', displayPct:64, weight:80 },
        { type:'coin2',  name:'2 F',   emoji:'⭐', value:2,  tier:'common', displayPct:15, weight:10 },
        { type:'coin5',  name:'5 F',   emoji:'⭐', value:5,  tier:'common', displayPct:5,  weight:5 },
        { type:'coin10', name:'10 F',  emoji:'⭐', value:10, tier:'common', displayPct:4,  weight:3 },
        { type:'bear',   name:'Мишка', emoji:'🐻', value:15, tier:'rare', displayPct:3, weight:1 },
        { type:'rose',   name:'Роза',  emoji:'🌹', value:25, tier:'rare', displayPct:3, weight:1 },
    ],
    stars15: [
        { type:'coin1',  name:'1 F',   emoji:'⭐', value:1,   tier:'common', displayPct:32,   weight:60 },
        { type:'coin5',  name:'5 F',   emoji:'⭐', value:5,   tier:'common', displayPct:20,   weight:5  },
        { type:'coin10', name:'10 F',  emoji:'⭐', value:10,  tier:'common', displayPct:15,   weight:3  },
        { type:'bear',    name:'Мишка',  emoji:'🐻', value:15,   tier:'rare',      displayPct:15,   weight:1 },
        { type:'rose',    name:'Роза',   emoji:'🌹', value:25,   tier:'rare',      displayPct:10,   weight:1 },
        { type:'rocket',  name:'Ракета', emoji:'🚀', value:50,  tier:'epic',      displayPct:3,    weight:0 },
        { type:'diamond', name:'Алмаз',  emoji:'💎', value:100, tier:'legendary', displayPct:2,    weight:0 },
        { type:'nft_bow_tie',      name:'Бабочка',        emoji:'🎀', value:200, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_cookie_heart', name:'Печенька-сердце', emoji:'🍪', value:400, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_fresh_socks',  name:'Новогодний носок', emoji:'🧦', value:540, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    stars50: [
        { type:'coin10', name:'10 F',  emoji:'⭐', value:10,   tier:'common', displayPct:40,   weight:44 },
        { type:'bear',    name:'Мишка',  emoji:'🐻', value:15,   tier:'rare',      displayPct:10,   weight:15 },
        { type:'rose',    name:'Роза',   emoji:'🌹', value:25,   tier:'rare',      displayPct:10,   weight:15 },
        { type:'rocket',  name:'Ракета', emoji:'🚀', value:50,  tier:'epic',      displayPct:15,   weight:15 },
        { type:'diamond', name:'Алмаз',  emoji:'💎', value:100, tier:'legendary', displayPct:15,   weight:10 },
        { type:'nft_lunar_snake', name:'Змейка (2025)',      emoji:'🐍', value:600, tier:'legendary', isNFT:true, real:true, displayPct:0.3333, weight:0.3333 },
        { type:'nft_pet_snake',   name:'Змейка в коробке',   emoji:'🐍', value:700, tier:'legendary', isNFT:true, real:true, displayPct:0.3333, weight:0.3333 },
        { type:'nft_snow_globe',  name:'Новогодняя сфера',   emoji:'🔮', value:1000, tier:'legendary', isNFT:true, real:true, displayPct:0.3334, weight:0.3334 },
    ],
    stars67: [
        { type:'bear',    name:'Мишка',  emoji:'🐻', value:15,  tier:'rare',      displayPct:5,    weight:27 },
        { type:'rose',    name:'Роза',   emoji:'🌹', value:25,  tier:'rare',      displayPct:10,   weight:27 },
        { type:'coin52',  name:'52 F',   emoji:'⭐', value:52,  tier:'common',    displayPct:30.2, weight:27 },
        { type:'coin69',  name:'69 F',   emoji:'⭐', value:69,  tier:'common',    displayPct:31.9, weight:18 },
        { type:'diamond', name:'Алмаз',  emoji:'💎', value:100,tier:'legendary', displayPct:6.9,  weight:0 },
        { type:'nft_fresh_socks', name:'Новогодний носок', emoji:'🧦', value:540, tier:'legendary', isNFT:true, real:true, displayPct:0.5, weight:0.5 },
        { type:'nft_flamingo',    name:'Фламинго',          emoji:'🦩', value:700, tier:'legendary', isNFT:true, real:true, displayPct:0.5, weight:0.5 },
    ],
    stars200: [
        { type:'bear',    name:'Мишка', emoji:'🐻', value:15,   tier:'rare',      displayPct:20, weight:20 },
        { type:'rose',    name:'Роза',  emoji:'🌹', value:25,   tier:'rare',      displayPct:28, weight:28 },
        { type:'rocket',  name:'Ракета',emoji:'🚀', value:50,  tier:'epic',      displayPct:15, weight:15 },
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100, tier:'legendary', displayPct:20, weight:20 },
        { type:'coin200', name:'200 F', emoji:'⭐', value:200,  tier:'common',    displayPct:10, weight:10 },
        { type:'coin300', name:'300 F', emoji:'⭐', value:300,  tier:'common',    displayPct:5,  weight:5.5  },
        // ТЗ «Кейс за 200⭐»: Party Sparkler — реальный дроп, Фен — для вида (0%). «Какаха» отсутствует в наборе NFT (нет ассета).
        { type:'nft_party_sparkler', name:'Party Sparkler', emoji:'🎇', value:500, tier:'legendary', isNFT:true, real:true,     displayPct:1.5, weight:1.5 },
        { type:'nft_ionic_dryer',    name:'Фен',            emoji:'💨', value:2300, tier:'epic',      isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    stars500: [
        { type:'rocket',  name:'Ракета',emoji:'🚀', value:50,  tier:'epic',      displayPct:15, weight:15 },
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100, tier:'legendary', displayPct:60, weight:63 },
        { type:'coin200', name:'200 F', emoji:'⭐', value:200,  tier:'common',    displayPct:10, weight:10 },
        { type:'coin300', name:'300 F', emoji:'⭐', value:300,  tier:'common',    displayPct:10, weight:10 },
        // ТЗ «Кейс за 500⭐»: Флакон духов → для вида (0%); Шляпа ведьмы и Снуп Дог → реальный дроп.
        { type:'nft_witch_hat',      name:'Шляпа ведьмы', emoji:'🧙', value:689, tier:'legendary', isNFT:true, real:true,     displayPct:1, weight:1 },
        { type:'nft_snoop_dogg',     name:'Снуп Дог',     emoji:'🕶️', value:750, tier:'legendary', isNFT:true, real:true,     displayPct:1, weight:1 },
        { type:'nft_perfume_bottle', name:'Флакон духов', emoji:'🧴', value:6077, tier:'epic',      isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    stars1000: [
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100, tier:'legendary', displayPct:60, weight:60 },
        { type:'coin200', name:'200 F', emoji:'⭐', value:200,  tier:'common',    displayPct:10, weight:10 },
        { type:'coin300', name:'300 F', emoji:'⭐', value:300,  tier:'common',    displayPct:10, weight:10 },
        // ТЗ «Покой в богатстве»: ВСЕ NFT — статус «для вида» (0%). Кепка удалена, добавлены Vintage Cigar и Bling Binky.
        { type:'nft_swiss_watch',   name:'Швейцарские часы', emoji:'⌚', value:1200, tier:'epic',      isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_vintage_cigar', name:'Vintage Cigar',    emoji:'🚬', value:1500, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_bling_binky',   name:'Bling Binky',      emoji:'🍼', value:1500, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    stars2000: [
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100, tier:'legendary', displayPct:25, weight:25 },
        { type:'coin200', name:'200 F', emoji:'⭐', value:200,  tier:'common',    displayPct:20, weight:20 },
        { type:'coin300', name:'300 F', emoji:'⭐', value:300,  tier:'common',    displayPct:20, weight:20 },
        // ТЗ «Олигарх»: ВСЕ NFT — статус «для вида» (0%). Носки и Цилиндр удалены; добавлены Кепка, Кот, Westside Sign.
        { type:'nft_scared_cat',     name:'Кот',           emoji:'🐱', value:9775, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_westside_sign',  name:'Westside Sign', emoji:'🤟', value:2000, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
        { type:'nft_electric_skull', name:'Электро-череп', emoji:'💀', value:4200, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    stars25: [
        { type:'coin5',   name:'5 F',   emoji:'⭐', value:5,   tier:'common',    displayPct:30, weight:49.5 },
        { type:'coin10',  name:'10 F',  emoji:'⭐', value:10,  tier:'common',    displayPct:25, weight:20 },
        { type:'bear',    name:'Мишка', emoji:'🐻', value:15,  tier:'rare',      displayPct:18, weight:14 },
        { type:'rose',    name:'Роза',  emoji:'🌹', value:25,  tier:'rare',      displayPct:12, weight:9  },
        { type:'rocket',  name:'Ракета',emoji:'🚀', value:50, tier:'epic',      displayPct:8,  weight:5  },
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100,tier:'legendary', displayPct:5,  weight:2  },
        { type:'nft_cookie_heart', name:'Печенька-сердце', emoji:'🍪', value:400, tier:'legendary', isNFT:true, real:true, displayPct:0.25, weight:0.25 },
        { type:'nft_bow_tie',      name:'Бабочка',         emoji:'🎀', value:200, tier:'legendary', isNFT:true, real:true, displayPct:0.25, weight:0.25 },
    ],
    stars100: [
        { type:'bear',    name:'Мишка', emoji:'🐻', value:15,  tier:'rare',      displayPct:35, weight:35 },
        { type:'rose',    name:'Роза',  emoji:'🌹', value:25,  tier:'rare',      displayPct:30, weight:30 },
        { type:'rocket',  name:'Ракета',emoji:'🚀', value:50, tier:'epic',      displayPct:15, weight:15 },
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100,tier:'legendary', displayPct:10, weight:10 },
        { type:'coin150', name:'150 F', emoji:'⭐', value:150, tier:'common',   displayPct:9,  weight:8  },
        // ТЗ «Кейс за 100⭐»: Носок — реальный дроп, Хрустальный шар → для вида (0%). «Факел» отсутствует в наборе NFT (нет ассета).
        { type:'nft_fresh_socks',  name:'Носок',           emoji:'🧦', value:540,  tier:'legendary', isNFT:true, real:true,     displayPct:2, weight:2 },
        { type:'nft_crystal_ball', name:'Хрустальный шар', emoji:'🔮', value:1119, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
    strike: [
        { type:'coin10',  name:'10 F',  emoji:'⭐', value:10,  tier:'common',    displayPct:35, weight:40 },
        { type:'coin52',  name:'52 F',  emoji:'⭐', value:52,  tier:'common',    displayPct:22, weight:20 },
        { type:'bear',    name:'Мишка', emoji:'🐻', value:15,  tier:'rare',      displayPct:15, weight:13 },
        { type:'rose',    name:'Роза',  emoji:'🌹', value:25,  tier:'rare',      displayPct:12, weight:10 },
        { type:'rocket',  name:'Ракета',emoji:'🚀', value:50, tier:'epic',      displayPct:9,  weight:6  },
        { type:'diamond', name:'Алмаз', emoji:'💎', value:100,tier:'legendary', displayPct:5,  weight:3  },
        // ТЗ «Страйк»: Кепка Дурова удалена, взамен — Кольцо со статусом «для вида» (0%).
        { type:'nft_bonded_ring', name:'Кольцо', emoji:'💍', value:900, tier:'legendary', isNFT:true, showcase:true, displayPct:0, weight:0 },
    ],
};

function getCaseGiftPool(type) {
    return CASE_GIFT_POOLS[type] || (typeof CASE_GIFTS !== 'undefined' ? CASE_GIFTS : []);
}

// Потолок «дешёвого» NFT (в F). NFT дороже него остаётся
// только «витриной» в списке шансов (weight 0, реально не выпадает), а дешевле —
// разыгрывается с указанным displayPct. Дешёвые NFT (≈до 4 TON) = ~800 F.
const CHEAP_NFT_MAX = 800;

// Реальная стоимость NFT в монетах (F) по живому флору с fragment (× курс TON→F).
function nftLiveValue(type) {
    if (typeof NFT_GIFTS === 'undefined') return null;
    const g = NFT_GIFTS.find(x => x.type === type);
    if (!g) return null;
    const p = (window.NFT_PRICES || {})[g.name];
    const fixed = (typeof nftCoinOverride === 'function') ? Number(nftCoinOverride(g.name)) : 0;
    if (fixed > 0) return fixed;
    const apiCoins = p && Number(p.value_coins) > 0 ? Number(p.value_coins) : 0;
    if (apiCoins > 0) return apiCoins;
    const ton = (p && p.price_ton) ? Number(p.price_ton) : (g.priceTon || 0);
    if (!ton) return null;
    const rate = (typeof NFT_TON_TO_COINS !== 'undefined' && NFT_TON_TO_COINS > 0) ? NFT_TON_TO_COINS : 200;
    return Math.max(1, Math.round(ton * rate));
}

// Синхронизирует цены NFT в пулах кейсов с реальным флором и раздаёт веса:
// дешёвый NFT → weight = displayPct (выпадает), дорогой/без цены → weight 0 (витрина).
function normalizeCaseNftPrices() {
    if (typeof CASE_GIFT_POOLS === 'undefined') return;
    Object.keys(CASE_GIFT_POOLS).forEach(k => {
        CASE_GIFT_POOLS[k].forEach(item => {
            const isNft = item.isNFT === true || (typeof item.type === 'string' && item.type.indexOf('nft_') === 0);
            if (!isNft) return;
            // ТЗ: явный статус приза приоритетнее авто-логики по флору.
            //  showcase:true → «для вида» — шанс СТРОГО 0% (только витрина);
            //  real:true    → «реальный дроп» — выпадает с ненулевым шансом всегда.
            if (item.showcase === true) { item.weight = 0; return; }
            const v = nftLiveValue(item.type);
            if (item.real === true) {
                if (v != null) item.value = v;            // подтягиваем реальный флор, если знаем
                item.weight = Number(item.displayPct) || 1;
                return;
            }
            // Легаси-NFT без явного статуса — прежнее поведение (по флору).
            if (v == null) { item.weight = 0; return; }   // цену не знаем — не разыгрываем
            item.value = v;                                // корректная цена (фикс task: «цена нфт неправильная»)
            item.weight = (v <= CHEAP_NFT_MAX) ? (Number(item.displayPct) || 0) : 0;
        });
    });
}

function pickWeightedFromPool(pool) {
    const total = pool.reduce((s,g) => s + (g.weight||0), 0);
    if (total <= 0) return pool[0];
    let rnd = Math.random() * total;
    for (const g of pool) { rnd -= (g.weight||0); if (rnd <= 0) return g; }
    return pool[pool.length-1];
}
// ===== /ПЕР-КЕЙСОВЫЕ ПУЛЫ ПРИЗОВ =====

function pickWeightedCaseGift() {
    const total = CASE_GIFTS.reduce((s,g) => s + g.weight, 0);
    let rnd = Math.random() * total;
    for (const g of CASE_GIFTS) { rnd -= g.weight; if (rnd <= 0) return g; }
    return CASE_GIFTS[CASE_GIFTS.length - 1];
}

let pendingCasePrize = null;
let pendingCaseType  = null;
let pendingCaseCurrency = 'silver';   // валюта, которой открыли кейс → в ней и приз
let pendingCaseServerSettled = false;
let pendingCaseServerBalance = null;
let selectedCaseType = null;
let selectedCaseCurrency = 'silver';

function selectCase(type) {
    selectedCaseType = type;
    const cfg = CASE_CONFIG[type];
    if (!cfg) return;

    const modal = $id('case-select-modal');
    if (!modal) return;

    const caseTier = getCaseArtworkTier(type);
    const caseAsset = CASE_TEMPLATE_ARTWORK[type];
    const artworkEl = modal.querySelector('.case-modal-artwork');
    if (artworkEl) {
        if (artworkEl.tagName === 'IMG') {
            artworkEl.src = CASE_TIER_ARTWORK[caseTier];
            if (caseAsset) artworkEl.src = caseAsset;
            artworkEl.alt = `Кейс «${cfg.name}»`;
        } else {
            artworkEl.innerHTML = caseArtworkMarkup(type, 'modal');
            artworkEl.setAttribute('aria-label', `Иллюстрация кейса «${cfg.name}»`);
        }
        artworkEl.dataset.caseTier = caseTier;
        artworkEl.dataset.caseType = type;
    }

    const nameEl = $id('case-modal-name');
    if (nameEl) {
        nameEl.innerHTML = (cfg.emoji ? cfg.emoji + ' ' : '') + cfg.name;
    }

    const priceEl = $id('case-modal-price');
    if (priceEl) {
        if (cfg.free) priceEl.innerHTML = '<span style="color:#4ade80;font-weight:800;">Бесплатно</span>';
        else if (cfg.strike) priceEl.textContent = 'Требуется 7 дней подряд депозита';
        else priceEl.innerHTML =
            '<span style="color:#c4b5fd;font-weight:700;">' + cfg.silverCost + ' F серебра</span>' +
            ' &nbsp;или&nbsp; ' +
            '<span style="color:#fcd34d;font-weight:700;">' + cfg.goldCost + ' 🟡 золота</span>';
    }

    const currDiv = $id('case-modal-currency');
    if (cfg.free || cfg.strike) {
        if (currDiv) currDiv.style.display = 'none';
        selectedCaseCurrency = null;
    } else {
        if (currDiv) currDiv.style.display = 'block';
        selectedCaseCurrency = 'silver';
        setCaseCurrency('silver');
    }

    // Подарки из per-кейсового пула (с фиксированными «отображаемыми» процентами)
    renderCaseOddsList(type);

    checkCaseBalance();
    modal.style.display = 'flex';
}

// Символ валюты в списке содержимого кейса должен совпадать с той, за которую открываем
// (серебро → F, золото → 🟡) — приз всегда выпадает в выбранной валюте.
function renderCaseOddsList(type) {
    const oddsList = $id('case-odds-list');
    if (!oddsList) return;
    const pool = getCaseGiftPool(type);
    const usesFixedPct = !!CASE_GIFT_POOLS[type];
    const weights = pool.map(g => g.weight);
    const total = weights.reduce((a,b)=>a+b,0) || 1;
    const curSym = (selectedCaseCurrency === 'gold') ? '🟡' : 'F';
    oddsList.innerHTML = '';
    const isNftItem = (g) => g.isNFT === true || (typeof g.type === 'string' && g.type.indexOf('nft_') === 0);
    const nftItems = [];
    pool.forEach((g, i) => {
        if (isNftItem(g)) { nftItems.push({ g, pct: usesFixedPct ? g.displayPct : Math.round(weights[i]/total*100) }); return; }
        const pct = usesFixedPct ? g.displayPct : Math.round(weights[i]/total*100);
        const pctLabel = (pct % 1 === 0) ? pct : pct.toString().replace('.', ',');
        const el = document.createElement('div');
        el.className = 'case-odds-item';
        el.innerHTML =
            '<div class="case-odds-left">'
            + '<span class="case-odds-emoji">' + (typeof giftIcon==='function' ? giftIcon(g,28) : g.emoji) + '</span>'
            + '<div><div class="case-odds-name">' + g.name + '</div>'
            + (g.value ? '<div class="case-odds-val">' + g.value + ' ' + curSym + '</div>' : '') + '</div>'
            + '</div>';
        oddsList.appendChild(el);
    });
    // Все NFT — одной строкой с РОТАЦИЕЙ: иконки NFT сменяют друг друга (сначала один,
    // потом следующий), справа подписано название и цена текущего NFT, общий шанс — одним числом.
    if (nftItems.length) {
        // ТЗ: проценты шансов NFT в UI не показываем — только витрина призов.
        const el = document.createElement('div');
        el.className = 'case-odds-item';
        el.innerHTML =
            '<div class="case-odds-left" style="align-items:center;">'
            + '<span class="case-odds-emoji" id="nft-rot-icon" style="display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;transition:opacity .35s;"></span>'
            + '<div><div class="case-odds-name">NFT-подарок <span style="font-size:0.62rem;background:#a855f7;color:#fff;padding:1px 6px;border-radius:5px;font-weight:900;">NFT</span></div>'
            + '<div class="case-odds-val" id="nft-rot-name" style="transition:opacity .35s;">—</div></div>'
            + '</div>';
        oddsList.appendChild(el);
        startNftRotation(nftItems, curSym);
    }
}

// Ротация NFT в свёрнутой строке шансов: меняем иконку+название по кругу с плавным затуханием.
let _nftRotTimer = null;
function startNftRotation(nftItems, curSym) {
    if (_nftRotTimer) { clearInterval(_nftRotTimer); _nftRotTimer = null; }
    let idx = 0;
    const render = () => {
        const iconEl = document.getElementById('nft-rot-icon');
        const nameEl = document.getElementById('nft-rot-name');
        if (!iconEl || !nameEl) { if (_nftRotTimer) { clearInterval(_nftRotTimer); _nftRotTimer = null; } return; }
        const it = nftItems[idx % nftItems.length];
        const g = it.g;
        iconEl.innerHTML = (typeof giftIcon === 'function') ? giftIcon(g, 28) : (g.emoji || '🎁');
        nameEl.textContent = g.name + (g.value ? ' · ' + g.value + ' ' + curSym : '');
    };
    render();
    if (nftItems.length < 2) return; // нечего вращать
    _nftRotTimer = setInterval(() => {
        const iconEl = document.getElementById('nft-rot-icon');
        const nameEl = document.getElementById('nft-rot-name');
        if (!iconEl || !nameEl) { clearInterval(_nftRotTimer); _nftRotTimer = null; return; }
        iconEl.style.opacity = '0'; nameEl.style.opacity = '0';
        setTimeout(() => { idx++; render(); iconEl.style.opacity = '1'; nameEl.style.opacity = '1'; }, 350);
    }, 1800);
}

function openCaseAnimation() {
    const CASE_GIFTS_CONFIG = typeof CASE_GIFTS !== 'undefined' ? CASE_GIFTS : GIFT_SYSTEM.gifts;
    const weights = CASE_GIFTS_CONFIG.map(g => g.weight || 10);
    const total   = weights.reduce((a,b) => a+b, 0);
    let rand = Math.random() * total;
    let prize = CASE_GIFTS_CONFIG[CASE_GIFTS_CONFIG.length - 1];
    for (let i = 0; i < CASE_GIFTS_CONFIG.length; i++) {
        rand -= weights[i];
        if (rand <= 0) { prize = CASE_GIFTS_CONFIG[i]; break; }
    }

    const overlay = document.createElement('div');
    overlay.id = 'case-open-overlay';
    overlay.style.cssText = [
        'position:fixed','inset:0','z-index:2000',
        'background:rgba(0,0,0,0.93)',
        'display:flex','flex-direction:column',
        'align-items:center','justify-content:center',
        'animation:fadeIn 0.3s ease'
    ].join(';');

    const content = document.createElement('div');
    content.style.cssText = 'text-align:center;';

    const boxEl = document.createElement('div');
    boxEl.style.cssText = [
        'font-size:5rem','line-height:1',
        'animation:caseShake 0.6s ease',
        'margin-bottom:24px','filter:drop-shadow(0 0 30px rgba(123,92,255,0.8))'
    ].join(';');
    boxEl.textContent = '🎁';

    const opening = document.createElement('div');
    opening.style.cssText = 'color:#888;font-size:0.9rem;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;';
    opening.textContent = 'Открываем...';

    content.appendChild(boxEl);
    content.appendChild(opening);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    setTimeout(() => {
        boxEl.style.animation = 'casePop 0.5s ease forwards';
        boxEl.innerHTML = typeof giftIcon === 'function' ? giftIcon(prize, 100) : (prize.emoji || '🎁');
        opening.textContent = '';

        const prizeLabel = document.createElement('div');
        prizeLabel.style.cssText = [
            'color:#fff','font-size:1.3rem','font-weight:900',
            'margin-bottom:8px','animation:fadeIn 0.4s ease'
        ].join(';');
        prizeLabel.textContent = prize.name || 'Подарок';

        const prizeVal = document.createElement('div');
        prizeVal.style.cssText = [
            'background:rgba(123,92,255,0.15)',
            'border:1.5px solid rgba(123,92,255,0.4)',
            'border-radius:12px','padding:8px 20px',
            'color:#c4b5fd','font-weight:800','font-size:1rem',
            'display:inline-block','margin-bottom:24px',
            'animation:fadeIn 0.5s ease'
        ].join(';');
        prizeVal.textContent = '⚪ ' + (prize.value || prize.minValue || 0) + ' F';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Забрать!';
        closeBtn.style.cssText = [
            'padding:14px 40px','border:none','border-radius:14px',
            'background:linear-gradient(135deg,#7b5cff,#a855f7)',
            'color:#fff','font-size:1rem','font-weight:800',
            'cursor:pointer','font-family:inherit',
            'box-shadow:0 4px 20px rgba(123,92,255,0.5)',
            'animation:fadeIn 0.6s ease'
        ].join(';');
        closeBtn.onclick = () => {
            overlay.remove();
            if (typeof showGiftChoiceModal === 'function' && (prize.value || prize.minValue) >= 15) {
                showGiftChoiceModal(prize, prize.value || prize.minValue);
            } else if (typeof showSmallWinModal === 'function') {
                showSmallWinModal(prize.value || prize.minValue || 0);
            }
        };

        content.appendChild(prizeLabel);
        content.appendChild(prizeVal);
        content.appendChild(closeBtn);
    }, 1200);
}

function closeCaseSelectModal() {
    const modal = $id('case-select-modal');
    if (modal) modal.style.display = 'none';
    selectedCaseType = null;
    selectedCaseCurrency = 'silver';
    if (_nftRotTimer) { clearInterval(_nftRotTimer); _nftRotTimer = null; }
}

function setCaseCurrency(type) {
    setCaseCurrencyModal(type);
}

function setCaseCurrencyModal(type) {
    selectedCaseCurrency = type;
    const silverBtn = $id('case-currency-silver-modal');
    const goldBtn   = $id('case-currency-gold-modal');
    if (silverBtn) { silverBtn.classList.toggle('active', type === 'silver'); }
    if (goldBtn)   { goldBtn.classList.toggle('active', type === 'gold'); }
    const silverBtnOld = $id('case-currency-silver');
    const goldBtnOld   = $id('case-currency-gold');
    if (silverBtnOld) silverBtnOld.classList.toggle('active', type === 'silver');
    if (goldBtnOld)   goldBtnOld.classList.toggle('active', type === 'gold');
    if (selectedCaseType) renderCaseOddsList(selectedCaseType);
    checkCaseBalance();
}

function confirmOpenCaseModal() { confirmOpenCase(); }

function checkCaseBalance() {
    const cfg = CASE_CONFIG[selectedCaseType];
    if (!cfg) return;
    const warning  = $id('case-balance-warning-modal') || $id('case-balance-warning');
    const warning2 = $id('case-balance-warning');
    const btn  = $id('case-open-btn-modal');
    const btn2 = $id('case-open-btn');
    const balEl = $id('case-modal-balance');

    const silver = userData.balance.silver || 0;
    const gold   = userData.balance.gold   || 0;
    if (balEl) balEl.innerHTML =
        '<span style="color:#c4b5fd;">' + silver + ' F</span>' +
        ' &nbsp;•&nbsp; ' +
        '<span style="color:#fcd34d;">' + gold + ' 🟡</span>';

    if (cfg.free || cfg.strike) {
        if (warning)  warning.style.display  = 'none';
        if (warning2) warning2.style.display = 'none';
        [btn, btn2].forEach(b => { if (b) { b.disabled = false; b.style.opacity = '1'; } });
        return;
    }
    const currency = selectedCaseCurrency || 'silver';
    const cost    = currency === 'gold' ? (cfg.goldCost || 0) : (cfg.silverCost || 0);
    const balance = currency === 'gold' ? gold : silver;
    const enough  = balance >= cost;
    const warnText = 'Недостаточно ' + (currency === 'gold' ? '🟡 золота' : 'F серебра') + '!';
    [warning, warning2].forEach(w => {
        if (!w) return;
        w.style.display = enough ? 'none' : 'block';
        w.textContent   = warnText;
    });
    [btn, btn2].forEach(b => { if (b) { b.disabled = !enough; b.style.opacity = enough ? '1' : '0.45'; } });
}

function showCasesList() {
    const listPanel = $id('cases-list-panel');
    const openPanel = $id('case-open-panel');
    if (listPanel) listPanel.style.display = 'block';
    if (openPanel) openPanel.style.display = 'none';
}

async function confirmOpenCase() {
    const cfg = CASE_CONFIG[selectedCaseType];
    if (!cfg) return;

    let serverClaim = null;

    if (cfg.strike) {
        const streak = userData.depositStreak || 0;
        if (streak < 7) { showNotif('Нужно ' + (7-streak) + ' дней подряд депозита!', '#f87171'); return; }
    }

    if (cfg.free) {
        // Доступ и ограничение 24 часа проверяются только сервером. Локальное
        // хранилище здесь не используем: его можно очистить или подменить.
        const freeClaim = await claimFreeCaseServer(selectedCaseType);
        if (!freeClaim.ok) {
            if (freeClaim.reason === 'daily_already_claimed') {
                if (selectedCaseType === 'free') setFreeCaseCooldown(freeClaim);
                showNotif('🎁 ' + cfg.name + ' можно открывать раз в 24 часа.', '#f87171');
            } else if (selectedCaseType === 'free') {
                showSubGateModal(freeClaim);
            } else {
                showNotif('🎁 Ежедневный кейс можно открывать раз в 24 часа.', '#f87171');
            }
            return;
        }
        applyRocketServerBalance(freeClaim, true);
        serverClaim = freeClaim;
        if (selectedCaseType === 'free') setFreeCaseCooldown(serverClaim);
        userData.lastDailyCase = new Date().toISOString();
    }

    if (!cfg.free || cfg.dailyOnly === false) {
        const currency = cfg.strike ? 'silver' : (selectedCaseCurrency || 'silver');
        const cost = currency === 'gold' ? (cfg.goldCost || 0) : (cfg.silverCost || 0);
        const balance = Number(userData.balance[currency] || 0);
        if (!cfg.strike && balance < cost) {
            showNotif('Недостаточно ' + (currency === 'gold' ? '🟡 золота' : 'F серебра') + '!', '#f87171');
            return;
        }
        try {
            serverClaim = await fleepGameApi('/game/case/open', {
                type: selectedCaseType,
                currency,
                action_id: fleepActionId('case_open')
            });
            applyRocketServerBalance(serverClaim, true);
            if (currency === 'silver' && cost > 0) addWager(cost);
        } catch (e) {
            if (e && e.data) applyRocketServerBalance(e.data, true);
            const error = e && e.data && e.data.error;
            if (error === 'insufficient_balance') {
                showNotif('Недостаточно ' + (currency === 'gold' ? '🟡 золота' : 'F серебра') + '!', '#f87171');
            } else if (error === 'strike_streak_required') {
                showNotif('Нужно 7 дней подряд пополнения!', '#f87171');
            } else {
                showNotif('Не удалось открыть кейс. Попробуйте ещё раз.', '#f87171');
            }
            return;
        }
    }

    const caseTypeToOpen = selectedCaseType;
    // ВАЖНО: валюту фиксируем ДО закрытия модалки — closeCaseSelectModal() сбрасывает
    // selectedCaseCurrency на 'silver', и без этого золотой кейс выдавал серебряный приз.
    const currencyToUse = cfg.strike ? 'silver' : (selectedCaseCurrency || 'silver');
    closeCaseSelectModal();
    openCase(caseTypeToOpen, currencyToUse, serverClaim && serverClaim.prize, serverClaim);
    saveUserData();
    updateBalance();
}

function freeCaseAccessFallback(reason = 'check_failed') {
    return {
        ok: false,
        reason,
        referral_count: 0,
        referrals_required: 3,
        referrals_remaining: 3,
        referral_link: referralData?.link || null,
    };
}

// Проверка доступа к бесплатному кейсу. Переход засчитывается сервером в
// момент /start ref_<code>; клики по кнопке и localStorage намеренно не считаются.
async function checkFreeAccess() {
    const userId = tg?.initDataUnsafe?.user?.id;
    const initData = await waitForTelegramInitData();
    if (!initData) return freeCaseAccessFallback('unauthorized');
    try {
        const headers = { 'X-Telegram-Init-Data': initData };
        const r = await fetch(BACKEND_URL + '/check_free_access?user_id=' + (userId || ''), { headers });
        if (!r.ok) return freeCaseAccessFallback('check_failed');
        return await r.json();
    } catch (e) { return freeCaseAccessFallback('check_failed'); }
}

async function claimFreeCaseServer(caseType = 'free') {
    const randomPart = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : Date.now() + '_' + Math.random().toString(36).slice(2);
    try {
        return await fleepGameApi('/game/case/open', {
            type: caseType,
            currency: 'silver',
            action_id: caseType + '_case_' + randomPart
        });
    } catch (e) {
        const data = e && e.data ? e.data : {};
        return {
            ...data,
            ok: false,
            reason: data.reason || data.error || 'check_failed',
            referral_count: Number(data.referral_count) || 0,
            referrals_required: Number(data.referrals_required) || 3,
            referrals_remaining: Number(data.referrals_remaining) || 3,
            referral_link: data.referral_link || referralData?.link || null,
        };
    }
}

function escapeFreeCaseHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function freeCaseInviteMessage(link = '') {
    return '🎁 БЕСПЛАТНЫЙ КЕЙС\n\nПригласи 3 друзей и получи доступ к бесплатному кейсу. Его можно крутить раз в 24 часа.\n\nОткрытие: ' + String(link || '');
}

async function shareFreeCaseInvite(access = {}) {
    let link = access.referral_link || referralData?.link;
    if (!link) {
        const loaded = await loadReferralData(true);
        link = loaded?.link || referralData?.link;
    }
    if (!link) {
        showNotif('Реферальная ссылка пока недоступна.', '#f87171');
        return;
    }
    const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(link)
        + '&text=' + encodeURIComponent(freeCaseInviteMessage(link));
    try {
        if (typeof tg?.openTelegramLink === 'function') tg.openTelegramLink(shareUrl);
        else if (typeof tg?.openLink === 'function') tg.openLink(shareUrl);
        else window.open(shareUrl, '_blank', 'noopener');
    } catch (e) {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(link).catch(() => {});
            showNotif('📋 Ссылка скопирована — отправьте её друзьям.', '#8b5cf6');
        } else alert(link);
    }
}

// Модалка приглашения друзей по персональной реферальной ссылке.
function showSubGateModal(access) {
    const old = document.getElementById('sub-gate-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'sub-gate-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;justify-content:center;';
    overlay.onclick = () => overlay.remove();
    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:#13131f;border-radius:24px 24px 0 0;padding:22px 20px 40px;width:100%;max-width:520px;';
    sheet.onclick = e => e.stopPropagation();
    const count = Math.max(0, Number(access?.referral_count) || 0);
    const required = Math.max(1, Number(access?.referrals_required) || 3);
    const remaining = Math.max(0, Number.isFinite(Number(access?.referrals_remaining))
        ? Number(access.referrals_remaining) : required - count);
    const link = access?.referral_link || referralData?.link || '';
    const reasonMessage = access?.reason === 'unauthorized'
        ? 'Откройте мини-приложение через Telegram и попробуйте ещё раз.'
        : access?.reason === 'check_failed'
            ? 'Не удалось обновить прогресс. Попробуйте проверить ещё раз через несколько секунд.'
            : '';
    sheet.innerHTML =
        '<div style="width:40px;height:4px;background:#2a2a3a;border-radius:2px;margin:0 auto 18px;"></div>'
        + '<div style="text-align:center;font-size:1.15rem;font-weight:900;color:#fff;margin-bottom:6px;">🎁 Бесплатный кейс</div>'
        + '<div style="text-align:center;font-size:0.85rem;color:#aaa;line-height:1.4;margin-bottom:14px;">Пригласи 3 друзей — это откроет бесплатный кейс. После этого его можно крутить раз в 24 часа.</div>'
        + '<div style="padding:14px 16px;border-radius:14px;background:#1a1a2a;border:1px solid #32275c;text-align:center;margin-bottom:12px;">'
        + '<div style="font-size:1.15rem;font-weight:900;color:#fff;">' + count + ' / ' + required + '</div>'
        + '<div style="font-size:.78rem;color:#a9a3c7;margin-top:4px;">уникальных друзей перешли по ссылке</div></div>'
        + (remaining > 0 ? '<div style="text-align:center;font-size:.8rem;color:#fbbf24;margin-bottom:12px;">Осталось переходов: ' + remaining + '</div>' : '')
        + (reasonMessage ? '<div style="padding:12px 14px;border-radius:12px;background:#2a1d0a;border:1px solid #8a5a14;color:#fbbf24;font-size:.8rem;line-height:1.35;margin-bottom:12px;">' + reasonMessage + '</div>' : '')
        + (link ? '<div style="padding:10px 12px;border-radius:12px;background:#10101a;color:#aaa;font-size:.72rem;line-height:1.35;word-break:break-all;margin-bottom:10px;">' + escapeFreeCaseHtml(link) + '</div>' : '')
        + '<button id="free-case-share" style="width:100%;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#7b5cff,#5b35d5);color:#fff;font-size:.95rem;font-weight:800;cursor:pointer;margin-top:2px;">📤 Пригласить друзей</button>'
        + '<button id="sub-gate-recheck" style="width:100%;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:.95rem;font-weight:800;cursor:pointer;margin-top:8px;">🔄 Проверить переходы</button>';
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    document.getElementById('free-case-share').onclick = () => shareFreeCaseInvite(access);
    document.getElementById('sub-gate-recheck').onclick = async () => {
        const btn = document.getElementById('sub-gate-recheck');
        btn.textContent = 'Проверяю…'; btn.disabled = true;
        const a = await checkFreeAccess();
        if (a && a.ok) { overlay.remove(); showNotif('✅ Доступ открыт! Крути кейс', '#22c55e'); confirmOpenCase(); }
        else { overlay.remove(); showSubGateModal(a); }
    };
}


function showCoinWinModal(amount, betType) {
    const existing = document.getElementById('coin-win-overlay');
    if (existing) existing.remove();

    const isSilver = betType !== 'gold';
    const color  = isSilver ? '#c084fc' : '#fbbf24';
    const symbol = isSilver ? 'F' : '🟡';
    const label  = isSilver ? 'серебра' : 'золота';

    const el = document.createElement('div');
    el.id = 'coin-win-overlay';
    el.style.cssText = `
        position:fixed;inset:0;z-index:3000;
        background:rgba(0,0,0,0.88);
        display:flex;flex-direction:column;
        align-items:center;justify-content:center;
        animation:fadeInUp .3s ease;
    `;
    el.innerHTML = `
        <style>
        @keyframes coinBounce { 0%{transform:scale(0.3) rotate(-20deg);opacity:0} 60%{transform:scale(1.15) rotate(5deg)} 100%{transform:scale(1) rotate(0);opacity:1} }
        @keyframes fadeInUp { from{opacity:0;transform:translateY(30px)} to{opacity:1;transform:none} }
        @keyframes shimmerCoin { 0%,100%{box-shadow:0 0 20px ${color}55} 50%{box-shadow:0 0 50px ${color}cc, 0 0 80px ${color}44} }
        </style>
        <div style="text-align:center;padding:0 32px;">
            <div style="font-size:5rem;margin-bottom:16px;animation:coinBounce .55s cubic-bezier(.34,1.56,.64,1) forwards;display:inline-block;">${symbol}</div>
            <div style="font-size:2rem;font-weight:900;color:#fff;margin-bottom:8px;text-shadow:0 0 30px ${color};">+${amount}</div>
            <div style="font-size:1rem;color:rgba(255,255,255,0.5);margin-bottom:28px;">${label} зачислено на баланс</div>
            <button onclick="document.getElementById('coin-win-overlay').remove()" style="
                padding:14px 48px;border:none;border-radius:16px;
                background:linear-gradient(135deg,${color},${isSilver?'#7c3aed':'#d97706'});
                color:#fff;font-size:1rem;font-weight:900;cursor:pointer;
                box-shadow:0 6px 24px ${color}66;font-family:inherit;">
                Забрать!
            </button>
        </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => {
        const overlay = document.getElementById('coin-win-overlay');
        if (overlay) overlay.remove();
    }, 4000);
}

function openCase(type, forcedCurrency, serverPrize, serverSettlement) {
    if (type === 'free' && (!serverPrize || !serverPrize.type)) {
        showNotif('Бесплатный кейс доступен после выполнения условий по реферальной ссылке.', '#f87171');
        return;
    }
    pendingCaseType = type;
    // Валюта приза = валюта, которой открыли (за серебро → приз в F, за золото → в 🟡).
    // forcedCurrency передаётся из confirmOpenCase (зафиксирована до сброса selectedCaseCurrency).
    pendingCaseCurrency = forcedCurrency || selectedCaseCurrency || 'silver';
    const curSym = pendingCaseCurrency === 'gold' ? '🟡' : 'F';

    // Взвешенный выбор победителя: реальный вес (weight), НЕ отображаемый %
    const pool = getCaseGiftPool(type).length
        ? getCaseGiftPool(type)
        : [{ type:'gift', name:'Подарок', emoji:'🎁', value:25, weight:10 }];

    let winner;
    if (serverPrize && serverPrize.type) {
        const local = pool.find(g => g.type === serverPrize.type);
        winner = Object.assign({}, local || {}, serverPrize);
    } else {
        const totalW = pool.reduce((s, g) => s + (g.weight || 0), 0) || 1;
        let rnd = Math.random() * totalW;
        winner = pool[0];
        for (const g of pool) { rnd -= (g.weight || 0); if (rnd <= 0) { winner = g; break; } }
    }
    pendingCasePrize = winner;
    pendingCaseServerSettled = !!serverPrize;
    pendingCaseServerBalance = serverSettlement && typeof serverSettlement === 'object'
        ? {
            gold_coins: serverSettlement.gold_coins,
            silver_coins: serverSettlement.silver_coins,
            balance_revision: serverSettlement.balance_revision,
        }
        : null;

    const modal = document.getElementById('case-open-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const spinResult = document.getElementById('spin-result');
    if (spinResult) spinResult.style.display = 'none';

    const track = document.getElementById('spin-track');
    if (!track) return;
    track.style.transition = 'none';
    track.style.transform  = 'translateX(0)';
    track.innerHTML = '';

    const ITEM_W   = 110; // px ширина + gap
    const WIN_POS  = 58;
    const TOTAL    = 80;
    const isNFT    = winner.isNFT || (typeof NFT !== 'undefined' && NFT.gifts.find(g => g.slug === winner.type));

    const tierColor = (t) => ({
        legendary: { bg:'rgba(251,191,36,0.18)', border:'rgba(251,191,36,0.7)', glow:'rgba(251,191,36,0.5)' },
        epic:      { bg:'rgba(168,85,247,0.18)',  border:'rgba(168,85,247,0.7)', glow:'rgba(168,85,247,0.5)' },
        rare:      { bg:'rgba(59,130,246,0.18)',   border:'rgba(59,130,246,0.7)', glow:'rgba(59,130,246,0.5)' },
        common:    { bg:'rgba(123,92,255,0.1)',    border:'rgba(123,92,255,0.3)', glow:'rgba(123,92,255,0.3)' },
    }[t] || { bg:'rgba(123,92,255,0.1)', border:'rgba(123,92,255,0.3)', glow:'rgba(123,92,255,0.3)' });

    // Спокойная честная лента: ячейки наполняются из пула самого кейса
    // (без искусственного «флуда богатыми NFT»), выигрыш — по весам.
    for (let i = 0; i < TOTAL; i++) {
        const g = (i === WIN_POS) ? winner : pool[Math.floor(Math.random() * pool.length)];
        const isWin = i === WIN_POS;
        const tc = tierColor(g.tier || 'common');

        const el = document.createElement('div');
        el.style.cssText = `
            min-width:100px;height:100px;border-radius:14px;
            background:${isWin ? tc.bg : 'rgba(255,255,255,0.04)'};
            border:${isWin ? `2px solid ${tc.border}` : '1.5px solid rgba(255,255,255,0.08)'};
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            flex-shrink:0;gap:4px;transition:transform 0.15s;
            ${isWin ? `box-shadow:0 0 20px ${tc.glow};` : ''}
        `;

        const emoji = g.emoji || '🎁';
        const valLabel = `${g.value}${curSym}`;
        const tierBadge = g.tier && g.tier !== 'common'
            ? `<span style="font-size:0.42rem;font-weight:900;padding:1px 5px;border-radius:4px;background:${tierColor(g.tier).border};color:#fff;letter-spacing:0.5px;">${g.isNFT?'NFT':g.tier.toUpperCase()}</span>`
            : '';

        el.innerHTML = `
            <span style="font-size:2.2rem;line-height:1;">${typeof giftIcon==='function'?giftIcon(g,40):emoji}</span>
            <span style="font-size:0.58rem;color:${g.tier==='legendary'?'#fbbf24':g.tier==='epic'?'#a855f7':g.tier==='rare'?'#60a5fa':'#a98fff'};font-weight:700;">${valLabel}</span>
            ${tierBadge}
        `;
        track.appendChild(el);
    }

    const viewportW = document.getElementById('spin-viewport')?.offsetWidth || 320;
    // Центрируем по РЕАЛЬНОЙ геометрии выигрышной ячейки (а не по хардкод-пикселям),
    // иначе приз останавливается сбоку от маркера («уходит влево»).
    const winCell = track.children[WIN_POS];
    const cellCenter = winCell
        ? winCell.offsetLeft + winCell.offsetWidth / 2
        : WIN_POS * ITEM_W + 60;
    const targetOffset = cellCenter - viewportW / 2;

    requestAnimationFrame(() => requestAnimationFrame(() => {
        track.style.transition = 'transform 4.5s cubic-bezier(0.08, 0.82, 0.17, 1)';
        track.style.transform  = `translateX(-${targetOffset}px)`;
    }));

    // Подсвечиваем победителя
    setTimeout(() => {
        const winEl = track.children[WIN_POS];
        if (winEl) {
            const tc = tierColor(winner.tier || 'common');
            winEl.style.background   = tc.bg;
            winEl.style.borderColor  = tc.border;
            winEl.style.boxShadow    = `0 0 30px ${tc.glow}, 0 0 60px ${tc.glow}44`;
            winEl.style.transform    = 'scale(1.08)';
        }

        // Результат
        const prizeIcon  = document.getElementById('spin-prize-icon');
        const prizeName  = document.getElementById('spin-prize-name');
        const prizeValue = document.getElementById('spin-prize-value');
        const winIconHtml = (typeof giftIcon==='function') ? giftIcon(winner, winner.isNFT?72:80) : `<span style="font-size:4rem">${winner.emoji}</span>`;
        if (prizeIcon)  prizeIcon.innerHTML  = winner.isNFT
            ? `${winIconHtml}<span style="font-size:0.7rem;display:block;background:#a855f7;color:#fff;padding:2px 8px;border-radius:6px;margin-top:4px;font-weight:900;">NFT</span>`
            : winIconHtml;
        if (prizeName)  prizeName.textContent  = winner.name;
        if (prizeValue) prizeValue.textContent = `${winner.value} ${curSym}`;

        if (spinResult) spinResult.style.display = 'block';

        // 🎉 Мини-анимация празднования для дорогого дропа
        const tier = winner.tier || 'common';
        const pricey = winner.isNFT || tier === 'legendary' || tier === 'epic' || (winner.value || 0) >= 100;
        if (pricey) celebrateBigWin(tier, winner.isNFT);
    }, 4700);
}

// Празднование редкого дропа: конфетти + вспышка + сияние
function celebrateBigWin(tier, isNFT) {
    const host = document.getElementById('case-open-modal') || document.body;
    if (!host) return;
    const palette = isNFT || tier === 'legendary'
        ? ['#fbbf24','#f59e0b','#fff7c2','#ffd54f','#ff8a65']
        : tier === 'epic'
            ? ['#a855f7','#c084fc','#e9d5ff','#7c3aed','#f0abfc']
            : ['#60a5fa','#3b82f6','#bfdbfe','#818cf8','#a78bfa'];

    // Вспышка
    const flash = document.createElement('div');
    flash.style.cssText = 'position:absolute;inset:0;z-index:40;pointer-events:none;border-radius:inherit;'
        + 'background:radial-gradient(circle at 50% 42%,'+palette[0]+'55,transparent 60%);'
        + 'animation:bwFlash .7s ease-out forwards;';
    host.appendChild(flash);

    // Лучи-сияние за призом
    const rays = document.createElement('div');
    rays.style.cssText = 'position:absolute;left:50%;top:42%;width:340px;height:340px;margin:-170px 0 0 -170px;z-index:41;'
        + 'pointer-events:none;background:conic-gradient(from 0deg,'+palette[0]+'00,'+palette[0]+'66,'+palette[0]+'00,'+palette[1]+'55,'+palette[0]+'00);'
        + 'border-radius:50%;filter:blur(2px);opacity:0;animation:bwRays 2.4s ease-out forwards;';
    host.appendChild(rays);

    // Конфетти
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;z-index:42;pointer-events:none;overflow:hidden;border-radius:inherit;';
    const N = (isNFT || tier === 'legendary') ? 90 : 60;
    for (let i = 0; i < N; i++) {
        const p = document.createElement('div');
        const c = palette[Math.floor(Math.random()*palette.length)];
        const left = Math.random()*100;
        const dur = 1.6 + Math.random()*1.6;
        const delay = Math.random()*0.5;
        const size = 6 + Math.random()*8;
        const rnd = (Math.random()*260-130).toFixed(0);
        const round = Math.random() < 0.35 ? '50%' : '2px';
        p.style.cssText = 'position:absolute;top:-24px;left:'+left+'%;width:'+size+'px;height:'+(size*0.5+3)+'px;'
            + 'background:'+c+';border-radius:'+round+';opacity:0;--dx:'+rnd+'px;'
            + 'animation:bwConfetti '+dur+'s cubic-bezier(.2,.7,.3,1) '+delay+'s forwards;';
        layer.appendChild(p);
    }
    host.appendChild(layer);

    if (window.Telegram?.WebApp?.HapticFeedback) {
        try { window.Telegram.WebApp.HapticFeedback.notificationOccurred('success'); } catch(e){}
    }

    setTimeout(() => { flash.remove(); rays.remove(); layer.remove(); }, 3600);
}

function claimCasePrize() {
    if (!pendingCasePrize) return;
    const val = pendingCasePrize.value;

    // Монеты (F) — НЕ в инвентарь, а сразу на баланс
    const isCoin = typeof pendingCasePrize.type === 'string' && pendingCasePrize.type.indexOf('coin') === 0;
    const cur = (pendingCaseCurrency === 'gold') ? 'gold' : 'silver';
    const curSym = cur === 'gold' ? '🟡' : 'F';
    if (isCoin) {
        if (pendingCaseServerSettled) {
            // The server already credited the prize atomically. Re-apply the
            // same post-settlement snapshot synchronously so a stale bootstrap
            // request cannot hide the credit while the animation is open.
            if (pendingCaseServerBalance) applyRocketServerBalance(pendingCaseServerBalance);
            else syncGoldFromServer();
        } else {
            userData.balance = userData.balance || { silver:0, gold:0 };
            userData.balance[cur] = (userData.balance[cur] || 0) + val;   // приз в валюте, которой крутили
        }
        userData.casesHistory = userData.casesHistory || [];
        userData.casesHistory.unshift({ timestamp:new Date().toISOString(), case:pendingCaseType||'unknown', reward:pendingCasePrize.name, val });
        if (userData.casesHistory.length > 20) userData.casesHistory = userData.casesHistory.slice(0,20);
        saveUserData();
        updateBalance();
        updateCasesHistory();
        document.getElementById('case-open-modal').style.display = 'none';
        showNotif('💰 +' + val + ' ' + curSym + ' на баланс!', cur === 'gold' ? '#fbbf24' : '#c084fc');
        pendingCasePrize = null;
        pendingCaseType  = null;
        pendingCaseServerSettled = false;
        pendingCaseServerBalance = null;
        return;
    }

    // Добавляем подарок в инвентарь
    if (!userData.inventory) userData.inventory = [];
    const tier = (pendingCasePrize && pendingCasePrize.tier) || (val >= 500 ? 'legendary' : val >= 100 ? 'epic' : val >= 15 ? 'rare' : 'common');
    userData.inventory.push({
        id: pendingCasePrize.gift_id || Date.now(),
        type: pendingCasePrize.type,
        name: pendingCasePrize.name,
        value: val,
        currency: cur,
        tier: tier,
        receivedDate: new Date().toISOString(),
        status: 'active',
        source: 'case',
        wagerStart: (userData.stats && userData.stats.totalWagered) || 0
    });

    userData.casesHistory.unshift({
        timestamp: new Date().toISOString(),
        case: pendingCaseType || 'unknown',
        reward: pendingCasePrize.name,
        val
    });
    if (userData.casesHistory.length > 20) userData.casesHistory = userData.casesHistory.slice(0,20);
    saveUserData();
    updateBalance();
    updateCasesHistory();
    if (typeof updateInventory === 'function') updateInventory();
    if (typeof updateProfileGifts === 'function') updateProfileGifts();
    document.getElementById('case-open-modal').style.display = 'none';
    showNotif('🎁 Подарок добавлен в инвентарь!', '#7b5cff');
    pendingCasePrize = null;
    pendingCaseType  = null;
    pendingCaseServerSettled = false;
    pendingCaseServerBalance = null;
}

function closeCaseModal() {
    document.getElementById('case-open-modal').style.display = 'none';
    pendingCasePrize = null;
    pendingCaseType  = null;
    pendingCaseServerSettled = false;
    pendingCaseServerBalance = null;
}

function updateCasesHistory() {
    const list = $id('cases-history-list');
    if (!list) return;
    list.innerHTML = '';
    (userData.casesHistory||[]).slice(0,10).forEach(c => {
        const d = new Date(c.timestamp);
        const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const item = document.createElement('div');
        item.className = 'history-item win';
        item.innerHTML = `<span>${time}</span><span>${c.reward}</span><span>+${c.val}F</span>`;
        list.appendChild(item);
    });
}

// ===== ИНВЕНТАРЬ =====
function updateInventory() {
    const GIFT_ICONS = {
        bear:'🐻',heart:'❤️',rose:'🌹',gift:'🎁',cake:'🎂',
        champagne:'🍾',bouquet:'💐',rocket:'🚀',cup:'🏆',
        ring:'💍',diamond:'💎',crown:'👑',star:'⭐',flame:'🔥'
    };

    function renderMcGrid(gridId, items) {
        const grid = document.getElementById(gridId);
        if (!grid) return;
        grid.innerHTML = '';
        if (!items.length) return;
        const EMOJIS = {bear:'🧸',heart:'❤️',rose:'🌹',gift:'🎁',cake:'🎂',champagne:'🥂',bouquet:'💐',cup:'🏆',ring:'💍',diamond:'💎',crown:'👑',rocket:'🚀',star:'⭐'};
        items.forEach(g => {
            const icon = EMOJIS[g.type] || '🎁';
            const isSold = g.status==='sold';
            const card = document.createElement('div');
            const tierClass = g.tier ? 'tier-'+g.tier : 'tier-common'; card.className = 'inv-gift-card ' + tierClass + (isSold?' inv-gift-card-sold':'');
            const tierNames = {common:'Обычный',rare:'Редкий',epic:'Эпический',legendary:'Легендарный'};
            const tierName = tierNames[g.tier||'common']||'Обычный';
            const curSym = (g.currency === 'gold') ? '🟡' : '<span class="coin-symbol silver">F</span>';
            card.innerHTML =

                '<div class="inv-gift-emoji">'+giftIcon(g,52)+'</div>'+
                '<div class="inv-gift-name">'+(g.name||'Подарок')+'</div>'+
                '<div class="inv-gift-value">'+curSym+'<span>'+(g.minValue||g.value||0)+'</span></div>'+
                
                (!isSold ? '<div style="font-size:0.6rem;color:#555;margin-top:6px;">нажми для управления</div>' : '');
            if (!isSold) card.onclick = () => showManageGiftModal(g.id);
            grid.appendChild(card);
        });
    }

    const now = Date.now();
    const active=[], ready=[], sold=[];
    (userData.inventory||[]).forEach(g => {
        if (g.status==='sold') { sold.push(g); return; }
        if (g.status==='withdrawn' || g.status==='withdraw_pending') { sold.push({...g, name:(g.name||'Подарок') + (g.status === 'withdraw_pending' ? ' (вывод запрошен)' : ' (выведен)')}); return; }
        const unlock = new Date(g.receivedDate || Date.now()).getTime() + 21*24*60*60*1000;
        if (now >= unlock) ready.push(g); else active.push(g);
    });
    renderMcGrid('inventory-active-grid', active);
    renderMcGrid('inventory-ready-grid',  ready);
    renderMcGrid('inventory-sold-grid',   sold);
    // Обновляем счётчики
    const elActive = document.getElementById('inv-count-active');
    const elReady = document.getElementById('inv-count-ready');
    const elTotal = document.getElementById('inv-total-value');
    if (elActive) elActive.textContent = active.length;
    if (elReady) elReady.textContent = ready.length;
    const allItems = [...active, ...ready];
    const totalVal = allItems.reduce((s, g) => s + (g.value||0), 0);
    if (elTotal) elTotal.textContent = totalVal;
    // Показываем/скрываем empty states
    const emptyActive = document.getElementById('no-active-items');
    const emptyReady = document.getElementById('no-ready-items');
    const emptySold = document.getElementById('no-sold-items');
    if (emptyActive) emptyActive.style.display = active.length ? 'none' : 'block';
    if (emptyReady) emptyReady.style.display = ready.length ? 'none' : 'block';
    if (emptySold) emptySold.style.display = sold.length ? 'none' : 'block';
}

function showInventoryTab(tab) {
    document.querySelectorAll('.inv-tab-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.inv-tab-btn').forEach(b => b.classList.remove('active'));
    const content = document.getElementById('inventory-'+tab);
    if (content) content.classList.add('active');
    const activeBtn = document.getElementById('invtab-'+tab);
    if (activeBtn) activeBtn.classList.add('active');
}

// ===== ПОДАРКИ =====
const GIFT_EMOJIS = {bear:'🧸',heart:'❤️',rose:'🌹',gift:'🎁',cake:'🎂',champagne:'🥂',bouquet:'💐',cup:'🏆',ring:'💍',diamond:'💎',nft_flamingo:'🦩',coin200:'⭐',coin300:'⭐'};
const GIFT_IMGS = {
    coin50: 'assets/gifts/coin50.png',
    coin52: 'assets/gifts/coin50.png',
    coin69: 'assets/gifts/coin50.png',
    coin100: 'assets/gifts/coin50.png',
    coin150: 'assets/gifts/coin50.png',
    coin300: 'assets/gifts/coin50.png',
    coin600: 'assets/gifts/coin50.png',
    coin1000: 'assets/gifts/coin50.png',
    coin1500: 'assets/gifts/coin50.png',
    coin2500: 'assets/gifts/coin50.png',
    coin4000: 'assets/gifts/coin50.png',
    coin7000: 'assets/gifts/coin50.png',
    coin1: 'assets/gifts/coin50.png',
    coin2: 'assets/gifts/coin50.png',
    coin5: 'assets/gifts/coin50.png',
    coin10: 'assets/gifts/coin50.png',
    bear: 'assets/gifts/bear.png',
    heart: 'assets/gifts/heart.png',
    rose: 'assets/gifts/rose.png',
    gift: 'assets/gifts/gift.png',
    cake: 'assets/gifts/cake.png',
    bouquet: 'assets/gifts/bouquet.png',
    cup: 'assets/gifts/cup.png',
    ring: 'assets/gifts/ring.png',
    diamond: 'assets/gifts/diamond.png',
    rocket: 'assets/gifts/rocket.png',
    champagne: 'assets/gifts/champagne.png',
};
const GIFT_ASSET_VERSION = 'img3';
function giftAssetUrl(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    const encoded = encodeURI(raw);
    return encoded + (encoded.indexOf('?') >= 0 ? '&' : '?') + 'v=' + GIFT_ASSET_VERSION;
}

let _NFT_IMG_MAP = null;
// Буква валюты: золото → G, серебро → F
function curLetter(cur) { return cur === 'gold' ? '🟡' : 'F'; }

// Compatibility resolver for inventory records created by older versions.
// Some of those records have a localized name or a generic type, while the
// NFT catalog keeps the canonical Telegram slug. Resolve all known aliases
// before falling back to an emoji.
function normalizeGiftImageKey(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[^a-z0-9\u0400-\u04ff]+/gi, '_')
        .replace(/^_+|_+$/g, '');
}

function addNftImageKey(map, key, image) {
    const raw = String(key || '').trim();
    if (!raw || !image) return;
    map[raw] = image;
    const normalized = normalizeGiftImageKey(raw);
    if (normalized) map[normalized] = image;
}

function buildNftImageMap() {
    const map = {};
    try {
        const catalog = (typeof NFT_GIFTS !== 'undefined' && Array.isArray(NFT_GIFTS)) ? NFT_GIFTS : [];
        catalog.forEach(g => {
            if (!g || !g.img) return;
            addNftImageKey(map, g.type, g.img);
            addNftImageKey(map, String(g.type || '').replace(/^nft_/, ''), g.img);
            addNftImageKey(map, g.name, g.img);
            addNftImageKey(map, g.slug, g.img);
        });

        // Case pools contain localized labels such as "Бабочка" for the
        // canonical NFT type nft_bow_tie. Keep those old labels working.
        const poolItems = [];
        if (typeof CASE_GIFT_POOLS !== 'undefined' && CASE_GIFT_POOLS) {
            Object.keys(CASE_GIFT_POOLS).forEach(key => {
                if (Array.isArray(CASE_GIFT_POOLS[key])) poolItems.push(...CASE_GIFT_POOLS[key]);
            });
        }
        if (typeof CASE_GIFTS !== 'undefined' && Array.isArray(CASE_GIFTS)) poolItems.push(...CASE_GIFTS);
        poolItems.forEach(item => {
            const image = map[item && item.type] || map[normalizeGiftImageKey(item && item.type)];
            if (image && item) addNftImageKey(map, item.name, image);
        });
    } catch (e) {}
    return map;
}

function nftImgByType(type, name, slug) {
    if (_NFT_IMG_MAP === null || Object.keys(_NFT_IMG_MAP).length === 0) _NFT_IMG_MAP = buildNftImageMap();
    const gift = type && typeof type === 'object' ? type : null;
    const candidates = gift
        ? [gift.type, gift.slug, gift.name, gift.title, gift.meta && gift.meta.type, gift.meta && gift.meta.slug, gift.meta && gift.meta.name]
        : [type, slug, name];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const raw = String(candidate).trim();
        const normalized = normalizeGiftImageKey(raw);
        if (_NFT_IMG_MAP[raw]) return _NFT_IMG_MAP[raw];
        if (_NFT_IMG_MAP[normalized]) return _NFT_IMG_MAP[normalized];
    }
    return null;
}

function giftIcon(type, size) {
    size = size || 64;
    const gift = type && typeof type === 'object' ? type : null;
    const giftType = gift ? gift.type : type;
    const nftImg = nftImgByType(gift || giftType, gift && gift.name, gift && gift.slug);
    if (nftImg) {
        return '<img loading="lazy" decoding="async" src="' + giftAssetUrl(nftImg) + '" width="' + size + '" height="' + size + '" style="object-fit:contain;display:inline-block;margin:0 auto;" alt="" onerror="this.onerror=null;this.style.display=\'none\'">';
    }
    if (GIFT_IMGS[giftType]) {
        const isCoin = typeof giftType === 'string' && giftType.indexOf('coin') === 0;
        const filter = isCoin ? 'filter:grayscale(1) brightness(1.18) contrast(1.05);' : '';
        return '<img loading="lazy" decoding="async" src="' + giftAssetUrl(GIFT_IMGS[giftType]) + '" width="' + size + '" height="' + size + '" style="object-fit:contain;display:inline-block;margin:0 auto;' + filter + '" alt="">';
    }
    const em = GIFT_EMOJIS[giftType] || '🎁';
    return '<span style="font-size:' + Math.round(size * 0.55) + 'px;line-height:1">' + em + '</span>';
}

function showGiftChoiceModal(gift, winAmount) {
    const tier = winAmount >= 2000 ? 'legendary' : winAmount >= 500 ? 'rare' : winAmount >= 100 ? 'epic' : 'common';
    // Валюта выигрыша = валюта, которой играли (золото/серебро)
    const winCur = (gameState.betType === 'gold') ? 'gold' : 'silver';
    currentNewGift = { ...gift, id: Date.now(), value: winAmount, tier: tier, currency: winCur, receivedDate: new Date().toISOString(), status: 'active' };
    notifyAdminNftWin(currentNewGift);
    const emoji = GIFT_EMOJIS[gift.type] || '🎁';
    const giftCost  = gift.minValue || 0;
    const remainder = Math.max(0, winAmount - giftCost);
    const sellPrice = winAmount;

    const iconEl = document.getElementById('new-gift-icon');
    const nameEl = document.getElementById('new-gift-name');
    const tierEl = document.getElementById('new-gift-tier');
    const valEl  = document.getElementById('new-gift-value');
    const sellEl = document.getElementById('sell-amount');
    const keepEl = document.getElementById('keep-coins-label');

    if (iconEl) { iconEl.innerHTML = giftIcon(gift, 90); }
    if (nameEl) nameEl.textContent = gift.name;
    if (tierEl) { tierEl.textContent = ''; tierEl.style.display='none'; }
    if (valEl)  valEl.textContent  = winAmount;
    if (sellEl) sellEl.textContent = sellPrice;
    const sellCurEl = document.getElementById('sell-cur');
    if (sellCurEl) sellCurEl.textContent = curLetter(winCur);
    if (keepEl) keepEl.textContent = remainder > 0 ? '+ '+remainder+' '+curLetter(winCur)+' остаток на баланс' : '';

    // Закрываем все другие модалы чтобы не перекрывали
    const manageModal = document.getElementById('manage-gift-modal');
    if (manageModal) manageModal.style.display = 'none';

    const modal = document.getElementById('new-gift-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.alignItems = 'flex-end';
        modal.style.justifyContent = 'center';
    }
}

function closeNewGiftModal() {
    const m = document.getElementById('new-gift-modal');
    if (m) m.style.display = 'none';
}
function keepGift() {
    if (!currentNewGift) { closeNewGiftModal(); return; }
    if (!userData.inventory) userData.inventory = [];
    const giftToSave = { ...currentNewGift, minValue: currentNewGift.minValue || 0, wagerStart: (userData.stats && userData.stats.totalWagered) || 0 };
    userData.inventory.push(giftToSave);
    const cur = (currentNewGift.currency === 'gold') ? 'gold' : 'silver';
    const giftCost  = currentNewGift.minValue || 0;
    const remainder = Math.max(0, (currentNewGift.value||0) - giftCost);
    // Legacy local gift modal: it cannot mint a balance. Server-authoritative
    // games already return a persisted gift and payout snapshot.
    saveUserData();
    closeNewGiftModal();
    currentNewGift = null;
    updateInventory();
    if (typeof updateProfileGifts === 'function') updateProfileGifts();
    if (typeof showNotif==='function') showNotif('🎁 Подарок в инвентаре!' + (remainder>0?' +'+remainder+' '+curLetter(cur):''), '#7b5cff');
}

function sellGift() {
    if (!currentNewGift) return;
    const cur = (currentNewGift.currency === 'gold') ? 'gold' : 'silver';
    const sellPrice = currentNewGift.value || 0;
    // A legacy local gift has no server gift_id and must never create coins.
    if (typeof syncGoldFromServer === 'function') syncGoldFromServer();
    saveUserData();
    closeNewGiftModal();
    currentNewGift = null;
    if (typeof showNotif==='function') showNotif('💰 Продано за '+sellPrice+' '+curLetter(cur),'#22c55e');
}

async function showManageGiftModal(giftId) {
    try { await syncServerInventory(); } catch (e) {}
    const gift = (userData.inventory||[]).find(g => String(g.id) === String(giftId));
    if (!gift || gift.status === 'sold' || gift.status === 'withdrawn' || gift.status === 'withdraw_pending') return;
    
    const sellPrice = gift.minValue || gift.value || 0;
    const receivedDate = new Date(gift.receivedDate || Date.now());
    const serverRules = gift.withdrawal || null;
    const WITHDRAW_CD_MS = 21*24*60*60*1000;
    const unlockDate = new Date(receivedDate.getTime() + WITHDRAW_CD_MS);
    const now = new Date();
    const cdOk = now.getTime() >= unlockDate.getTime();
    const daysLeft = cdOk ? 0 : Math.ceil((unlockDate.getTime() - now.getTime()) / (24*60*60*1000));

    const giftVal = gift.value || 0;
    const wagerNeed = Math.max(0, Number(serverRules?.required_turnover) || 0);
    const wagered = Math.max(0, Number(serverRules?.turnover) || 0);
    const wagerLeft = Math.max(0, wagerNeed - wagered);
    const canWithdraw = serverRules ? serverRules.eligible === true : cdOk;

    const emoji = (function() {
        const m = {bear:'🧸',heart:'❤️',rose:'🌹',gift:'🎁',cake:'🎂',champagne:'🥂',bouquet:'💐',cup:'🏆',ring:'💍',diamond:'💎',crown:'👑',rocket:'🚀'};
        return m[gift.type] || '🎁';
    })();
    
    // Create a bottom-sheet modal
    let overlay = document.getElementById('manage-gift-overlay');
    if (overlay) overlay.remove();
    
    overlay = document.createElement('div');
    overlay.id = 'manage-gift-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.8);display:flex;align-items:flex-end;justify-content:center;';
    overlay.onclick = () => overlay.remove();
    
    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:#13131f;border-radius:24px 24px 0 0;padding:20px 20px 48px;width:100%;max-width:520px;';
    sheet.onclick = e => e.stopPropagation();
    
    let withdrawBtn;
    if (canWithdraw) {
        withdrawBtn = `<button onclick="withdrawGift(${giftId})" style="width:100%;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:0.95rem;font-weight:800;cursor:pointer;margin-bottom:10px;">📤 Вывести подарок</button>`;
    } else if (serverRules?.reason === 'turnover_required') {
        const pct = wagerNeed > 0 ? Math.min(100, Math.floor((wagered / wagerNeed) * 100)) : 0;
        withdrawBtn = `<div style="margin-bottom:10px;">
            <button disabled style="width:100%;padding:14px;border:1.5px solid #2a2a3a;border-radius:14px;background:#1a1a2a;color:#888;font-size:0.88rem;font-weight:700;cursor:not-allowed;">🔒 Отыграй ещё ${wagerLeft} 🟡 золотого оборота</button>
            <div style="margin-top:8px;height:8px;background:#1a1a2a;border-radius:6px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#7b5cff,#a855f7);"></div></div>
            <div style="font-size:0.68rem;color:#8a8a9a;margin-top:5px;text-align:center;">Отыграно ${wagered} / ${wagerNeed} 🟡 за 7 дней после разблокировки</div>
        </div>`;
    } else if (serverRules?.reason === 'turnover_expired') {
        withdrawBtn = `<button disabled style="width:100%;padding:14px;border:1.5px solid #2a2a3a;border-radius:14px;background:#1a1a2a;color:#888;font-size:0.88rem;font-weight:700;cursor:not-allowed;margin-bottom:10px;">🔒 Срок 7 дней для оборота истёк</button>`;
    } else if (serverRules?.reason === 'withdrawal_cooldown' || !serverRules && !cdOk) {
        const serverDaysLeft = Number(serverRules?.days_left) || daysLeft;
        withdrawBtn = `<button disabled style="width:100%;padding:14px;border:1.5px solid #2a2a3a;border-radius:14px;background:#1a1a2a;color:#555;font-size:0.9rem;font-weight:700;cursor:not-allowed;margin-bottom:10px;">🔒 Вывод через ${serverDaysLeft} ${serverDaysLeft===1?'день':serverDaysLeft<5?'дня':'дней'}</button>`;
    } else {
        // КД прошёл, но не отыгран вейджер
        const pct = wagerNeed > 0 ? Math.min(100, Math.floor((wagered / wagerNeed) * 100)) : 100;
        withdrawBtn = `<div style="margin-bottom:10px;">
            <button disabled style="width:100%;padding:14px;border:1.5px solid #2a2a3a;border-radius:14px;background:#1a1a2a;color:#888;font-size:0.88rem;font-weight:700;cursor:not-allowed;">🔒 Отыграй ещё ${wagerLeft} F для вывода</button>
            <div style="margin-top:8px;height:8px;background:#1a1a2a;border-radius:6px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#7b5cff,#a855f7);"></div></div>
            <div style="font-size:0.68rem;color:#8a8a9a;margin-top:5px;text-align:center;">Отыграно ${wagered} / ${wagerNeed} F (13× стоимости подарка)</div>
        </div>`;
    }

    // Build HTML without nested template literals
    const handle = '<div style="width:40px;height:4px;background:#2a2a3a;border-radius:2px;margin:0 auto 20px;"></div>';
    const giftInfo = '<div style="text-align:center;margin-bottom:20px;">'
        + '<div style="font-size:3.5rem;margin-bottom:10px;">' + (typeof giftIcon==='function'?giftIcon(gift,72):emoji) + '</div>'
        + '<div style="font-size:1.1rem;font-weight:900;color:#fff;margin-bottom:4px;">' + (gift.name||'Подарок') + '</div>'
        + '<div style="font-size:0.78rem;color:#7b5cff;margin-bottom:12px;">Стоимость: <b style="color:#fcd34d">' + (gift.value||0) + ' ' + curLetter(gift.currency) + '</b></div>'
        + '</div>';
    // Gift IDs from the server are strings (rocket_... UUIDs). Do not put
    // them into an unquoted inline handler: hyphens make the handler invalid
    // and the sell request never reaches the backend.
    const sellBtn = '<button data-sell-gift="1" style="width:100%;padding:14px;border:1.5px solid #2a2a3a;border-radius:14px;background:#1a1a2a;color:#ccc;font-size:0.9rem;font-weight:700;cursor:pointer;">'
        + '💰 Продать сейчас — ' + sellPrice + ' ' + curLetter(gift.currency) + '</button>';
    const cancelBtn = '<button onclick="document.getElementById(\'manage-gift-overlay\').remove()" style="width:100%;padding:10px;border:none;background:transparent;color:#444;font-size:0.8rem;cursor:pointer;margin-top:6px;">Отмена</button>';
    sheet.innerHTML = handle + giftInfo + withdrawBtn + sellBtn + cancelBtn;
    const withdrawButton = sheet.querySelector('[onclick^="withdrawGift"], [data-withdraw-gift]');
    if (withdrawButton) {
        withdrawButton.removeAttribute('onclick');
        withdrawButton.onclick = () => withdrawGift(giftId);
    }
    const sellButton = sheet.querySelector('[data-sell-gift]');
    if (sellButton) sellButton.onclick = () => sellGiftFromInventory(giftId);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
}

async function withdrawGift(giftId) {
    const gift = (userData.inventory||[]).find(g => String(g.id) === String(giftId));
    if (!gift) return;

    const overlay = document.getElementById('manage-gift-overlay');
    if (overlay) overlay.remove();

    // Отправляем запрос в Telegram бота через inline кнопку «написать боту»
    const userId = tg?.initDataUnsafe?.user?.id;
    const username = tg?.initDataUnsafe?.user?.username || '';
    const giftName = gift.name || 'Подарок';
    const giftEmoji = ({bear:'🧸',heart:'❤️',rose:'🌹',gift:'🎁',cake:'🎂',champagne:'🥂',bouquet:'💐',cup:'🏆',ring:'💍',diamond:'💎',crown:'👑'})[gift.type] || '🎁';

    // Отправляем на сервер и ЧЕСТНО проверяем ответ (без фейкового «успеха»)
    let ok = false;
    let responseData = {};
    try {
        const resp = await fetch(BACKEND_URL + '/withdraw_gift', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                user_id: userId,
                gift_id: String(gift.id),
                username: username,
                gift_name: giftName,
                gift_emoji: giftEmoji,
                gift_value: gift.value || 0,
                gift_type: gift.type
            })
        });
        responseData = await resp.json().catch(() => ({}));
        ok = resp.ok && responseData && responseData.ok;
    } catch(e) { ok = false; }

    if (!ok) {
        const code = responseData && responseData.error;
        const rules = responseData && responseData.rules;
        if (code === 'turnover_required') {
            showNotif('Для вывода нужно ещё ' + (rules?.turnover_left || 0) + ' 🟡 золотого оборота. Срок: 7 дней.', '#ef4444');
            return;
        }
        if (code === 'turnover_expired') {
            showNotif('Срок 7 дней для золотого оборота истёк — вывод недоступен.', '#ef4444');
            return;
        }
        if (code === 'withdrawal_cooldown') {
            showNotif('Вывод будет доступен через ' + (rules?.days_left || 0) + ' дн.', '#ef4444');
            return;
        }
        if (code === 'already_requested') {
            showNotif('Запрос на вывод уже отправлен администратору.', '#ef4444');
            return;
        }
        showNotif('⚠️ Сервер недоступен — вывод не отправлен. Попробуй позже.', '#ef4444');
        return;
    }

    // Успех подтверждён сервером — помечаем как выведенный
    // The server owns the withdrawal state. Refresh it so a pending request
    // cannot be sold again after a reload or from another device.
    try { await syncServerInventory(); } catch (e) { gift.status = 'withdraw_pending'; }
    showNotif('📤 Запрос на вывод ' + giftEmoji + ' отправлен! Админ пришлёт подарок в Telegram.', '#22c55e');
    if (typeof updateInventory === 'function') updateInventory();
}

// ===== ПОПОЛНЕНИЕ БАЛАНСА (TELEGRAM STARS) =====

// Промокоды: code → bonus multiplier
const PROMO_CODES = {
    'VESNA26': { type: 'bonus', value: 0.20 }   // +20% к пополнению
};

const GIFT_PROMO_CODES = {
    'X7K2M9R4': { gold: 500, silver: 500 }   // 500 золота + 500 серебра
};

let topUpCurrency = 'gold'; // Звёзды → только золотые монеты
let activePromo = null;     // { code, bonus } или null
let topUpTab = 'stars';     // 'stars' | 'usdt'
let usdtInvoice = null;     // текущий USDT инвойс { wallet, amount, coins, expires }
let usdtPollTimer = null;   // таймер ожидания оплаты

const USDT_PACKAGES = [
    { coins: 50,   usdt: 0.75  },
    { coins: 100,  usdt: 1.50  },
    { coins: 250,  usdt: 3.75  },
    { coins: 500,  usdt: 7.50  },
    { coins: 1000, usdt: 15.00 },
];

// Пакеты коинов за прямой TON-платёж (курс TON→коин считает сервер по живой цене)
const TON_PACKAGES = [50, 100, 250, 500, 1000];

// Пакеты звёзд → золотые коины (1 звезда = 1 золотой коин)
const STAR_PACKAGES = [
    { stars: 50,   coins: 50   },
    { stars: 100,  coins: 100  },
    { stars: 250,  coins: 250  },
    { stars: 500,  coins: 500  },
    { stars: 1000, coins: 1000 },
];

function openTopUpModal() {
    const modal = document.getElementById('topup-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.alignItems = 'flex-end';
        modal.style.justifyContent = 'center';
    }
    activePromo = null;
    topUpTab = 'usdt';
    usdtInvoice = null;
    renderStarPackages();
    updatePromoDisplay();
    renderUsdtTab();
    switchTopUpTab('usdt');
    const promoInput = document.getElementById('promo-input');
    if (promoInput) promoInput.value = '';
}

function closeTopUpModal() {
    const modal = document.getElementById('topup-modal');
    if (modal) modal.style.display = 'none';
}

function renderStarPackages() {
    const container = document.getElementById('star-packages');
    if (!container) return;
    container.innerHTML = '';
    STAR_PACKAGES.forEach(pkg => {
        const bonus = activePromo ? activePromo.bonus : 0;
        const finalCoins = Math.floor(pkg.coins * (1 + bonus));
        const hasBonus = bonus > 0;

        const el = document.createElement('div');
        el.className = 'star-pkg-card';
        el.dataset.stars = pkg.stars;
        el.innerHTML = `
            ${hasBonus ? `<div class="star-pkg-bonus-tag">+${Math.round(bonus*100)}%</div>` : ''}
            <div class="star-pkg-emoji">⭐</div>
            <div class="star-pkg-count">${pkg.stars}</div>
            <div class="star-pkg-label">звёзд</div>
            <div class="star-pkg-coins">${finalCoins} 🟡</div>
            ${hasBonus ? `<div class="star-pkg-coins-old">${pkg.coins}</div>` : ''}
        `;
        el.onclick = () => buyStarPackage(pkg.stars, finalCoins);
        container.appendChild(el);
    });

    // Карточка "своя сумма"
    const customCard = document.createElement('div');
    customCard.className = 'star-pkg-card star-pkg-custom';
    customCard.innerHTML = `
        <div class="star-pkg-emoji">✏️</div>
        <div class="star-pkg-label" style="color:#fff;font-weight:800;font-size:0.85rem;margin:4px 0 6px;">Своя сумма</div>
        <input id="custom-stars-input" type="number" min="${MIN_TOPUP_COINS}" max="10000"
            placeholder="Stars"
            onclick="event.stopPropagation()"
            class="star-pkg-custom-input"
        />
    `;
    customCard.onclick = () => {
        const inp = document.getElementById('custom-stars-input');
        const val = parseInt(inp?.value);
        if (!val || val < MIN_TOPUP_COINS) { showNotif(`⚠️ Минимальное пополнение — ${MIN_TOPUP_COINS} ⭐`, '#f87171'); return; }
        const bonus = activePromo ? activePromo.bonus : 0;
        const coins = Math.floor(val * (1 + bonus));
        buyStarPackage(val, coins);
    };
    container.appendChild(customCard);
}

async function applyPromoCode() {
    const inp = document.getElementById('promo-input');
    const code = (inp?.value || '').trim().toUpperCase();
    const promoStatus = document.getElementById('promo-status');
    if (!code) {
        activePromo = null;
        if (promoStatus) promoStatus.textContent = '';
        renderStarPackages();
        updatePromoDisplay();
        return;
    }

    // 1) Секретный подарочный код (мгновенное зачисление) — через бэкенд
    try {
        const userId = tg?.initDataUnsafe?.user?.id;
        if (userId) {
            const r = await fetch(`${BACKEND_URL}/redeem_promo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, code, init_data: tg?.initData || '' })
            });
            const d = await r.json();
            if (d.ok) {
                applyRocketServerBalance(d, true);
                saveUserData(); updateBalance();
                const parts = [];
                if (d.added_gold) parts.push(`🟡 ${d.added_gold}`);
                if (d.added_silver) parts.push(`F ${d.added_silver}`);
                const gained = parts.length ? ' (+' + parts.join(' + ') + ')' : '';
                if (promoStatus) { promoStatus.textContent = '✅ Промокод активирован!' + gained; promoStatus.style.color = '#4ade80'; }
                if (inp) inp.value = '';
                if (typeof showNotif === 'function') showNotif('🎉 Промокод активирован!' + gained, '#7b5cff');
                return;
            }
            if (d.reason === 'already_done') {
                if (promoStatus) { promoStatus.textContent = '⚠️ Промокод уже использован'; promoStatus.style.color = '#f59e0b'; }
                return;
            }
            if (d.reason === 'limit_reached') {
                if (promoStatus) { promoStatus.textContent = '❌ Лимит активаций промокода исчерпан'; promoStatus.style.color = '#f87171'; }
                return;
            }
        }
    } catch (e) {}

    // 2) Промокод-бонус к пополнению (созданный в админке) — проверяем на бэкенде
    try {
        const r = await fetch(`${BACKEND_URL}/check_promo?code=${encodeURIComponent(code)}`);
        const d = await r.json();
        if (d.ok) {
            activePromo = { code, bonus: d.bonus };
            if (promoStatus) {
                promoStatus.textContent = `✅ Промокод применён: +${Math.round(d.bonus*100)}% к пополнению!`;
                promoStatus.style.color = '#4ade80';
            }
            renderStarPackages();
            updatePromoDisplay();
            return;
        }
    } catch (e) {}

    activePromo = null;
    if (promoStatus) {
        promoStatus.textContent = '❌ Неверный промокод';
        promoStatus.style.color = '#f87171';
    }
    renderStarPackages();
    updatePromoDisplay();
}

function updatePromoDisplay() {
    const badge = document.getElementById('active-promo-badge');
    if (!badge) return;
    if (activePromo) {
        badge.style.display = 'block';
        badge.textContent = `🎟 ${activePromo.code}: +${Math.round(activePromo.bonus*100)}%`;
    } else {
        badge.style.display = 'none';
    }
}


// ─── USDT ОПЛАТА ──────────────────────────────────────────────────────────────
function switchTopUpTab(tab) {
    topUpTab = tab;
    const tabs  = { stars:'tab-stars', usdt:'tab-usdt', ton:'tab-ton', withdraw:'tab-withdraw' };
    const bodies= { stars:'topup-stars-body', usdt:'topup-usdt-body', ton:'topup-ton-body', withdraw:'topup-withdraw-body' };
    if (!document.getElementById('tab-stars')) return;
    Object.keys(tabs).forEach(k => {
        const tb = document.getElementById(tabs[k]);
        const bd = document.getElementById(bodies[k]);
        if (tb) tb.classList.toggle('topup-tab-active', k === tab);
        if (bd) bd.style.display = (k === tab) ? 'block' : 'none';
    });
    if (tab === 'withdraw') renderWithdrawTab();
    if (tab === 'ton') renderTonTab();
}

// ─── ВЫВОД НА USDT ──────────────────────────────────────────────────────────────
const MIN_WITHDRAW_COINS = 100;

function renderWithdrawTab() {
    const balEl = document.getElementById('withdraw-balance');
    if (balEl) balEl.textContent = userData.balance.gold || 0;
    const inp = document.getElementById('withdraw-input');
    if (inp) inp.value = '';
    updateWithdrawPreview();
    const status = document.getElementById('withdraw-status');
    if (status) status.textContent = '';
}

function updateWithdrawPreview() {
    const inp = document.getElementById('withdraw-input');
    const prev = document.getElementById('withdraw-preview');
    if (!prev) return;
    const coins = parseInt(inp?.value) || 0;
    const usdt = coins / 66.67;
    prev.textContent = '≈ ' + fixedNumber(usdt, 0) + ' USDT';
}

async function requestWithdrawUsdt() {
    const inp = document.getElementById('withdraw-input');
    const status = document.getElementById('withdraw-status');
    const btn = document.getElementById('withdraw-btn');
    const coins = parseInt(inp?.value) || 0;
    const setStatus = (t, c) => { if (status) { status.textContent = t; status.style.color = c || '#f59e0b'; } };

    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) { setStatus('⚠️ Откройте игру в Telegram', '#f87171'); return; }
    if (coins < MIN_WITHDRAW_COINS) { setStatus('Минимум для вывода — ' + MIN_WITHDRAW_COINS + ' 🟡', '#f87171'); return; }
    if (coins > (userData.balance.gold || 0)) { setStatus('Недостаточно 🟡 на балансе', '#f87171'); return; }

    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    setStatus('⏳ Отправляем вывод…', '#22c55e');
    try {
        const resp = await fetch(`${BACKEND_URL}/withdraw_usdt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                username: tg?.initDataUnsafe?.user?.username || '',
                coins,
            }),
        });
        const d = await resp.json();
        if (d.ok) {
            userData.balance.gold = (typeof d.gold === 'number') ? d.gold : Math.max(0, (userData.balance.gold||0) - coins);
            saveUserData();
            updateBalance();
            renderWithdrawTab();
            setStatus('✅ Выведено ' + (d.usdt?.toFixed ? d.usdt.toFixed(2) : d.usdt) + ' USDT!', '#4ade80');
            if (typeof showNotif === 'function') showNotif('📤 Вывод ' + d.usdt + ' USDT отправлен в @CryptoBot!', '#22c55e');
        } else {
            setStatus('❌ ' + (d.error || 'Не удалось вывести'), '#f87171');
        }
    } catch (e) {
        setStatus('⚠️ Сервер недоступен, попробуй позже', '#f87171');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
}

function renderUsdtTab() {
    const container = document.getElementById('usdt-packages');
    if (!container) return;
    container.innerHTML = '';
    USDT_PACKAGES.forEach(pkg => {
        const el = document.createElement('div');
        el.className = 'star-pkg-card';
        el.innerHTML = `
            <div class="star-pkg-emoji">💵</div>
            <div class="star-pkg-count">${fixedNumber(pkg.usdt, 0)}</div>
            <div class="star-pkg-label">USDT</div>
            <div class="star-pkg-coins">${pkg.coins} 🟡</div>
        `;
        el.onclick = () => buyUsdtPackage(pkg.coins, pkg.usdt);
        container.appendChild(el);
    });
}

// ─── ОПЛАТА ЧЕРЕЗ TON CONNECT (Telegram Wallet, Tonkeeper и др.) ───────────────
let tonInvoice = null;
let tonPollTimer = null;
let tonConnectUI = null;

// Ждём загрузки асинхронного скрипта TON Connect (он грузится не блокируя рендер).
// Вызывать перед реальным использованием кошелька, если скрипт мог ещё не подтянуться.
function waitTonConnectScript(timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (typeof TON_CONNECT_UI !== 'undefined') { resolve(true); return; }
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (typeof TON_CONNECT_UI !== 'undefined') { clearInterval(iv); resolve(true); }
            else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
        }, 150);
    });
}

// Ленивая инициализация TON Connect UI (кнопка «Connect Wallet in Telegram» и др.)
function getTonConnectUI() {
    if (tonConnectUI) return tonConnectUI;
    if (typeof TON_CONNECT_UI === 'undefined') return null;
    try {
        tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: 'https://138-16-153-215.nip.io/tonconnect-manifest.json',
            // без twaReturnUrl возврат из Tonkeeper в мини-апп зависает («Continue in Tonkeeper…»)
            actionsConfiguration: {
                twaReturnUrl: 'https://t.me/fleep_gift_bot',
                returnStrategy: 'back',
            },
        });
    } catch (e) { return null; }
    return tonConnectUI;
}

// Открываем стандартную модалку TON Connect с ВЫБОРОМ кошельков
// (Telegram Wallet, Tonkeeper, Gram Wallet и др.). Резолвится true при подключении.
function ensureWalletConnected() {
    return new Promise((resolve) => {
        const ui = getTonConnectUI();
        if (!ui) { resolve(false); return; }
        if (ui.connected) { resolve(true); return; }
        let done = false;
        let unsub = null;
        const finish = (val) => {
            if (done) return; done = true;
            try { unsub && unsub(); } catch (e) {}
            resolve(val);
        };
        try { unsub = ui.onStatusChange((w) => { if (w) finish(true); }); } catch (e) {}
        // openModal показывает список кошельков (выбор кошелька)
        try { ui.openModal(); } catch (e) {}
        setTimeout(() => finish(ui.connected), 120000);
    });
}

// Комментарий-мемо → payload (base64 BOC ячейки с текстовым комментарием, op=0).
// Мемо = 32 нулевых бита + UTF-8 текст → всегда байт-выровнено, ячейка без ссылок.
function crc32c(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ 0x82F63B78) : (crc >>> 1);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildTonCommentPayload(text) {
    const utf8 = new TextEncoder().encode(text);
    const dataBytes = new Uint8Array(4 + utf8.length); // 4 нулевых байта (op=0) + текст
    dataBytes.set(utf8, 4);
    const fullBytes = dataBytes.length;
    const d1 = 0x00;               // 0 ссылок, обычная ячейка
    const d2 = fullBytes * 2;      // байт-выровнено: floor+ceil = 2*fullBytes
    const tot = 2 + fullBytes;     // размер секции данных ячейки (d1+d2+data)
    const boc = [
        0xB5, 0xEE, 0x9C, 0x72,    // magic
        0x41,                       // has_idx=0,has_crc32c=1,cache=0,flags=0,size=1
        0x01,                       // off_bytes = 1
        0x01,                       // cells = 1
        0x01,                       // roots = 1
        0x00,                       // absent = 0
        tot,                        // tot_cells_size
        0x00,                       // root_list: индекс корневой ячейки = 0
        d1, d2, ...dataBytes,       // данные ячейки
    ];
    const crc = crc32c(new Uint8Array(boc));
    boc.push(crc & 0xFF, (crc >>> 8) & 0xFF, (crc >>> 16) & 0xFF, (crc >>> 24) & 0xFF); // little-endian
    let bin = '';
    for (const b of boc) bin += String.fromCharCode(b);
    return btoa(bin);
}

function renderTonTab() {
    getTonConnectUI(); // прогреваем TON Connect заранее
    const container = document.getElementById('ton-packages');
    if (!container) return;
    container.innerHTML = '';
    TON_PACKAGES.forEach(coins => {
        const el = document.createElement('div');
        el.className = 'star-pkg-card';
        el.innerHTML = `
            <div class="star-pkg-emoji">💎</div>
            <div class="star-pkg-count">${coins}</div>
            <div class="star-pkg-label">🟡 коинов</div>
        `;
        el.onclick = () => buyTonPackage(coins);
        container.appendChild(el);
    });
}

async function buyTonPackage(coins) {
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) { showNotif('⚠️ Откройте игру в Telegram', '#f87171'); return; }
    if (!Number.isSafeInteger(Number(coins)) || Number(coins) < MIN_TOPUP_COINS) {
        showNotif(`⚠️ Минимальное пополнение — ${MIN_TOPUP_COINS} 🟡`, '#f87171');
        return;
    }

    showNotif('💎 Создаём счёт…', '#38bdf8');

    try {
        const resp = await fetch(`${BACKEND_URL}/create_ton_invoice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, coins })
        });
        const data = await resp.json();
        if (!data.address) throw new Error(data.error || 'no address');

        tonInvoice = { ...data, expires: Number(data.expires_at) || Math.floor(Date.now()/1000) + 24*60*60, coins };
        showTonPayScreen(tonInvoice);

        await waitTonConnectScript();  // на случай, если асинхронный скрипт ещё не догрузился
        const ui = getTonConnectUI();
        if (ui) {
            await payViaTonConnect(tonInvoice);
        } else {
            // Фолбэк: прямой deeplink на кошелёк (если TON Connect не загрузился)
            openTonLink(tonInvoice.deeplink);
        }
    } catch (e) {
        showNotif('❌ Ошибка: ' + e.message, '#f87171');
    }
}

// Подключает кошелёк (если ещё не подключён) и отправляет транзакцию оплаты.
async function payViaTonConnect(inv) {
    const ui = getTonConnectUI();
    if (!ui) { openTonLink(inv.deeplink); return; }
    const connected = await ensureWalletConnected();
    if (!connected) { return; }   // юзер закрыл окно — остаётся кнопка «Оплатить» для повтора
    const nanotons = Number.isSafeInteger(Number(inv.amount_nano)) ? Number(inv.amount_nano) : Math.round(inv.amount * 1e9);
    const payload = buildTonCommentPayload(inv.memo);
    try {
        await ui.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [{ address: inv.address, amount: String(nanotons), payload }],
        });
        const st = document.getElementById('ton-pay-status');
        if (st) st.textContent = '⏳ Проверяем оплату в сети…';
    } catch (txErr) {
        // Пользователь отклонил подтверждение — оставляем кнопку повтора
    }
}

function showTonPayScreen(inv) {
    const body = document.getElementById('topup-ton-body');
    if (!body) return;

    const expiresIn = Math.round((inv.expires - Date.now() / 1000) / 60);

    body.innerHTML = `
        <div class="usdt-pay-screen">
            <div class="usdt-pay-title">💎 Оплата TON</div>
            <div class="usdt-pay-coins">+${inv.coins} 🟡 коинов</div>
            <div class="usdt-pay-amount-label">К оплате:</div>
            <div class="usdt-pay-amount">${inv.amount} TON</div>
            <button class="usdt-pay-btn" onclick="reopenTonConnect()" style="width:100%;padding:14px;margin:14px 0 6px;border:none;border-radius:12px;background:linear-gradient(135deg,#38bdf8,#0284c7);color:#fff;font-size:1rem;font-weight:800;cursor:pointer;">Выбрать кошелёк и оплатить</button>
            <div class="usdt-pay-warning">⏱ Счёт действителен ${expiresIn} мин · зачисление автоматически</div>
            <div class="usdt-pay-status" id="ton-pay-status">⏳ Ожидаем оплату…</div>
            <button class="usdt-pay-cancel" onclick="cancelTonInvoice()">Отмена</button>
        </div>
    `;

    startTonWait(inv);
}

async function reopenTonConnect() {
    if (!tonInvoice) return;
    await payViaTonConnect(tonInvoice);
}

function copyTonMemo(memo) {
    navigator.clipboard?.writeText(memo).catch(function(){});
    showNotif('📋 Комментарий скопирован', '#38bdf8');
}
function openTonLink(url) {
    if (tg?.openLink) { tg.openLink(url); }
    else { window.open(url, '_blank'); }
    showNotif('🔗 Открываем кошелёк...', '#38bdf8');
}

function startTonWait(inv) {
    if (tonPollTimer) clearInterval(tonPollTimer);
    const endTime = inv.expires * 1000;

    tonPollTimer = setInterval(async () => {
        const left = Math.round((endTime - Date.now()) / 1000);
        const statusEl = document.getElementById('ton-pay-status');

        if (left <= 0) {
            clearInterval(tonPollTimer);
            if (statusEl) statusEl.textContent = '❌ Время вышло. Создай новый счёт.';
            return;
        }

        const mins = Math.floor(left / 60);
        const secs = left % 60;
        const timeStr = `${mins}:${secs.toString().padStart(2,'0')}`;

        try {
            const userId = tg?.initDataUnsafe?.user?.id;
            const cr = await fetch(`${BACKEND_URL}/check_ton_invoice?memo=${encodeURIComponent(inv.memo)}&user_id=${userId}&coins=${inv.coins}`);
            const cd = await cr.json();
            if (cd.paid) {
                clearInterval(tonPollTimer);
                const beforeGold = parseAuthoritativeBalanceValue(userData.balance?.gold);
                const snapshot = readAuthoritativeBalanceSnapshot(cd);
                if (!snapshot || !applyRocketServerBalance(snapshot, true)) {
                    showNotif('⏳ Платёж подтверждён, но баланс ещё синхронизируется.', '#fbbf24');
                    //syncGoldFromServer();
                    return;
                }
                const gained = beforeGold === null ? 0 : Math.max(0, snapshot.gold - beforeGold);
                saveUserData();
                updateBalance();
                closeTopUpModal();
                showTopUpSuccess(gained > 0 ? gained : inv.coins, null, 'ton');
                return;
            }
        } catch(e) {}

        if (statusEl) statusEl.textContent = `⏳ Ожидаем оплату… (${timeStr})`;
    }, 5000);
}

function cancelTonInvoice() {
    if (tonPollTimer) clearInterval(tonPollTimer);
    tonInvoice = null;
    const body = document.getElementById('topup-ton-body');
    if (body) {
        body.innerHTML = `
                <p class="topup-subtitle">Оплата напрямую с TON-кошелька (Tonkeeper и т.п.). Курс — по живой цене TON.</p>
                <div id="ton-packages"></div>
                <p class="topup-footer-note">Важно: НЕ убирай комментарий к переводу — по нему зачисляется баланс.</p>`;
    }
    renderTonTab();
}

async function buyUsdtPackage(coins, usdt) {
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) { showNotif('⚠️ Откройте игру в Telegram', '#f87171'); return; }
    if (!Number.isSafeInteger(Number(coins)) || Number(coins) < MIN_TOPUP_COINS) {
        showNotif(`⚠️ Минимальное пополнение — ${MIN_TOPUP_COINS} 🟡`, '#f87171');
        return;
    }

    showNotif('💵 Создаём счёт…', '#22c55e');

    try {
        const resp = await fetch(`${BACKEND_URL}/create_usdt_invoice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, coins })
        });
        const data = await resp.json();
        if (!data.wallet) throw new Error(data.error || 'no wallet');

        // Сервер возвращает {wallet:pay_url, invoice_id, amount}
        // добавляем expires: 30 мин от сейчас
        usdtInvoice = { ...data, expires: Math.floor(Date.now()/1000) + 30*60, coins };
        showUsdtPayScreen(usdtInvoice);
        // Сразу открываем CryptoBot - без задержки
        if (data.wallet) {
            openUsdtLink(data.wallet);
        }

    } catch (e) {
        showNotif('❌ Ошибка: ' + e.message, '#f87171');
    }
}

function showUsdtPayScreen(inv) {
    const body = document.getElementById('topup-usdt-body');
    if (!body) return;

    const expiresIn = Math.round((inv.expires - Date.now() / 1000) / 60);

    body.innerHTML = `
        <div class="usdt-pay-screen">
            <div class="usdt-pay-title">💵 Оплата USDT</div>
            <div class="usdt-pay-coins">+${inv.coins} 🟡 коинов</div>
            <div class="usdt-pay-amount-label">К оплате:</div>
            <div class="usdt-pay-amount">${inv.amount} USDT</div>
            <button class="usdt-pay-btn" onclick="openUsdtLink('${inv.wallet}')" style="width:100%;padding:14px;margin:14px 0 6px;border:none;border-radius:12px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:1rem;font-weight:800;cursor:pointer;">Оплатить в CryptoBot</button>
            <div class="usdt-pay-warning">⏱ Счёт действителен ${expiresIn} мин · зачисление автоматически</div>
            <div class="usdt-pay-status" id="usdt-pay-status">⏳ Ожидаем оплату…</div>
            <button class="usdt-pay-cancel" onclick="cancelUsdtInvoice()">Отмена</button>
        </div>
    `;

    startUsdtWait(inv);
}

function copyUsdtAmount(val) {
    navigator.clipboard?.writeText(val).catch(function(){});
    showNotif('📋 Сумма скопирована: ' + val, '#22c55e');
}
function openUsdtLink(url) {
    // pay_url = https://t.me/CryptoBot?start=IV... — открываем прямо в Telegram
    if (tg && url && (url.includes('t.me/') || url.includes('telegram.me/'))) {
        tg.openTelegramLink(url);
    } else if (tg?.openLink) {
        tg.openLink(url);
    } else {
        window.open(url, '_blank');
    }
    showNotif('🔗 Открываем CryptoBot...', '#22c55e');
}
function copyUsdtWallet(val) {
    navigator.clipboard?.writeText(val).catch(function(){});
    showNotif('📋 Адрес скопирован', '#22c55e');
}

function startUsdtWait(inv) {
    if (usdtPollTimer) clearInterval(usdtPollTimer);
    const endTime = inv.expires * 1000;

    usdtPollTimer = setInterval(async () => {
        const left = Math.round((endTime - Date.now()) / 1000);
        const statusEl = document.getElementById('usdt-pay-status');

        if (left <= 0) {
            clearInterval(usdtPollTimer);
            if (statusEl) statusEl.textContent = '❌ Время вышло. Создай новый счёт.';
            return;
        }

        const mins = Math.floor(left / 60);
        const secs = left % 60;
        const timeStr = `${mins}:${secs.toString().padStart(2,'0')}`;

        try {
            // Основной путь: спрашиваем статус счёта у CryptoBot через бэкенд — зачисление идемпотентно.
            let credited = false, serverSnapshot = null;
            if (inv.invoice_id) {
                const cr = await fetch(`${BACKEND_URL}/check_usdt_invoice?invoice_id=${encodeURIComponent(inv.invoice_id)}&user_id=${tg?.initDataUnsafe?.user?.id}`);
                const cd = await cr.json();
                if (cd.paid) {
                    serverSnapshot = readAuthoritativeBalanceSnapshot(cd);
                    credited = !!serverSnapshot;
                }
            }
            // Фолбэк: сверяем баланс на сервере (если вебхук уже зачислил).
            if (!credited) {
                const userId = tg?.initDataUnsafe?.user?.id;
                const resp = await fetch(`${BACKEND_URL}/balance?user_id=${userId}&init_data=${encodeURIComponent(tg?.initData||"")}`);
                const data = await resp.json();
                const snapshot = readAuthoritativeBalanceSnapshot(data);
                const previousGold = parseAuthoritativeBalanceValue(userData.balance?.gold);
                const newer = snapshot && Number.isSafeInteger(snapshot.revision) && snapshot.revision > serverBalanceRevision;
                if (snapshot && (newer || (previousGold !== null && snapshot.gold > previousGold))) {
                    credited = true;
                    serverSnapshot = snapshot;
                }
            }

            if (credited) {
                clearInterval(usdtPollTimer);
                const beforeGold = parseAuthoritativeBalanceValue(userData.balance?.gold);
                if (!serverSnapshot || !applyRocketServerBalance(serverSnapshot, true)) {
                    showNotif('⏳ Платёж подтверждён, но баланс ещё синхронизируется.', '#fbbf24');
                    //syncGoldFromServer();
                    return;
                }
                const gained = beforeGold === null ? 0 : Math.max(0, serverSnapshot.gold - beforeGold);
                saveUserData();
                updateBalance();
                closeTopUpModal();
                showTopUpSuccess(gained > 0 ? gained : inv.coins, null, 'usdt');
                return;
            }
        } catch(e) {}

        if (statusEl) statusEl.textContent = `⏳ Ожидаем оплату… (${timeStr})`;

    }, 5000);
}

function cancelUsdtInvoice() {
    if (usdtPollTimer) clearInterval(usdtPollTimer);
    usdtInvoice = null;
    // showUsdtPayScreen затирает всё тело вкладки (включая #usdt-packages),
    // поэтому перед перерисовкой восстанавливаем исходную структуру.
    const body = document.getElementById('topup-usdt-body');
    if (body) {
        body.innerHTML = `
                <p class="topup-subtitle">100 коинов = 1.50 USDT. Зачисление автоматически.</p>
                <div id="usdt-packages"></div>
                <p class="topup-footer-note">Оплата через @CryptoBot · зачисление в течение 1 мин.</p>`;
    }
    renderUsdtTab();
}

// ═══ ОПЛАТА ЧЕРЕЗ TELEGRAM STARS (нативный WebApp Invoice) ═══
const BACKEND_URL    = 'https://138-16-153-215.nip.io/api';
const BOT_USERNAME   = 'fleep_gift_bot';
async function syncServerInventory(expectedMutationVersion = null, authHeaders = null) {
    if (!authHeaders) {
        const initData = await waitForTelegramInitData();
        authHeaders = initData ? { 'X-Telegram-Init-Data': initData } : {};
    }
    const response = await fetch(BACKEND_URL + '/gift_inventory', { headers: authHeaders, cache: 'no-store' });
    if (!response.ok) throw new Error('gift_inventory_sync_failed');
    const data = await response.json();
    if (!data || !Array.isArray(data.gifts)) throw new Error('gift_inventory_invalid_response');
    if (expectedMutationVersion !== null && expectedMutationVersion !== balanceMutationVersion) {
        return userData.inventory || [];
    }
    userData.inventory = data.gifts.map(gift => ({
        ...gift,
        id: String(gift.id),
        type: String(gift.type || 'gift'),
        value: Math.max(0, Math.floor(Number(gift.value) || 0)),
        currency: gift.currency === 'gold' ? 'gold' : 'silver',
        receivedDate: gift.receivedDate || new Date().toISOString(),
        status: gift.status || 'active',
        server_synced: true,
    }));
    DB.set('userData', userData);
    if (typeof updateInventory === 'function') updateInventory();
    if (typeof updateProfileGifts === 'function') updateProfileGifts();
    return userData.inventory;
}
// Токен бота во фронте не хранится — счёт создаёт бэкенд (POST /create_invoice)
async function syncGoldFromServer() {
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) { serverSynced = true; return; }  // вне Telegram — работаем локально
    if (serverSyncInFlight) return;
    serverSyncInFlight = true;
    const syncGeneration = serverSyncGeneration;
    const syncMutationVersion = balanceMutationVersion;
    let inventoryRendered = false;
    let remoteState = null;
    let remoteBalance = null;
    try {
        const initData = await waitForTelegramInitData();
        const authHeaders = initData ? { 'X-Telegram-Init-Data': initData } : {};
        // 1) Полное состояние (инвентарь/статистика/уровень) — сервер авторитетен, если оно есть
        try {
            const sResp = await fetch(BACKEND_URL + '/state?user_id=' + userId, { headers: authHeaders, cache: 'no-store' });
            if (sResp.ok) {
                const sData = await sResp.json();
                if (sData && sData.data) {
                    const remote = JSON.parse(sData.data);
                    if (remote && typeof remote === 'object') {
                        remoteState = remote;
                    }
                }
            }
        } catch(e) { /* нет состояния на сервере — оставляем локальное */ }

        // 2) Баланс валют — из таблицы users (учитывает пополнения ботом через звёзды/USDT)
        const resp = await fetch(BACKEND_URL + '/balance?user_id=' + userId, { headers: authHeaders, cache: 'no-store' });
        if (resp.ok) {
            const data = await resp.json();
            const snapshot = readAuthoritativeBalanceSnapshot(data);
            if (snapshot) remoteBalance = snapshot;
        }
        // A game/case response can arrive while these bootstrap requests are in
        // flight. Never let the older snapshot overwrite a fresh payout.
        if (syncGeneration !== serverSyncGeneration || String(userId) !== activeTelegramUserId || syncMutationVersion !== balanceMutationVersion) return;
        if (remoteState) {
            userData = Object.assign(getDefaultUserData(), remoteState);
            if (!Array.isArray(remoteState.inventory)) userData.inventory = [];
        }
        if (remoteBalance) {
            userData.balance = userData.balance || { gold:0, silver:0 };
            userData.balance.gold = remoteBalance.gold;
            userData.balance.silver = remoteBalance.silver;
            if (Number.isSafeInteger(remoteBalance.revision) && remoteBalance.revision >= 0) {
                serverBalanceRevision = remoteBalance.revision;
            }
        }
        await syncServerInventory(syncMutationVersion, authHeaders);
        inventoryRendered = true;
    } catch(e) { /* сервер недоступен — используем локальный баланс */ }
    finally {
        if (syncGeneration !== serverSyncGeneration || String(userId) !== activeTelegramUserId) {
            serverSyncInFlight = false;
            return;
        }
        serverSynced = true;   // с этого момента любые изменения летят на сервер
        DB.set('userData', userData);
        pushStateToServer();   // фиксируем текущее состояние на сервере (в т.ч. для нового игрока)
        if (typeof updateBalance === 'function') updateBalance();
        if (!inventoryRendered && typeof updateInventory === 'function') updateInventory();
        if (typeof updateStats === 'function') updateStats();
        if (typeof updateTasks === 'function') updateTasks();
        if (typeof updateProfileInfo === 'function') updateProfileInfo();
        serverSyncInFlight = false;
    }
}


async function buyStarPackage(stars, coins) {
    if (!tg) {
        showNotif('⚠️ Откройте игру в Telegram', '#f87171');
        return;
    }
    if (!Number.isSafeInteger(Number(stars)) || Number(stars) < MIN_TOPUP_COINS ||
        !Number.isSafeInteger(Number(coins)) || Number(coins) < MIN_TOPUP_COINS) {
        showNotif(`⚠️ Минимальное пополнение — ${MIN_TOPUP_COINS} ⭐`, '#f87171');
        return;
    }

    const userId   = tg?.initDataUnsafe?.user?.id || 0;
    const promo    = activePromo?.code || null;
    const initData = tg?.initData || '';

    if (!userId) {
        showNotif('⚠️ Не удалось получить ID пользователя', '#f87171');
        return;
    }

    showNotif('⭐ Создаём счёт…', '#8b5cf6');

    try {
        // Инвойс создаёт бэкенд (токен бота НЕ во фронте — безопасно)
        const resp = await fetch(`${BACKEND_URL}/create_invoice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, stars: stars, promo: promo })
        });
        const data = await resp.json();
        if (!resp.ok || !data.invoice_url) throw new Error(data.error || 'Не удалось создать счёт');

        const invoiceUrl = data.invoice_url;

        // Открываем инвойс прямо внутри мини аппа
        tg.openInvoice(invoiceUrl, async (status) => {
            if (status === 'paid') {
                showNotif('✅ Оплата прошла! Начисляем коинов…', '#a78bfa');
                closeTopUpModal();
                // Ждём пока бот обработает платёж и зачислит
                let synced = false;
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const br = await fetch(`${BACKEND_URL}/balance?user_id=${userId}`, {
                            headers: { 'X-Telegram-Init-Data': initData },
                            cache: 'no-store'
                        });
                        if (!br.ok) continue;
                        const bd = await br.json();
                        const snapshot = readAuthoritativeBalanceSnapshot(bd);
                        if (!snapshot) continue;
                        const previousGold = parseAuthoritativeBalanceValue(userData.balance?.gold);
                        const previousRevision = serverBalanceRevision;
                        const newer = Number.isSafeInteger(snapshot.revision) && snapshot.revision > previousRevision;
                        if (newer || (previousGold !== null && snapshot.gold > previousGold)) {
                            const gained = previousGold === null ? 0 : Math.max(0, snapshot.gold - previousGold);
                            applyRocketServerBalance(snapshot);
                            saveUserData();
                            trackDeposit(gained);
                            showTopUpSuccess(gained, stars, 'stars');
                            synced = true;
                            break;
                        }
                    } catch(e) {}
                }
                if (!synced) {
                    // Do not fake a local credit: the server will apply the verified payment.
                    showNotif('⏳ Платёж подтверждён. Баланс обновится после зачисления сервером.', '#fbbf24');
                    //syncGoldFromServer();
                }
            } else if (status === 'cancelled') {
                showNotif('❌ Оплата отменена', '#f87171');
            } else if (status === 'failed') {
                showNotif('❌ Ошибка оплаты', '#f87171');
            }
        });

    } catch(e) {
        console.error('buyStarPackage error:', e);
        showNotif('❌ Ошибка: ' + (e.message || 'попробуй позже'), '#f87171');
    }
}

function trackDeposit(coins){
    if(coins>=100){userData.taskProgress=userData.taskProgress||{};userData.taskProgress.deposit100=1;if(typeof saveUserData==="function")saveUserData();updateTasks();loadServerTaskProgress();}
}
function creditCoins(coins, stars) {
    // Kept as a compatibility shim for old bundles. Verified payments are
    // credited by the backend webhook and then read from /balance.
    console.warn('ignored client-side creditCoins call', { coins, stars });
    //syncGoldFromServer();
}

function showTopUpSuccess(coins, stars, method = 'stars') {
    // Показываем красивое уведомление
    const notif = document.createElement('div');
    notif.style.cssText = `
        position:fixed;top:20px;left:50%;transform:translateX(-50%);
        background:linear-gradient(135deg,#f59e0b,#fcd34d);
        color:#000;padding:14px 24px;border-radius:16px;
        font-weight:800;font-size:1rem;z-index:9999;
        box-shadow:0 8px 30px rgba(245,158,11,0.5);
        text-align:center;min-width:200px;
    `;
    const sub = method === 'usdt' ? `за ${coins / 100 * 1.5} USDT` : method === 'ton' ? 'за TON-перевод' : `за ${stars} ⭐ звёзд`;
    notif.innerHTML = `✅ +${coins} 🟡 золотых коинов<br><span style="font-size:0.75rem;opacity:0.7">${sub}</span>`;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 3500);
}

// Устаревшие функции (оставлены для совместимости)
function setTopUpCurrency(type) { topUpCurrency = type; }
function setTopUpAmount(val) {}
function changeTopUpAmount(delta) {}
function confirmTopUp() {}

// ═══════════ Задания на подписку (динамические, добавляет админ из мини-аппа) ═══════════
function escChTask(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function loadChannelTasks() {
    const wrap = document.getElementById('channel-tasks-list');
    if (!wrap) return;
    const userId = tg?.initDataUnsafe?.user?.id;
    const uname  = tg?.initDataUnsafe?.user?.username || '';
    try {
        const r = await fetch(`${BACKEND_URL}/channel_tasks?user_id=${userId || ''}&username=${encodeURIComponent(uname)}`);
        const d = await r.json();
        const tasks = d.tasks || [];
        wrap.innerHTML = tasks.map(t => {
            const cur = t.currency === 'gold' ? '🟡' : 'F';
            const rewClass = t.currency === 'gold' ? '' : 'task-card-rew-silver';
            const done = t.done;
            const isLink = (t.kind || 'subscribe') === 'link';
            const btnLabel = isLink ? 'Перейти' : 'Подписаться';
            const btn = done
                ? `<button class="task-card-btn" disabled>✅ Готово</button>`
                : `<button class="task-card-btn" onclick="checkChannelTask(${t.id}, this)">${btnLabel}</button>`;
            const desc = isLink ? 'Перейди по ссылке и забери награду' : ('Подпишись на ' + escChTask(t.channel || 'канал'));
            return `<div class="task-card-prf${done ? ' task-done' : ''}" style="position:relative;">
                <div class="task-card-left">
                    <div class="task-card-ico">${isLink ? '🔗' : '📣'}</div>
                    <div class="task-card-info">
                        <div class="task-card-name">${escChTask(t.title)}</div>
                        <div class="task-card-desc">${desc}</div>
                    </div>
                </div>
                <div class="task-card-right">
                    <div class="task-card-rew ${rewClass}">+${t.reward} ${cur}</div>
                    ${btn}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        wrap.innerHTML = '';
    }
}
async function checkChannelTask(taskId, btnEl) {
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) { showNotif('⚠️ Откройте игру в Telegram', '#f87171'); return; }
    // Находим задание, открываем канал, затем проверяем подписку
    const uname = tg?.initDataUnsafe?.user?.username || '';
    const origLabel = (btnEl && btnEl.textContent) ? btnEl.textContent : 'Подписаться';
    try {
        const lr = await fetch(`${BACKEND_URL}/channel_tasks?user_id=${userId}&username=${encodeURIComponent(uname)}`);
        const ld = await lr.json();
        const task = (ld.tasks || []).find(x => x.id === taskId);
        if (task && task.link) {
            const url = task.link.startsWith('http') ? task.link : ('https://t.me/' + task.link.replace(/^@/, ''));
            if (tg?.openTelegramLink) tg.openTelegramLink(url); else if (tg?.openLink) tg.openLink(url); else window.open(url, '_blank');
        }
    } catch (e) {}
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Проверяю…'; }
    setTimeout(async () => {
        try {
            const r = await fetch(`${BACKEND_URL}/check_channel_task`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, task_id: taskId, username: uname })
            });
            const d = await r.json();
            if (d.ok) {
                const cur = d.currency === 'gold' ? '🟡' : 'F';
                // The response contains the authoritative post-reward
                // snapshot. Do not add the reward locally: a retry or a
                // second device could otherwise make the displayed balance
                // diverge from the server.
                applyRocketServerBalance(d, true);
                if (typeof updateBalance === 'function') updateBalance();
                if (typeof saveUserData === 'function') saveUserData();
                showNotif(`🎉 +${d.reward} ${cur} получено!`, '#4ade80');
                loadChannelTasks();
            } else {
                const msg = d.reason === 'not_subscribed' ? 'Ты ещё не подписан на канал'
                    : d.reason === 'already_done' ? 'Задание уже выполнено'
                    : d.message || 'Не удалось проверить подписку';
                showNotif('⚠️ ' + msg, '#f87171');
                if (btnEl) { btnEl.disabled = false; btnEl.textContent = origLabel; }
            }
        } catch (e) {
            showNotif('⚠️ Ошибка сети', '#f87171');
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = origLabel; }
        }
    }, 1500);
}

// Server-authoritative settlement for the rocket and inventory sales.
// These definitions intentionally live at the end of the iPhone-safe bundle,
// so the existing animation/UI code remains unchanged while its money-moving
// callbacks are replaced by signed, idempotent API calls.
function fleepActionId(prefix) {
    const randomPart = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : Date.now() + '_' + Math.random().toString(36).slice(2);
    return prefix + '_' + randomPart;
}

function readTelegramInitDataFromUrl() {
    try {
        const rawSources = [window.location.search || '', window.location.hash || ''];
        for (const raw of rawSources) {
            const query = String(raw).replace(/^[?#]/, '');
            if (!query) continue;
            for (const pair of query.split('&')) {
                const separator = pair.indexOf('=');
                if (separator < 0) continue;
                const key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
                if (key !== 'tgWebAppData' && key !== 'initData') continue;
                const value = pair.slice(separator + 1).replace(/\+/g, ' ');
                const embedded = decodeURIComponent(value);
                if (embedded) return embedded;
            }
        }
    } catch (e) {}
    return '';
}

function referralCodeFromStartParam(value) {
    const match = /^ref_([A-Za-z0-9_-]{3,32})$/.exec(String(value || '').trim());
    return match ? match[1] : '';
}

function readMiniAppReferralCode() {
    const candidates = [];
    try {
        candidates.push(tg?.initDataUnsafe?.start_param);
        if (tg?.initData) candidates.push(new URLSearchParams(tg.initData).get('start_param'));
        const query = new URLSearchParams(window.location.search || '');
        candidates.push(query.get('startapp'), query.get('start_param'), query.get('ref'));
    } catch (e) {}
    for (const candidate of candidates) {
        const code = referralCodeFromStartParam(candidate);
        if (code) return code;
    }
    return '';
}

let miniAppReferralBinding = '';
async function bindMiniAppReferral() {
    const userId = tg?.initDataUnsafe?.user?.id;
    const code = readMiniAppReferralCode();
    if (!userId || !code) return null;
    const marker = String(userId) + ':' + code;
    if (miniAppReferralBinding === marker) return null;
    // Set the marker before awaiting the network request so the iOS startup
    // polling cannot send several identical bind requests at once.
    miniAppReferralBinding = marker;
    try {
        const initData = await waitForTelegramInitData();
        if (!initData) throw new Error('telegram_auth_unavailable');
        const response = await fetch(BACKEND_URL + '/referral/bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
            body: JSON.stringify({ ref_code: code, init_data: initData }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.reason || data?.error || 'referral_bind_failed');
        return data;
    } catch (e) {
        // A transient startup/network failure should be retried on the next
        // Telegram bootstrap tick, while an already-bound user is harmless.
        if (miniAppReferralBinding === marker) miniAppReferralBinding = '';
        return null;
    }
}

async function waitForTelegramInitData(timeoutMs = 3500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const liveWebApp = window.Telegram && window.Telegram.WebApp;
            if (liveWebApp) {
                tg = liveWebApp;
                try { liveWebApp.ready(); } catch (e) {}
                if (liveWebApp.initData) return liveWebApp.initData;
            }
            const webViewParams = window.Telegram && window.Telegram.WebView && window.Telegram.WebView.initParams;
            if (webViewParams && webViewParams.tgWebAppData) return webViewParams.tgWebAppData;
            const urlInitData = readTelegramInitDataFromUrl();
            if (urlInitData) return urlInitData;
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return '';
}

function applyRocketServerBalance(data, isMutation = false) {
    const snapshot = readAuthoritativeBalanceSnapshot(data);
    if (!snapshot) {
        console.error('ignored invalid authoritative balance response');
        return false;
    }
    if (Number.isSafeInteger(snapshot.revision) && snapshot.revision < serverBalanceRevision) {
        // A slower response from an older request must not roll back a newer
        // authoritative snapshot already rendered by this client.
        return false;
    }
    if (isMutation) balanceMutationVersion++;
    userData.balance = userData.balance || { silver: 0, gold: 0 };
    // Older reward handlers returned `gold`/`silver`, while game and payment
    // handlers return `gold_coins`/`silver_coins`. Both are server snapshots;
    // accepting only one shape made the UI look frozen after a reward or a
    // re-login even though SQLite had already changed the balance.
    userData.balance.silver = snapshot.silver;
    userData.balance.gold = snapshot.gold;
    if (Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0) serverBalanceRevision = snapshot.revision;
    DB.set('userData', userData);
    if (typeof updateBalance === 'function') updateBalance();
    return true;
}

async function fleepGameApi(path, payload) {
    // ═══ ТЕСТ-МОД: локальная эмуляция без сервера ═══
    return await _localGameApi(path, payload || {});
}
async function _localGameApi(path, payload) {
    const ud = userData;
    const bal = ud.balance;

    // ── МИНЫ ──
    if (path === '/game/mines/start') {
        const { bet, currency, size, mines } = payload;
        const total = size * size;
        // Генерируем позиции мин
        const positions = new Set();
        while (positions.size < mines) positions.add(Math.floor(Math.random() * total));
        // Сохраняем сессию локально
        ud._minesSession = { bet, currency, size, mines: [...positions], revealed: [], lost: false };
        bal[currency] -= bet;
        saveUserData(); updateBalance();
        return { ok: true, session_id: 'local', currency, bet, size, mines, revealed: [], coefficient: 1.0 };
    }
    if (path === '/game/mines/reveal') {
        const s = ud._minesSession;
        if (!s) throw Object.assign(new Error('no_session'), { data: { error: 'no_session' } });
        const { index } = payload;
        const isMine = s.mines.includes(index);
        s.revealed.push(index);
        const safeTotal = s.size * s.size - s.mines.length;
        const coef = Math.pow(safeTotal / (safeTotal - s.revealed.filter(i => !s.mines.includes(i)).length + 1), 0.7);
        if (isMine) {
            s.lost = true;
            return { ok: true, status: 'lost', is_mine: true, mines: s.mines, win: 0, coefficient: coef };
        }
        const safeRevealed = s.revealed.filter(i => !s.mines.includes(i)).length;
        const canCashOut = safeRevealed > 0;
        return { ok: true, status: 'active', is_mine: false, coefficient: +(1 + safeRevealed * 0.15).toFixed(2), can_cashout: canCashOut };
    }
    if (path === '/game/mines/cashout') {
        const s = ud._minesSession;
        if (!s) throw Object.assign(new Error('no_session'), { data: { error: 'no_session' } });
        const safeRevealed = s.revealed.filter(i => !s.mines.includes(i)).length;
        const coef = +(1 + safeRevealed * 0.15).toFixed(2);
        const win = Math.floor(s.bet * coef);
        bal[s.currency] += win;
        ud._minesSession = null;
        saveUserData(); updateBalance();
        return { ok: true, status: 'settled', win, coefficient: coef, mines: s.mines };
    }

    // ── РАКЕТА ──
    if (path === '/game/rocket/start') {
        const { bet, currency } = payload;
        const crashAt = +(Math.max(1.01, -Math.log(Math.random()) * 1.5 + 1.0)).toFixed(2);
        bal[currency] -= bet;
        ud._rocketSession = { bet, currency, crashAt, startTime: Date.now() };
        saveUserData(); updateBalance();
        return { ok: true, session_id: 'local', currency, bet, crash_at: crashAt, server_time: Date.now() };
    }
    if (path === '/game/rocket/status') {
        const s = ud._rocketSession;
        if (!s) return { ok: true, status: 'idle' };
        const elapsed = (Date.now() - s.startTime) / 1000;
        const coef = +(Math.pow(Math.E, 0.06 * elapsed)).toFixed(2);
        if (coef >= s.crashAt) return { ok: true, status: 'crashed', crash_at: s.crashAt };
        return { ok: true, status: 'active', coefficient: coef };
    }
    if (path === '/game/rocket/cashout' || path === '/game/rocket/resolve') {
        const s = ud._rocketSession;
        if (!s) throw Object.assign(new Error('no_session'), { data: { error: 'no_session' } });
        const elapsed = (Date.now() - s.startTime) / 1000;
        const coef = Math.min(+(Math.pow(Math.E, 0.06 * elapsed)).toFixed(2), s.crashAt - 0.01);
        const win = Math.floor(s.bet * coef);
        bal[s.currency] += win;
        ud._rocketSession = null;
        saveUserData(); updateBalance();
        return { ok: true, status: 'settled', win, coefficient: coef };
    }

    // ── КЕЙСЫ ──
    if (path === '/game/case/open') {
        const { case_type, currency, cost } = payload;
        const price = cost || 15;
        if ((bal[currency] || 0) < price) throw Object.assign(new Error('insufficient_balance'), { data: { error: 'insufficient_balance' } });
        bal[currency] -= price;
        const gifts = ['heart','bear','gift','rose','cake','bouquet','rocket','cup','ring','diamond','champagne'];
        const type = gifts[Math.floor(Math.random() * gifts.length)];
        const value = Math.floor(Math.random() * 200) + 15;
        saveUserData(); updateBalance();
        return { ok: true, gift: { type, name: type, value, id: Date.now() } };
    }

    // ── ЕЖЕДНЕВНЫЙ БОНУС ──
    if (path === '/daily/claim') {
        bal.silver += 100;
        saveUserData(); updateBalance();
        return { ok: true, reward: 100, currency: 'silver' };
    }

    // ── ЗАДАНИЯ ──
    if (path === '/task/claim') {
        const reward = payload.reward || 50;
        bal.silver += reward;
        saveUserData(); updateBalance();
        return { ok: true, reward, currency: 'silver' };
    }

    // Всё остальное — успех без действий
    return { ok: true };
}
async function __fleepGameApi_orig(path, payload) {
    const requestBody = Object.assign({}, payload || {});
    // Некоторые версии Telegram WebView на iPhone нестабильно передают
    // нестандартный X-Telegram-Init-Data. Дублируем подписанное initData
    // в теле: сервер проверит ту же подпись и не доверяет user_id из клиента.
    const initData = await waitForTelegramInitData();
    if (initData) requestBody.init_data = initData;
    const headers = { 'Content-Type': 'application/json' };
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    const response = await fetch(BACKEND_URL + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data || !data.ok) {
        const error = new Error((data && data.error) || 'server_error');
        error.data = data || {};
        error.status = response.status;
        throw error;
    }
    return data;
}

function addRocketGiftToLocalInventory(gift) {
    if (!gift || typeof gift !== 'object' || !gift.id) return null;
    if (!Array.isArray(userData.inventory)) userData.inventory = [];
    const giftId = String(gift.id);
    const existing = userData.inventory.find(item => item && String(item.id) === giftId);
    if (existing) return existing;
    const normalized = {
        ...gift,
        id: giftId,
        value: Math.max(0, Math.floor(Number(gift.value) || 0)),
        currency: gift.currency === 'gold' ? 'gold' : 'silver',
        source: 'rocket',
        status: 'active',
        receivedDate: gift.receivedDate || new Date().toISOString(),
        wagerStart: Number(userData.stats?.totalWagered) || 0,
    };
    userData.inventory.unshift(normalized);
    return normalized;
}

function showRocketGiftWinModal(gift, remainder) {
    const old = document.getElementById('rocket-gift-win-overlay');
    if (old) old.remove();
    const currency = gift && gift.currency === 'gold' ? 'gold' : 'silver';
    const value = Math.max(0, Math.floor(Number(gift && gift.value) || 0));
    const rest = Math.max(0, Math.floor(Number(remainder) || 0));
    const overlay = document.createElement('div');
    overlay.id = 'rocket-gift-win-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3200;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.onclick = () => overlay.remove();
    const card = document.createElement('div');
    card.style.cssText = 'width:min(420px,100%);padding:28px 22px 22px;border:1.5px solid rgba(251,191,36,.6);border-radius:24px;background:linear-gradient(160deg,#211c35,#13131f);box-shadow:0 0 50px rgba(168,85,247,.35);text-align:center;';
    card.onclick = e => e.stopPropagation();
    const title = document.createElement('div');
    title.textContent = 'Подарок за выигрыш';
    title.style.cssText = 'color:#fbbf24;font-size:1.1rem;font-weight:900;margin-bottom:18px;';
    const icon = document.createElement('div');
    icon.innerHTML = typeof giftIcon === 'function' ? giftIcon(gift, 96) : '🎁';
    icon.style.cssText = 'min-height:100px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;filter:drop-shadow(0 0 20px rgba(251,191,36,.5));';
    const name = document.createElement('div');
    name.textContent = gift.name || 'Подарок';
    name.style.cssText = 'color:#fff;font-size:1.35rem;font-weight:900;margin-bottom:8px;';
    const amount = document.createElement('div');
    amount.textContent = value + ' ' + curLetter(currency);
    amount.style.cssText = 'color:#fcd34d;font-size:1rem;font-weight:800;margin-bottom:8px;';
    card.append(title, icon, name, amount);
    if (rest > 0) {
        const restEl = document.createElement('div');
        restEl.textContent = 'Остаток начислен на баланс: +' + rest + ' ' + curLetter(currency);
        restEl.style.cssText = 'color:#86efac;font-size:.86rem;font-weight:700;margin-bottom:18px;';
        card.appendChild(restEl);
    }
    const close = document.createElement('button');
    close.textContent = 'Забрать подарок';
    close.style.cssText = 'width:100%;padding:14px;border:0;border-radius:14px;background:linear-gradient(135deg,#7b5cff,#a855f7);color:#fff;font-size:1rem;font-weight:900;';
    close.onclick = () => overlay.remove();
    card.appendChild(close);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

function renderRocketResultLabel() {
    const el = $id('rocket-coefficient');
    const label = rocketGameState._lastRocketResultLabel;
    if (!el || !label) return;
    el.textContent = label;
    el.style.whiteSpace = 'pre-line';
    el.style.display = 'inline-block';
    el.style.fontSize = '1.02rem';
    el.style.lineHeight = '1.25';
    el.style.letterSpacing = '0.4px';
}

function clearRocketResultLabel() {
    rocketGameState._lastRocketResultLabel = '';
    const el = $id('rocket-coefficient');
    if (!el) return;
    el.style.whiteSpace = 'normal';
    el.style.display = 'inline';
    el.style.fontSize = '2.2rem';
    el.style.lineHeight = '';
    el.style.letterSpacing = '1px';
}

// Фейковый «полёт после забора» — чистый визуал для азарта. Деньги уже
// начислены по реальному коэффициенту; здесь только ЧТО игрок увидит, как
// далеко ракета «могла бы» улететь. Значение всегда выше точки, где он забрал.
function rocketFakeCrashPoint(cashoutCoef) {
    const base = Number(cashoutCoef) || 1;
    const r = Math.random();
    let target;
    if (r < 0.55)      target = 2.0 + Math.random() * 1.0;   // 2–3x   — чаще всего
    else if (r < 0.88) target = 3.0 + Math.random() * 2.0;   // 3–5x   — иногда
    else if (r < 0.97) target = 5.0 + Math.random() * 2.0;   // 5–7x   — реже
    else               target = 8.0 + Math.random() * 4.0;   // 8–12x  — очень редко
    // Фейк всегда ВЫШЕ точки забора (минимум +40–100%), иначе «эх, мог бы» не читается.
    const floor = base * (1.4 + Math.random() * 0.6);
    return Math.max(target, floor);
}
function rocketCoefLabel(v) { return '×' + fixedNumber(v, v < 10 ? 1 : 0); }

function finishRocketServerResult(result) {
    if (!result || rocketGameState._serverFinished) return;
    if (rocketGameState._statusTimer) {
        clearTimeout(rocketGameState._statusTimer);
        rocketGameState._statusTimer = null;
    }
    rocketGameState._serverFinished = true;
    rocketGameState._settlePending = false;
    applyRocketServerBalance(result, true);

    const win = Math.max(0, Math.floor(Number(result.win) || 0));
    const coefficient = Number(result.coefficient) || rocketGameState.currentCoefficient || 1;
    const actualCrashPoint = Number(result.final_crash_point ?? result.crash_point);
    const cashedOut = result.status === 'settled' && result.crashed === false;
    const showFake = cashedOut;
    const fakeCrashPoint = showFake ? rocketFakeCrashPoint(coefficient) : null;
    const gift = result.gift && typeof result.gift === 'object' ? addRocketGiftToLocalInventory(result.gift) : null;
    const remainder = Math.max(0, Math.floor(Number(result.payout) || 0));
    const isWin = result.status === 'settled' && (win > 0 || !!gift);
    if (!userData.stats) userData.stats = {};
    userData.stats.rocketPlayed = (userData.stats.rocketPlayed || 0) + 1;
    if (isWin) userData.stats.totalWon = (userData.stats.totalWon || 0) + win;
    if (!Array.isArray(userData.rocketHistory)) userData.rocketHistory = [];
    userData.rocketHistory.unshift({
        timestamp: new Date().toISOString(),
        bet: rocketGameState.currentBet,
        win,
        coefficient,
        isWin,
        cashoutCoefficient: cashedOut ? coefficient : null,
        crashPoint: Number.isFinite(actualCrashPoint) ? actualCrashPoint : null
    });
    if (userData.rocketHistory.length > 20) userData.rocketHistory = userData.rocketHistory.slice(0, 20);
    rocketGameState.isRoundActive = false;
    rocketGameState.isPlaying = false;
    rocketGameState._continueAfterCashout = false;
    rocketGameState._lastRocketResultLabel = '';
    if (rocketGameState._realResultTimer) {
        clearTimeout(rocketGameState._realResultTimer);
        rocketGameState._realResultTimer = null;
    }
    rocketGameState._serverSessionId = null;
    rocketGameState._startActionId = null;
    rocketGameState._clientSeed = null;
    rocketGameState._settleActionId = null;

    const cashBtn = $id('rocket-cashout-btn');
    const playBtn = $id('rocket-play-btn');
    if (cashBtn) cashBtn.style.display = 'none';
    if (playBtn) { playBtn.style.display = 'block'; playBtn.disabled = true; playBtn.style.opacity = '0.5'; }
    if (showFake) setText('rocket-coefficient', '✓ ' + rocketCoefLabel(coefficient));
    else setText('rocket-coefficient', isWin ? (gift ? '✓ ПОДАРОК' : '✓ ×' + fixedNumber(coefficient, 1)) : '✕ Сорвалось');
    // The board already shows both coefficients after a cashout. Do not duplicate
    // that information in a green toast, but keep the actual round result visible.
    if (!showFake && typeof showNotif === 'function') {
        const currency = result.currency || rocketGameState.betType;
        showNotif(gift
            ? 'Подарок «' + (gift.name || 'Подарок') + '» добавлен: ' + (gift.value || 0) + ' ' + curLetter(currency) + (remainder ? ', остаток +' + remainder + ' ' + curLetter(currency) : '')
            : (isWin ? 'Зачислено: +' + win + ' ' + curLetter(currency) : 'Ракетка сорвалась на ×' + fixedNumber(coefficient, 1)),
            isWin ? '#22c55e' : 'error');
    }
    saveUserData();
    if (gift && typeof updateInventory === 'function') updateInventory();
    if (gift) showRocketGiftWinModal(gift, remainder);
    updateStats();
    updateRocketHistory();
    updateRocketPrevRounds();
    if (showFake) {
        // Игрок забрал — деньги уже начислены. Дальше ЧИСТЫЙ визуал: ракета
        // продолжает лететь до фейкового значения, цифра растёт вживую, реальный
        // краш не показываем. В конце — «улетела ×N», чтобы разжечь азарт.
        rocketGameState.isPlaying = true;
        rocketGameState._continueAfterCashout = true;
        rocketGameState._lastRocketResultLabel = ''; // пусто → в кадре видно живой растущий ×
        rocketGameState.currentCoefficient = coefficient;
        rocketGameState.crashPoint = fakeCrashPoint;
        const targetElapsedMs = Math.log(fakeCrashPoint) / Math.log(1.10) * 1000;
        const elapsedMs = Math.max(0, Date.now() - Number(rocketGameState.startTime || Date.now()));
        const remainingMs = Math.max(targetElapsedMs - elapsedMs, 900);
        rocketGameState._realResultTimer = setTimeout(() => {
            rocketGameState._realResultTimer = null;
            rocketGameState._continueAfterCashout = false;
            rocketGameState.isPlaying = false;
            rocketGameState._lastRocketResultLabel =
                '✓ ЗАБРАЛ ' + rocketCoefLabel(coefficient) + '\n' +
                '🚀 УЛЕТЕЛА ' + rocketCoefLabel(fakeCrashPoint);
            renderRocketResultLabel();
            crashAnimateRocket();
            startRocketCountdown();
        }, remainingMs);
        animateRocket();
    } else {
        crashAnimateRocket();
        startRocketCountdown();
    }
}

const ROCKET_STATUS_POLL_MS = 750;
function scheduleRocketStatusPoll(delay = ROCKET_STATUS_POLL_MS) {
    if (rocketGameState._statusTimer) clearTimeout(rocketGameState._statusTimer);
    if (!rocketGameState._serverSessionId || rocketGameState._serverFinished || rocketGameState._settlePending) return;
    rocketGameState._statusTimer = setTimeout(async () => {
        rocketGameState._statusTimer = null;
        if (!rocketGameState._serverSessionId || rocketGameState._serverFinished || rocketGameState._settlePending) return;
        try {
            const result = await fleepGameApi('/game/rocket/status', {
                session_id: rocketGameState._serverSessionId
            });
            if (result.status === 'running') {
                scheduleRocketStatusPoll(ROCKET_STATUS_POLL_MS);
            } else {
                finishRocketServerResult(result);
            }
        } catch (e) {
            if (!rocketGameState._serverFinished && rocketGameState._serverSessionId) {
                scheduleRocketStatusPoll(1500);
            }
        }
    }, Math.max(50, Number(delay) || 150));
}

async function settleRocketFromServer(forceCrash) {
    if (!rocketGameState._serverSessionId || rocketGameState._serverFinished || rocketGameState._settlePending) return;
    if (rocketGameState._statusTimer) {
        clearTimeout(rocketGameState._statusTimer);
        rocketGameState._statusTimer = null;
    }
    rocketGameState._settlePending = true;
    rocketGameState.isRoundActive = false;
    rocketGameState._settleActionId = rocketGameState._settleActionId || fleepActionId('rocket_settle');
    try {
        const result = await fleepGameApi(forceCrash ? '/game/rocket/resolve' : '/game/rocket/cashout', {
            session_id: rocketGameState._serverSessionId,
            action_id: rocketGameState._settleActionId
        });
        finishRocketServerResult(result);
    } catch (e) {
        rocketGameState._settlePending = false;
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (typeof showNotif === 'function') showNotif('Не удалось получить ответ. Попробуй ещё раз.', '#f59e0b');
        setTimeout(() => settleRocketFromServer(forceCrash), 900);
    }
}

async function startRocketGame() {
    if (rocketGameState.isRoundActive || rocketGameState._startPending) return;
    if (rocketGameState.currentBet > (userData.balance?.[rocketGameState.betType] || 0)) {
        alert('РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ СЃСЂРµРґСЃС‚РІ!');
        return;
    }
    const bet = Math.floor(Number(rocketGameState.currentBet));
    const currency = rocketGameState.betType === 'gold' ? 'gold' : 'silver';
    if (!Number.isSafeInteger(bet) || bet < MIN_GAME_STAKE || bet > 1000000) {
        if (typeof showNotif === 'function') showNotif('Некорректная сумма ставки.', '#f87171');
        return;
    }
    rocketGameState.currentBet = bet;
    clearRocketResultLabel();
    rocketGameState._startPending = true;
    rocketGameState._startActionId = rocketGameState._startActionId || fleepActionId('rocket_start');
    rocketGameState._clientSeed = rocketGameState._clientSeed || fleepActionId('rocket_client');
    try {
        const result = await fleepGameApi('/game/rocket/start', {
            bet,
            currency,
            action_id: rocketGameState._startActionId,
            client_seed: rocketGameState._clientSeed
        });
        applyRocketServerBalance(result, true);
        if (rocketGameState.betType === 'silver') addWager(rocketGameState.currentBet);
        rocketGameState._startPending = false;
        rocketGameState._serverSessionId = result.session_id;
        rocketGameState._serverFinished = false;
        rocketGameState._settlePending = false;
        rocketGameState.isPlaying = true;
        rocketGameState.isRoundActive = true;
        rocketGameState.currentCoefficient = 1.0;
        const localNow = Date.now();
        const serverElapsed = Math.max(0,
            Number(result.server_now_ms || localNow) - Number(result.started_at_ms || localNow)
        );
        rocketGameState.startTime = localNow - serverElapsed;
        // The server no longer reveals the future crash time. The animation
        // runs visually; /game/rocket/status tells us only when it is over.
        rocketGameState.crashPoint = 1.1;
        rocketGameState._crashAtMs = Infinity;
        const playBtn = $id('rocket-play-btn');
        const cashBtn = $id('rocket-cashout-btn');
        if (playBtn) playBtn.style.display = 'none';
        if (cashBtn) {
            cashBtn.style.display = 'block';
            cashBtn.textContent = 'ЗАБРАТЬ ×1.00';
        }
        saveUserData();
        animateRocket();
        scheduleRocketStatusPoll(ROCKET_STATUS_POLL_MS);
    } catch (e) {
        rocketGameState._startPending = false;
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (e && e.data && e.data.error === 'insufficient_balance') alert('РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ СЃСЂРµРґСЃС‚РІ!');
        else if (typeof showNotif === 'function') {
            const serverError = e && e.data && e.data.error;
            const message = serverError === 'unauthorized'
                ? 'Telegram не передал подпись. Закрой мини-приложение и открой его кнопкой «Играть» в боте.'
                : serverError === 'invalid_game_parameters'
                    ? 'Сумма или валюта ставки указаны неверно.'
                    : serverError === 'active_game_exists'
                        ? 'У тебя уже есть незавершённый раунд. Подожди его завершения.'
                        : 'Не удалось запустить игру. Попробуй ещё раз.';
            showNotif(message, '#f87171');
        }
    }
}

function cashOutRocket() {
    if (!rocketGameState.isPlaying || !rocketGameState.isRoundActive || rocketGameState._settlePending) return;
    settleRocketFromServer(false);
}

function endRocketGame() {
    if (rocketGameState._serverSessionId && !rocketGameState._serverFinished) {
        settleRocketFromServer(true);
        return;
    }
    rocketGameState.isRoundActive = false;
    rocketGameState.isPlaying = false;
    rocketGameState._continueAfterCashout = false;
    const cashBtn = $id('rocket-cashout-btn');
    const playBtn = $id('rocket-play-btn');
    if (cashBtn) cashBtn.style.display = 'none';
    if (playBtn) { playBtn.style.display = 'block'; playBtn.disabled = true; playBtn.style.opacity = '0.5'; }
    crashAnimateRocket();
    startRocketCountdown();
}

async function sellGiftFromInventory(giftId) {
    const gift = (userData.inventory || []).find(g => String(g.id) === String(giftId));
    if (!gift || gift.status === 'sold' || gift.status === 'withdrawn' || gift.status === 'withdraw_pending') return;
    try {
        const result = await fleepGameApi('/sell_gift', { gift_id: String(giftId) });
        applyRocketServerBalance(result, true);
        gift.status = 'sold';
        saveUserData();
        try { await syncServerInventory(); } catch (e) {}
        const overlay = document.getElementById('manage-gift-overlay');
        if (overlay) overlay.remove();
        if (typeof showNotif === 'function') showNotif('Подарок продан, зачислено +' + (result.sold_amount || 0) + ' ' + curLetter(result.currency), '#22c55e');
        if (typeof updateInventory === 'function') updateInventory();
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        const serverError = e && e.data && e.data.error;
        const message = serverError === 'gift_already_sold'
            ? 'Этот подарок уже продан.'
            : serverError === 'gift_not_found'
                ? 'Подарок из старой версии не синхронизирован с сервером. Напишите администратору.'
                : 'Продажа не прошла. Попробуйте ещё раз.';
        if (typeof showNotif === 'function') showNotif(message, '#f87171');
    }
}

// ===== SERVER-AUTHORITATIVE MINES =====
// The legacy Mines handlers above only simulated a round in localStorage. That
// made the UI look correct, but the server never received a completed game and
// could not safely unlock the Mines task. Keep the existing iPhone-safe board
// renderer and replace only the money-moving handlers with signed API calls.
async function fleepGameGet(path) {
    const initData = await waitForTelegramInitData();
    const headers = initData ? { 'X-Telegram-Init-Data': initData } : {};
    const response = await fetch(BACKEND_URL + path, { method: 'GET', headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data || !data.ok) {
        const error = new Error((data && data.error) || 'server_error');
        error.data = data || {};
        error.status = response.status;
        throw error;
    }
    return data;
}

function showMinesServerBoard() {
    const board = $id('game-board');
    const minesGame = $id('mines-game');
    const settings = minesGame ? minesGame.querySelector('.mines-settings-new') || minesGame.querySelector('.game-settings') : null;
    if (!board) throw new Error('game-board not found');
    board.classList.remove('hidden');
    if (settings) settings.style.display = 'none';
}

function markMinesSafeCell(index) {
    const cell = gameState.gameBoard && gameState.gameBoard[index];
    if (!cell) return;
    cell.isRevealed = true;
    cell.isMine = false;
    cell.element.classList.remove('mine');
    cell.element.classList.add('revealed', 'safe');
}

function markMinesMineCell(index) {
    const cell = gameState.gameBoard && gameState.gameBoard[index];
    if (!cell) return;
    cell.isRevealed = true;
    cell.isMine = true;
    cell.element.classList.add('revealed', 'mine');
}

function renderMinesServerSession(session) {
    const size = [3, 5].includes(Number(session.size)) ? Number(session.size) : 5;
    const mines = Math.max(1, Math.min(size * size - 1, Math.floor(Number(session.mines) || 3)));
    const revealed = Array.isArray(session.revealed) ? session.revealed.map(Number).filter(Number.isSafeInteger) : [];
    gameConfig.size = size;
    gameConfig.mines = mines;
    gameState.isPlaying = true;
    gameState._serverSessionId = String(session.session_id || '');
    gameState._serverFinished = false;
    gameState._serverRevealPending = false;
    gameState._serverCashoutPending = false;
    gameState._serverRevealActionIds = {};
    gameState.currentBet = Math.max(MIN_GAME_STAKE, Math.floor(Number(session.bet) || MIN_GAME_STAKE));
    gameState.betType = session.currency === 'gold' ? 'gold' : 'silver';
    gameState.currentCoefficient = Math.max(1, Number(session.coefficient) || 1);
    const sessionPayout = Number(session.win);
    gameState.currentPayout = Number.isFinite(sessionPayout) ? Math.max(0, Math.floor(sessionPayout)) : null;
    gameState.totalCells = size * size;
    gameState.revealedCells = revealed.length;
    gameState.minesLeft = mines;
    gameState.minesPositions = [];
    gameState.canCashOut = revealed.length > 0;
    createGameBoard();
    showMinesServerBoard();
    revealed.forEach(markMinesSafeCell);
    const cashout = $id('cashout-btn');
    if (cashout) cashout.disabled = !gameState.canCashOut;
    updateGameInterface();
    updateBalance();
}

async function restoreServerMinesSession() {
    if (gameState._serverRestorePending || gameState.isPlaying || !getTgUser()) return;
    gameState._serverRestorePending = true;
    try {
        const data = await fleepGameGet('/game/session');
        const session = data && data.session;
        if (session && session.game === 'mines' && session.session_id) renderMinesServerSession(session);
    } catch (e) {
        // A fresh page outside Telegram has no signed identity; local UI remains usable.
    } finally {
        gameState._serverRestorePending = false;
    }
}

function applyMinesServerProgress(result) {
    if (!result) return;
    const revealed = Array.isArray(result.revealed) ? result.revealed.map(Number).filter(Number.isSafeInteger) : [];
    revealed.forEach(markMinesSafeCell);
    if (Number.isSafeInteger(Number(result.safe))) markMinesSafeCell(Number(result.safe));
    if (Array.isArray(result.mines)) {
        gameState.minesPositions = result.mines.map(Number).filter(Number.isSafeInteger);
    }
    gameState.revealedCells = revealed.length || gameState.gameBoard.filter(cell => cell && cell.isRevealed && !cell.isMine).length;
    gameState.currentCoefficient = Math.max(1, Number(result.coefficient) || gameState.currentCoefficient || 1);
    const serverPayout = Number(result.win);
    if (Number.isFinite(serverPayout)) gameState.currentPayout = Math.max(0, Math.floor(serverPayout));
    gameState.canCashOut = gameState.revealedCells > 0;
    const cashout = $id('cashout-btn');
    if (cashout) cashout.disabled = !gameState.canCashOut;
    updateGameInterface();
}

function finishMinesServerResult(result) {
    if (!result || gameState._serverFinished) return;
    if (result.status === 'active') {
        applyMinesServerProgress(result);
        return;
    }
    if (result.status !== 'settled' && result.status !== 'lost') return;
    gameState._serverFinished = true;
    applyRocketServerBalance(result, true);
    applyMinesServerProgress(result);
    if (Number.isSafeInteger(Number(result.mine))) markMinesMineCell(Number(result.mine));
    if (gameState.minesPositions.length) revealAllMines();

    const win = Math.max(0, Math.floor(Number(result.win) || 0));
    const won = result.status === 'settled';
    userData.stats = userData.stats || {};
    userData.stats.gamesPlayed = (userData.stats.gamesPlayed || 0) + 1;
    userData.stats.minesPlayed = (userData.stats.minesPlayed || 0) + 1;
    if (won) {
        userData.stats.gamesWon = (userData.stats.gamesWon || 0) + 1;
        userData.stats.totalWon = (userData.stats.totalWon || 0) + win;
        userData.consecutiveWins = (userData.consecutiveWins || 0) + 1;
    } else {
        userData.stats.gamesLost = (userData.stats.gamesLost || 0) + 1;
        userData.consecutiveWins = 0;
    }
    if (gameState.currentCoefficient > (userData.stats.maxCoefficient || 0)) {
        userData.stats.maxCoefficient = gameState.currentCoefficient;
    }
    gameState.isPlaying = false;
    gameState.canCashOut = false;
    const cashout = $id('cashout-btn');
    if (cashout) cashout.disabled = true;
    saveUserData();
    updateBalance();
    updateStats();
    addToGameHistory(won, gameState.currentBet, win, gameState.currentCoefficient);
    updateTasks();
    loadServerTaskProgress();
    if (won && win > 0) setTimeout(() => showCoinWinModal(win, gameState.betType), 500);
    setTimeout(newGame, 1500);
}

async function startGame() {
    if (gameState._serverStartPending || gameState.isPlaying) return;
    if (!userData.balance) userData.balance = { gold: 0, silver: 0 };
    if (gameState.betType !== 'gold' && gameState.betType !== 'silver') gameState.betType = 'silver';
    gameConfig.size = [3, 5].includes(Number(gameConfig.size)) ? Number(gameConfig.size) : 5;
    gameConfig.mines = Math.floor(Number(gameConfig.mines) || 1);
    const bet = Math.floor(Number(gameState.currentBet) || 0);
    if (bet < MIN_GAME_STAKE) { showNotif(`Минимальная ставка — ${MIN_GAME_STAKE}.`, '#f87171'); return; }
    if (gameConfig.mines < 1 || gameConfig.mines >= gameConfig.size * gameConfig.size) {
        showNotif('Некорректное количество мин.', '#f87171');
        return;
    }
    gameState._serverStartPending = true;
    gameState._serverStartActionId = gameState._serverStartActionId || fleepActionId('mines_start');
    try {
        const result = await fleepGameApi('/game/mines/start', {
            bet,
            currency: gameState.betType,
            size: gameConfig.size,
            mines: gameConfig.mines,
            action_id: gameState._serverStartActionId,
        });
        applyRocketServerBalance(result, true);
        if (gameState.betType === 'silver') addWager(bet);
        renderMinesServerSession({
            session_id: result.session_id,
            currency: result.currency,
            bet: result.bet,
            size: result.size,
            mines: result.mines,
            revealed: result.revealed,
            coefficient: result.coefficient,
        });
        gameState._serverStartActionId = null;
        saveUserData();
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (e && e.data && e.data.error === 'active_game_exists') {
            await restoreServerMinesSession();
        } else if (typeof showNotif === 'function') {
            const message = e && e.data && e.data.error === 'insufficient_balance'
                ? 'Недостаточно средств.'
                : e && e.data && e.data.error === 'unauthorized'
                    ? 'Откройте игру через Telegram.'
                    : 'Не удалось запустить «Мины». Попробуйте ещё раз.';
            showNotif(message, '#f87171');
        }
    } finally {
        gameState._serverStartPending = false;
    }
}

async function revealCell(index) {
    if (!gameState.isPlaying || !gameState._serverSessionId || gameState._serverRevealPending) return;
    index = Math.floor(Number(index));
    if (!Number.isSafeInteger(index) || index < 0 || index >= gameState.totalCells) return;
    const cell = gameState.gameBoard[index];
    if (!cell || cell.isRevealed) return;
    gameState._serverRevealPending = true;
    gameState._serverRevealActionIds = gameState._serverRevealActionIds || {};
    const actionId = gameState._serverRevealActionIds[index] || fleepActionId('mines_reveal');
    gameState._serverRevealActionIds[index] = actionId;
    try {
        const result = await fleepGameApi('/game/mines/reveal', {
            session_id: gameState._serverSessionId,
            index,
            action_id: actionId,
        });
        delete gameState._serverRevealActionIds[index];
        if (result.status === 'lost' || result.status === 'settled') finishMinesServerResult(result);
        else applyMinesServerProgress(result);
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (typeof showNotif === 'function') showNotif('Не удалось открыть клетку. Нажмите ещё раз.', '#f59e0b');
    } finally {
        gameState._serverRevealPending = false;
    }
}

async function cashOut() {
    if (!gameState.isPlaying || !gameState._serverSessionId || !gameState.canCashOut || gameState._serverCashoutPending) return;
    gameState._serverCashoutPending = true;
    gameState._serverCashoutActionId = gameState._serverCashoutActionId || fleepActionId('mines_cashout');
    try {
        const result = await fleepGameApi('/game/mines/cashout', {
            session_id: gameState._serverSessionId,
            action_id: gameState._serverCashoutActionId,
        });
        finishMinesServerResult(result);
        gameState._serverCashoutActionId = null;
    } catch (e) {
        if (e && e.data) applyRocketServerBalance(e.data, true);
        if (typeof showNotif === 'function') showNotif('Выигрыш ещё не забран. Попробуйте ещё раз.', '#f59e0b');
    } finally {
        gameState._serverCashoutPending = false;
    }
}

// ══════════════════════════════════════════════════════
//  РУЛЕТКА
// ══════════════════════════════════════════════════════
const rouletteState = { bet: 100, rooms: [], joinedRoom: null, isHost: false };

function rouletteInit() {
    const el = document.getElementById('roulette-balance-val');
    if (el) el.textContent = userData.balance.silver;
    rouletteSetBet(rouletteState.bet);
    rouletteRenderRooms();
    rouletteShowPanel('lobby');
}

function rouletteShowPanel(panel) {
    ['roulette-lobby','roulette-room','roulette-spin','roulette-result'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const t = document.getElementById('roulette-' + panel);
    if (t) t.style.display = 'flex';
}

function rouletteSetBet(val) {
    rouletteState.bet = Math.max(10, Math.floor(val));
    const inp = document.getElementById('roulette-bet-input');
    if (inp) inp.value = rouletteState.bet;
}
function rouletteBetChange(d) { rouletteSetBet(rouletteState.bet + d); }

function rouletteCreateRoom() {
    const bet = rouletteState.bet;
    if (bet > userData.balance.silver) { showNotif('⚠️ Недостаточно средств!', '#ef4444'); return; }
    const name = (typeof getTgUser === 'function' && getTgUser()?.username) || 'Игрок';
    userData.balance.silver -= bet;
    saveUserData(); updateBalance();
    document.getElementById('roulette-balance-val').textContent = userData.balance.silver;

    const room = { id: Date.now().toString(36), host: name, hostBet: bet, guest: null, guestBet: 0, createdAt: Date.now() };
    rouletteState.rooms.push(room);
    rouletteState.joinedRoom = room;
    rouletteState.isHost = true;
    rouletteRenderRoom(room);
}

function rouletteJoinRoom(roomId) {
    const room = rouletteState.rooms.find(r => r.id === roomId);
    if (!room || room.guest) { showNotif('Комната уже занята', '#ef4444'); return; }
    const bet = room.hostBet;
    if (bet > userData.balance.silver) { showNotif('⚠️ Нужно ' + bet + ' F', '#ef4444'); return; }
    const name = (typeof getTgUser === 'function' && getTgUser()?.username) || 'Гость';
    userData.balance.silver -= bet;
    saveUserData(); updateBalance();
    document.getElementById('roulette-balance-val').textContent = userData.balance.silver;

    room.guest = name; room.guestBet = bet;
    rouletteState.joinedRoom = room;
    rouletteState.isHost = false;
    rouletteRenderRoom(room);
    setTimeout(() => rouletteStartSpin(room), 1500);
}

function rouletteRenderRoom(room) {
    rouletteShowPanel('room');
    const setText = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('r-p1-name', room.host);
    setText('r-p1-bet', room.hostBet + ' F');
    setText('r-p1-pct', '—%');

    const p2card = document.getElementById('r-player2-card');
    if (room.guest) {
        setText('r-p2-name', room.guest);
        setText('r-p2-bet', room.guestBet + ' F');
        if (p2card) p2card.style.opacity = '1';
        const total = room.hostBet + room.guestBet;
        const p1 = Math.round(room.hostBet / total * 100);
        rouletteUpdateBar(p1, 100 - p1);
        setText('r-p1-pct', p1 + '%');
        setText('r-p2-pct', (100-p1) + '%');
    } else {
        setText('r-p2-name', 'Ожидание...');
        setText('r-p2-bet', '— F');
        if (p2card) p2card.style.opacity = '0.5';
    }
    setText('r-total-pot-label', 'Банк: ' + (room.hostBet + (room.guestBet||0)) + ' F');

    const cancelBtn = document.getElementById('r-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = (rouletteState.isHost && !room.guest) ? 'block' : 'none';

    const statusEl = document.getElementById('r-status-text');
    if (statusEl) statusEl.innerHTML = room.guest
        ? '<span style="font-size:0.82rem;color:#4ade80;">Игрок вошёл! Запускаем…</span>'
        : '<span style="font-size:0.82rem;color:#666;">Ожидаем второго игрока…</span>';

    rouletteRenderRooms();
}

function rouletteUpdateBar(p1, p2) {
    const wrap = document.getElementById('r-chance-bar-wrap');
    if (wrap) wrap.style.display = 'block';
    const l = document.getElementById('r-chance-left'); if(l) l.style.width = p1+'%';
    const r = document.getElementById('r-chance-right'); if(r) r.style.width = p2+'%';
    const ll = document.getElementById('r-chance-left-label'); if(ll) ll.textContent = p1+'%';
    const rl = document.getElementById('r-chance-right-label'); if(rl) rl.textContent = p2+'%';
}

function rouletteCancelRoom() {
    const room = rouletteState.joinedRoom;
    if (room) {
        userData.balance.silver += room.hostBet;
        saveUserData(); updateBalance();
        document.getElementById('roulette-balance-val').textContent = userData.balance.silver;
        rouletteState.rooms = rouletteState.rooms.filter(r => r.id !== room.id);
    }
    rouletteState.joinedRoom = null;
    rouletteState.isHost = false;
    rouletteShowPanel('lobby');
    rouletteRenderRooms();
}

function rouletteStartSpin(room) {
    const total = room.hostBet + room.guestBet;
    const p1pct = room.hostBet / total;
    const p1Wins = Math.random() < p1pct;

    // Обновляем банк в UI
    const potEl = document.getElementById('r-spin-pot');
    const centEl = document.getElementById('r-center-pot');
    if (potEl) potEl.textContent = total + ' F';
    if (centEl) centEl.textContent = total;

    rouletteShowPanel('spin');
    setTimeout(() => rouletteDrawWheel(p1pct, p1Wins, room), 100);
}

function rouletteDrawWheel(p1pct, p1Wins, room) {
    const canvas = document.getElementById('r-wheel-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 280;
    const cx = size / 2, cy = size / 2, r = size / 2 - 2;

    // Цвета секторов — несколько оттенков для красивости
    const p1colors = ['#ef4444','#f87171','#dc2626','#fb7185'];
    const p2colors = ['#7b5cff','#a855f7','#6d28d9','#8b5cf6'];

    // Генерируем мини-сегменты (~40 штук) для красивого колеса
    const totalSegs = 40;
    const p1count = Math.max(1, Math.round(totalSegs * p1pct));
    const p2count = Math.max(1, totalSegs - p1count);
    let segs = [];
    for (let i = 0; i < p1count; i++) segs.push(1);
    for (let i = 0; i < p2count; i++) segs.push(2);
    // Перемешиваем
    for (let i = segs.length-1; i > 0; i--) {
        const j = Math.floor(Math.random()*(i+1)); [segs[i],segs[j]]=[segs[j],segs[i]];
    }

    const segAngle = (2 * Math.PI) / segs.length;

    // Рисуем статичное колесо (до вращения)
    function drawWheel(rotation) {
        ctx.clearRect(0, 0, size, size);
        segs.forEach((player, i) => {
            const startA = rotation + i * segAngle - Math.PI/2;
            const endA = startA + segAngle;
            const colors = player === 1 ? p1colors : p2colors;
            const color = colors[i % colors.length];

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, startA, endA);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();

            // Тонкая граница между сегментами
            ctx.strokeStyle = 'rgba(0,0,0,0.3)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Инициал игрока в центре сегмента
            const midA = startA + segAngle / 2;
            const textR = r * 0.72;
            const tx = cx + textR * Math.cos(midA);
            const ty = cy + textR * Math.sin(midA);
            ctx.save();
            ctx.translate(tx, ty);
            ctx.rotate(midA + Math.PI/2);
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(player === 1 ? room.host[0].toUpperCase() : room.guest[0].toUpperCase(), 0, 0);
            ctx.restore();
        });

        // Внутренний круг (маска)
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.32, 0, 2*Math.PI);
        ctx.fillStyle = '#13131f';
        ctx.fill();
    }

    // Определяем финальный угол — указатель (сверху = -π/2) должен попасть на нужный сектор
    const winnerPlayer = p1Wins ? 1 : 2;
    // Находим случайный сегмент победителя
    const winSegs = segs.map((s,i)=>({s,i})).filter(x=>x.s===winnerPlayer);
    const winSeg = winSegs[Math.floor(Math.random()*winSegs.length)];
    const winMidAngle = winSeg.i * segAngle + segAngle/2; // угол середины сегмента (от 0)
    // Нужно повернуть так чтобы winMidAngle оказался на -π/2 (верхушка)
    const targetRotation = -Math.PI/2 - winMidAngle;
    // Добавляем 5+ полных оборотов
    const fullSpins = (5 + Math.floor(Math.random()*3)) * 2 * Math.PI;
    const finalRotation = targetRotation - fullSpins;

    // Анимация
    const duration = 4500;
    const startTime = performance.now();
    const startRotation = 0;

    function ease(t) { return 1 - Math.pow(1-t, 4); } // ease-out quart

    function animate(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const rot = startRotation + (finalRotation - startRotation) * ease(t);
        drawWheel(rot);
        if (t < 1) {
            requestAnimationFrame(animate);
        } else {
            drawWheel(finalRotation);
            setTimeout(() => rouletteShowResult(p1Wins, room), 600);
        }
    }

    drawWheel(0);
    requestAnimationFrame(animate);
}

function rouletteShowResult(p1Wins, room) {
    const iWin = (rouletteState.isHost && p1Wins) || (!rouletteState.isHost && !p1Wins);
    const total = room.hostBet + room.guestBet;
    const myBet = rouletteState.isHost ? room.hostBet : room.guestBet;

    rouletteShowPanel('result');
    const setT = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };

    setT('r-result-bet', myBet + ' F');

    if (iWin) {
        userData.balance.silver += total;
        saveUserData(); updateBalance();
        document.getElementById('roulette-balance-val').textContent = userData.balance.silver;
        document.getElementById('r-result-icon').textContent = '🎉';
        setT('r-result-title', 'ПОБЕДА!');
        document.getElementById('r-result-title').style.color = '#4ade80';
        setT('r-result-sub', 'Колесо выпало на вас!');
        const winEl = document.getElementById('r-result-win');
        if (winEl) { winEl.textContent = '+' + (total - myBet) + ' F'; winEl.style.color = '#4ade80'; }
        showNotif('🎉 Победа! +' + (total - myBet) + ' F', '#22c55e');
    } else {
        document.getElementById('r-result-icon').textContent = '😔';
        setT('r-result-title', 'ПОРАЖЕНИЕ');
        document.getElementById('r-result-title').style.color = '#ef4444';
        setT('r-result-sub', 'Не повезло в этот раз!');
        const winEl = document.getElementById('r-result-win');
        if (winEl) { winEl.textContent = '−' + myBet + ' F'; winEl.style.color = '#ef4444'; }
        showNotif('😔 Поражение, −' + myBet + ' F', '#ef4444');
    }

    if (!userData.rouletteHistory) userData.rouletteHistory = [];
    userData.rouletteHistory.unshift({ ts: Date.now(), bet: myBet, total, win: iWin, opponent: rouletteState.isHost ? (room.guest||'?') : room.host });
    if (userData.rouletteHistory.length > 20) userData.rouletteHistory.length = 20;
    saveUserData();
    rouletteState.rooms = rouletteState.rooms.filter(r => r.id !== room.id);
    rouletteState.joinedRoom = null;
    rouletteRenderHistory();
}

function rouletteBackToLobby() {
    rouletteShowPanel('lobby');
    rouletteRenderRooms();
    const el = document.getElementById('roulette-balance-val');
    if (el) el.textContent = userData.balance.silver;
}

function rouletteRenderRooms() {
    const container = document.getElementById('roulette-rooms-list');
    const noRooms = document.getElementById('roulette-no-rooms');
    if (!container) return;
    const now = Date.now();
    const open = rouletteState.rooms.filter(r => !r.guest && now - r.createdAt < 600000);
    container.querySelectorAll('.r-room-card').forEach(e => e.remove());
    if (!open.length) { if (noRooms) noRooms.style.display = 'block'; return; }
    if (noRooms) noRooms.style.display = 'none';
    open.forEach(room => {
        const card = document.createElement('div');
        card.className = 'r-room-card';
        card.style.cssText = 'background:linear-gradient(145deg,#13131f,#1a1a2e);border:1px solid rgba(239,68,68,0.2);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:12px;margin-bottom:8px;cursor:pointer;';
        card.innerHTML = `<div style="font-size:1.4rem;">🎰</div>
            <div style="flex:1;"><div style="font-size:0.8rem;font-weight:800;color:#e0d0ff;">${room.host}</div><div style="font-size:0.62rem;color:#555;">ждёт соперника</div></div>
            <div style="background:rgba(252,211,77,0.1);border:1px solid rgba(252,211,77,0.2);border-radius:8px;padding:3px 10px;font-size:0.78rem;font-weight:900;color:#fcd34d;">${room.hostBet} F</div>
            <button onclick="rouletteJoinRoom('${room.id}')" style="padding:7px 14px;border-radius:10px;border:none;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;font-size:0.72rem;font-weight:800;cursor:pointer;">Войти</button>`;
        container.appendChild(card);
    });
}

function rouletteRenderHistory() {
    const list = document.getElementById('roulette-history-list');
    if (!list) return;
    const hist = userData.rouletteHistory || [];
    if (!hist.length) { list.innerHTML = '<div style="text-align:center;padding:12px;color:#444;font-size:0.78rem;">Нет игр</div>'; return; }
    list.innerHTML = hist.slice(0,10).map(h => {
        const t = new Date(h.ts);
        const time = t.getHours()+':'+String(t.getMinutes()).padStart(2,'0');
        const color = h.win ? '#22c55e' : '#ef4444';
        const diff = h.win ? (h.total - h.bet) : h.bet;
        return `<div class="history-item" style="border-left-color:${color}"><span class="history-time">${time}</span><span class="history-desc">Ставка: ${h.bet}F vs ${h.opponent}</span><span class="history-result" style="color:${color}">${h.win?'+':'-'}${diff}F</span></div>`;
    }).join('');
}

// Хук в selectGame
const _rouletteOrigSG = window.selectGame;
window.selectGame = function(game) {
    if (_rouletteOrigSG) _rouletteOrigSG(game);
    if (game === 'roulette') setTimeout(rouletteInit, 50);
};
