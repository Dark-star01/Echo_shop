const express = require('express');
const path = require('path');
const db = require('../utils/db.js');

const app = express();
// Render يعطي البورت تلقائيًا عبر process.env.PORT — نرجع لـ DASHBOARD_PORT محليًا فقط
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐  دالة مساعدة: تحليل بيانات Basic Auth بأمان (تدعم رمز ":" داخل كلمة المرور نفسها)
function parseBasicAuth(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return null;
    const base64 = authHeader.slice('Basic '.length);
    const decoded = Buffer.from(base64, 'base64').toString();
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return null;
    return {
        username: decoded.slice(0, separatorIndex),
        password: decoded.slice(separatorIndex + 1), // كل شي بعد أول ":" حتى لو فيه ":" إضافية
    };
}

// 🔐  نقطة دخول مخصصة: تعطي رسالة خطأ دقيقة (اسم مستخدم غلط / كلمة مرور غلط) قبل استخدام باقي الـ API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};

    if (username !== process.env.DASHBOARD_USERNAME) {
        // ما نكشف تفصيل أكثر لو اسم المستخدم نفسه غلط (أمان)
        return res.status(401).json({ success: false, field: 'both', message: 'بيانات الدخول غير صحيحة' });
    }
    if (password !== process.env.DASHBOARD_PASSWORD) {
        // اسم المستخدم صح، بس كلمة المرور غلط — نقدر نحدد بدقة هنا
        return res.status(401).json({ success: false, field: 'password', message: 'كلمة المرور غير صحيحة' });
    }
    res.json({ success: true });
});

// 🔐  المصادقة (Basic Auth) لباقي مسارات API
app.use('/api', (req, res, next) => {
    const parsed = parseBasicAuth(req.headers.authorization);
    if (!parsed) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
        return res.status(401).send('Authentication required');
    }
    if (parsed.username === process.env.DASHBOARD_USERNAME && parsed.password === process.env.DASHBOARD_PASSWORD) {
        return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
    res.status(401).send('Invalid credentials');
});

// 📊  API: جلب جميع المنتجات
app.get('/api/products', async (req, res) => {
    try {
        const products = await db.getAllProducts();
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ➕  API: إضافة منتج جديد
app.post('/api/products', async (req, res) => {
    const { role_id, name, price, description, features } = req.body;
    if (!role_id || !name || !price) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const product = await db.addProduct({ role_id, name, price, description: description || '', features: features || '' });
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✏️  API: تعديل منتج
app.put('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const { role_id, name, price, description, features } = req.body;
    try {
        const product = await db.updateProduct(id, { role_id, name, price, description: description || '', features: features || '' });
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🗑️  API: حذف منتج
app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.deleteProduct(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📊  API: إحصائيات
app.get('/api/stats', async (req, res) => {
    try {
        const total = await db.countProducts();
        res.json({ totalProducts: total });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🧾  API: سجل محاولات الدفع
app.get('/api/logs', async (req, res) => {
    try {
        const logs = await db.getLogs(200);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🏠  صفحة Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🌐 Dashboard running on port ${PORT}`);
});
