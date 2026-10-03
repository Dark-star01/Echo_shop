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

module.exports = {
    PERMISSION_WHITELIST, COLOR_MODES, HOLOGRAPHIC, MAX_ICON_BYTES, DEFAULT_CUSTOM_SETTINGS,
    sanitizeCustomSettings, permissionBits, parseHex,
};
