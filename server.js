const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const { createAuthMiddleware } = require('./middleware/auth');
const { createExamHelpers } = require('./helpers/exam-helpers');
const { createAiRouter } = require('./routes/ai');
const { createExamRouter } = require('./routes/exam');
const { createSubmitRouter } = require('./routes/submit');
const { createResultRouter } = require('./routes/result');
const { createGradingRouter } = require('./routes/grading');

// ===== KHỞI TẠO FIREBASE ADMIN =====
let dbAdmin;
let authAdmin;

const requiredEnvVars = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key] || process.env[key].trim() === '');

if (missingEnvVars.length > 0) {
    console.error(`❌ Thiếu biến môi trường bắt buộc trên Render: ${missingEnvVars.join(', ')}`);
    console.error('   Vào Render Dashboard -> service này -> tab "Environment" -> kiểm tra đủ 3 biến FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (đúng tên, không rỗng), rồi deploy lại.');
    process.exit(1);
}

try {
    const firebaseApp = initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        })
    });

    dbAdmin = getFirestore(firebaseApp);
    authAdmin = getAuth(firebaseApp);

    console.log('✅ Firebase Admin SDK khởi tạo thành công.');
} catch (err) {
    console.error('❌ Lỗi khởi tạo Firebase Admin SDK:', err.message);
    console.error('   Kiểm tra lại 3 biến môi trường trên Render: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
    process.exit(1);
}

// ===== EXPRESS APP =====
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🚀 VietLearn Backend API đang hoạt động mượt mà!');
});

// ===== KẾT NỐI MIDDLEWARE, HELPER VÀ ROUTER =====
const { verifyFirebaseToken, requireTeacherRole } = createAuthMiddleware({ authAdmin, dbAdmin });
const examHelpers = createExamHelpers({ dbAdmin, FieldValue, FieldPath });

app.use('/api', createExamRouter({ dbAdmin, verifyFirebaseToken, examHelpers }));
app.use('/api', createAiRouter({ requireTeacherRole }));
app.use('/api', createSubmitRouter({ dbAdmin, FieldValue, verifyFirebaseToken, examHelpers }));
app.use('/api', createResultRouter({ dbAdmin, verifyFirebaseToken, examHelpers }));
app.use('/api', createGradingRouter({ authAdmin, dbAdmin, FieldValue }));

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
    return res.status(200).json({ status: 'ok' });
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    const rawStatus = Number(err && (err.status || err.statusCode));
    const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    console.error('Lỗi chưa được xử lý:', err);
    return res.status(status).json({
        message: status >= 500
            ? 'Lỗi server không mong đợi. Vui lòng thử lại.'
            : 'Yêu cầu không hợp lệ hoặc dữ liệu gửi lên quá lớn.'
    });
});

// ===== KHỞI ĐỘNG SERVER =====
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});
