// utils/customRoleConfig.js - إعدادات الرتب القابلة للإنشاء (مشتركة بين البوت والداشبورد)
const { PermissionFlagsBits } = require('discord.js');

// ✅ القائمة البيضاء: صلاحيات غير إدارية فقط. أي شي خارجها يُتجاهل حتى لو وصل من الداشبورد.
const PERMISSION_WHITELIST = {
    ChangeNickname: 'تغيير الاسم المستعار',
    UseExternalEmojis: 'استخدام إيموجيات من سيرفرات أخرى',
    UseExternalStickers: 'استخدام ستيكرات من سيرفرات أخرى',
    AttachFiles: 'إرفاق الملفات',
    EmbedLinks: 'تضمين الروابط',
    AddReactions: 'إضافة تفاعلات',
    UseApplicationCommands: 'استخدام أوامر التطبيقات',
    Connect: 'الاتصال بالقنوات الصوتية',
    Speak: 'التحدث في الصوت',
    Stream: 'البث والفيديو',
};

const COLOR_MODES = { solid: 'لون عادي', gradient: 'ثنائي اللون (تدرج)', holographic: 'هولوغرافيك' };

// قيم الستايل الهولوغرافيك ثابتة من ديسكورد ولا يمكن تغييرها
const HOLOGRAPHIC = { primaryColor: 11127295, secondaryColor: 16759788, tertiaryColor: 16761760 };

const MAX_ICON_BYTES = 252 * 1024; // الحد الفعلي 256KB — هامش أمان بسيط

const DEFAULT_CUSTOM_SETTINGS = {
    color_modes: ['solid'],
    allow_icon: false,
    max_name_length: 32,
    banned_words: [],
    permissions: [],
    require_review: false,
    edit_price: 0,
    edit_cooldown_days: 7,
};

const toInt = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** ينظّف إعدادات قادمة من الداشبورد ويرجع كائن آمن */
function sanitizeCustomSettings(raw = {}) {
    const modes = (Array.isArray(raw.color_modes) ? raw.color_modes : []).filter(m => m in COLOR_MODES);
    const banned = Array.isArray(raw.banned_words)
        ? raw.banned_words
        : String(raw.banned_words ?? '').split(/[,\n،]/);
    return {
        color_modes: modes.length ? [...new Set(modes)] : ['solid'],
        allow_icon: Boolean(raw.allow_icon),
        max_name_length: toInt(raw.max_name_length, 1, 100, 32),
        banned_words: [...new Set(banned.map(w => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 100),
        permissions: [...new Set((Array.isArray(raw.permissions) ? raw.permissions : []).filter(k => k in PERMISSION_WHITELIST))],
        require_review: Boolean(raw.require_review),
        edit_price: toInt(raw.edit_price, 0, 2_000_000_000, 0),
        edit_cooldown_days: toInt(raw.edit_cooldown_days, 0, 365, 7),
    };
}

const permissionBits = (keys) => keys.filter(k => k in PERMISSION_WHITELIST).map(k => PermissionFlagsBits[k]);

function parseHex(input) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(input ?? '').trim());
    return m ? parseInt(m[1], 16) : null;
}

// 🎨 ألوان جاهزة تظهر في قائمة داخل ديسكورد (وفي منتقي الألوان على الويب)
const PALETTE = [
    ['أحمر', 'E74C3C', '🔴'], ['أحمر غامق', 'B71C1C', '🟥'], ['وردي', 'E91E63', '🌸'], ['وردي فاتح', 'FF9FF3', '💗'],
    ['برتقالي', 'E67E22', '🟠'], ['ذهبي', 'F1C40F', '🟡'], ['أصفر', 'FFEB3B', '⭐'], ['ليموني', 'C6FF00', '🍋'],
    ['أخضر', '2ECC71', '🟢'], ['أخضر غامق', '1F8B4C', '🌿'], ['فيروزي', '1ABC9C', '🧊'], ['سماوي', '00D4FF', '💧'],
    ['أزرق', '3498DB', '🔵'], ['أزرق ملكي', '5865F2', '🟦'], ['كحلي', '2C3E7A', '🌊'], ['بنفسجي', '9B59B6', '🟣'],
    ['بنفسجي غامق', '71368A', '🔮'], ['بني', '8B5A2B', '🟤'], ['أسود', '23272A', '⚫'], ['رمادي غامق', '4F545C', '🩶'],
    ['رمادي', '95A5A6', '🪨'], ['فضي', 'C0C7D0', '🥈'], ['أبيض', 'F2F3F5', '⚪'], ['ذهبي غامق', 'B8860B', '🏆'],
];
const paletteHex = (hex) => PALETTE.find(([, h]) => h === String(hex || '').replace('#', '').toUpperCase());

module.exports = {
    PALETTE, paletteHex,
    PERMISSION_WHITELIST, COLOR_MODES, HOLOGRAPHIC, MAX_ICON_BYTES, DEFAULT_CUSTOM_SETTINGS,
    sanitizeCustomSettings, permissionBits, parseHex,
};
