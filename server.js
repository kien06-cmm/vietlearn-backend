const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- FIREBASE ADMIN SDK v12+ (modular API) ---
// firebase-admin v12 trở lên đã loại bỏ hoàn toàn cách viết
// admin.initializeApp() / admin.credential.cert() / admin.firestore() kiểu
// namespace cũ. Từ v12+, phải import từng submodule riêng như dưới đây.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

/**
 * --- KHỞI TẠO FIREBASE ADMIN SDK — CẤU HÌNH BẰNG SERVICE ACCOUNT ---
 *
 * Cách lấy Service Account:
 * 1. Vào Firebase Console -> Project settings -> Service accounts.
 * 2. Bấm "Generate new private key" -> tải về 1 file .json.
 * 3. TUYỆT ĐỐI không commit file .json này lên Git. Thay vào đó, mở file
 *    .json ra, copy 3 giá trị sau vào phần "Environment Variables" của
 *    Render (Dashboard -> service -> Environment):
 *
 *      FIREBASE_PROJECT_ID   = project_id trong file .json
 *      FIREBASE_CLIENT_EMAIL = client_email trong file .json
 *      FIREBASE_PRIVATE_KEY  = private_key trong file .json
 *
 *    Riêng FIREBASE_PRIVATE_KEY: khi copy từ .json vào ô Environment
 *    Variable của Render, các ký tự xuống dòng thật sẽ bị Render lưu thành
 *    chuỗi "\n" (2 ký tự gạch chéo ngược + n) chứ không phải xuống dòng
 *    thật -> cần .replace(/\\n/g, '\n') lúc đọc lại như dưới đây, nếu
 *    không cert() sẽ báo lỗi "Invalid PEM formatted message" khi khởi
 *    động server.
 *
 * FIX (crash "Cannot read properties of undefined (reading 'cert')"):
 * lỗi này xảy ra vì bản firebase-admin v12+ không còn export namespace
 * "admin.credential" nữa (require('firebase-admin') vẫn chạy được nhưng
 * admin.credential là undefined) — phải import cert() trực tiếp từ
 * 'firebase-admin/app' như trên. Toàn bộ việc khởi tạo được bọc trong
 * try...catch: nếu thiếu/sai biến môi trường, server sẽ log rõ nguyên
 * nhân rồi dừng lại có kiểm soát (process.exit(1)) thay vì crash với
 * TypeError mơ hồ giữa chừng khi có request đầu tiên gọi tới dbAdmin.
 *
 * KHÔNG dùng chung Service Account này ở phía frontend (login.js,
 * register.js...) — nó có toàn quyền Admin, chỉ được nằm trên server.
 */
let dbAdmin;
let authAdmin;

// FIX (chẩn đoán nhanh trên Render): kiểm tra riêng từng biến môi trường
// TRƯỚC KHI gọi cert(), vì lỗi gốc từ firebase-admin ("Service account
// object must contain a string 'project_id' property") không cho biết
// CHÍNH XÁC biến nào trong 3 biến đang thiếu/rỗng — có thể chỉ 1 hoặc cả
// 3. Log dưới đây chỉ đích danh, đỡ phải đoán khi debug trên Render.
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
    // Log rõ nguyên nhân thật (thường là thiếu biến môi trường hoặc
    // FIREBASE_PRIVATE_KEY bị dính \n sai định dạng) rồi dừng process có
    // kiểm soát — tránh để server "sống dở chết dở", nhận request nhưng
    // mọi API dùng Firestore/Auth đều crash ngẫu nhiên về sau.
    console.error('❌ Lỗi khởi tạo Firebase Admin SDK:', err.message);
    console.error('   Kiểm tra lại 3 biến môi trường trên Render: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
    process.exit(1);
}

const app = express();

// Tăng giới hạn dung lượng để upload file không bị lỗi
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Bắt buộc: Lấy Port từ Render cấp, nếu không có thì dùng 3000
const PORT = process.env.PORT || 3000;

// Đường dẫn kiểm tra xem server có hoạt động không
app.get('/', (req, res) => {
    res.send('🚀 VietLearn Backend API đang hoạt động mượt mà!');
});

/**
 * Middleware xác thực học sinh: đọc Firebase ID Token từ header
 * "Authorization: Bearer <token>", xác minh bằng Admin SDK, gán uid thật
 * (không tin bất kỳ studentId nào client tự gửi trong body) vào req.uid.
 */
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!idToken) {
        return res.status(401).json({ message: 'Thiếu token xác thực. Vui lòng đăng nhập lại.' });
    }

    try {
        const decoded = await authAdmin.verifyIdToken(idToken);
        req.uid = decoded.uid;
        next();
    } catch (err) {
        console.error('Token không hợp lệ hoặc đã hết hạn:', err.message);
        return res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }
}

/**
 * Đọc đáp án đúng của 1 câu hỏi, hỗ trợ cả 2 dạng schema đang tồn tại thật
 * trong dữ liệu (xem ghi chú "LỆCH SCHEMA CÂU HỎI" trong hocsinh.js):
 *  - { answers: [{ text, correct: boolean }, ...] }  (dạng AI bóc tách ra)
 *  - { options: string[], correctAnswer: number }     (dạng schema cũ)
 */
function getCorrectIndexServer(q) {
    if (Array.isArray(q.answers)) {
        return q.answers.findIndex((a) => a && a.correct === true);
    }
    return typeof q.correctAnswer === 'number' ? q.correctAnswer : -1;
}

/**
 * Đọc danh sách text các đáp án, hỗ trợ cả 2 dạng schema (xem comment ở
 * getCorrectIndexServer) — dùng cho /api/get-result-detail để trả về danh
 * sách đáp án đã chuẩn hoá, khớp đúng cách hocsinh.js hiển thị lúc làm bài
 * (hàm getOptionTexts() phía client cùng logic).
 */
function getOptionTextsServer(q) {
    if (Array.isArray(q.answers)) {
        return q.answers.map((a) => (a && typeof a.text === 'string') ? a.text : '');
    }
    return Array.isArray(q.options) ? q.options : [];
}

// ===== GIAI ĐOẠN 4.3 — BẮT ĐẦU: helper cho câu hỏi CHẤM TAY (tự luận / nộp file) =====

/** Loại câu hỏi KHÔNG thể tự chấm, phải chờ giáo viên chấm (SpeedGrader). */
const MANUAL_QUESTION_TYPES = ['essay', 'upload'];

/** Giới hạn độ dài bài tự luận lưu vào results (document Firestore tối đa 1MB). */
const MAX_ESSAY_LENGTH = 20000;

function isManualQuestionServer(q) {
    return !!q && MANUAL_QUESTION_TYPES.includes(q.type);
}

/**
 * Chỉ chấp nhận file nằm trên Cloudinary (https). Học sinh không thể nhét link
 * tuỳ ý (javascript:, trang lạ...) vào results.manualItems[].fileUrl để giáo
 * viên bấm vào lúc chấm bài.
 */
function isAllowedUploadUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
    try {
        const u = new URL(value.trim());
        return u.protocol === 'https:'
            && (u.hostname === 'res.cloudinary.com' || u.hostname.endsWith('.cloudinary.com'));
    } catch (e) {
        return false;
    }
}

/**
 * Lấy câu trả lời của 1 câu chấm tay từ answers[questionId] học sinh gửi lên.
 * Chấp nhận cả dạng chuỗi thuần lẫn object ({ text | essayAnswer | fileUrl | url }).
 */
function extractManualAnswerServer(q, rawAnswer) {
    const asObject = (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) ? rawAnswer : null;

    if (q.type === 'essay') {
        const text = typeof rawAnswer === 'string'
            ? rawAnswer
            : (asObject ? (asObject.essayAnswer ?? asObject.text ?? asObject.answer) : '');
        return { essayAnswer: typeof text === 'string' ? text.trim().slice(0, MAX_ESSAY_LENGTH) : '' };
    }

    // upload
    const url = typeof rawAnswer === 'string'
        ? rawAnswer
        : (asObject ? (asObject.fileUrl ?? asObject.url) : '');
    const cleanUrl = typeof url === 'string' ? url.trim() : '';
    return {
        fileUrl: isAllowedUploadUrl(cleanUrl) ? cleanUrl : '',
        fileName: (asObject && typeof asObject.fileName === 'string') ? asObject.fileName.trim().slice(0, 200) : ''
    };
}

/**
 * "Làm lại bài": /api/submit-exam ghi results/{exam}_{student} bằng set() nên bản
 * cũ (điểm, lời phê của giáo viên) bị ghi đè. Trước khi ghi đè, lưu bản cũ vào
 * results/{id}/attempts/{submitTimeMs} để không mất dấu vết. Lỗi ở đây KHÔNG được
 * chặn việc nộp bài -> chỉ log.
 */
async function archivePreviousResultAttempt(resultRef) {
    try {
        const prevSnap = await resultRef.get();
        if (!prevSnap.exists) return;
        const prev = prevSnap.data();
        const prevMs = (prev.submitTime && typeof prev.submitTime.toMillis === 'function')
            ? prev.submitTime.toMillis()
            : Date.now();
        await resultRef.collection('attempts').doc(String(prevMs)).set({
            ...prev,
            archivedAt: FieldValue.serverTimestamp()
        });
    } catch (archiveErr) {
        console.error('Không lưu được bản nộp cũ (không chặn việc nộp bài):', archiveErr.message);
    }
}

// ===== GIAI ĐOẠN 4.3 — KẾT THÚC: helper cho câu hỏi CHẤM TAY =====

/**
 * Xác nhận học sinh (studentId) thực sự là thành viên active của lớp sở
 * hữu 1 bài kiểm tra cụ thể — dùng chung cho cả /api/submit-exam và
 * /api/get-exam-questions để tránh lặp code và đảm bảo 2 API áp cùng 1
 * mức kiểm tra quyền truy cập.
 *
 * Trả về { ok: true, examData } nếu hợp lệ, hoặc { ok: false, status,
 * message } nếu không — nơi gọi chỉ cần res.status(status).json({message}).
 */
async function loadExamForStudent(examId, studentId) {
    const examSnap = await dbAdmin.collection('exams').doc(examId).get();
    if (!examSnap.exists) {
        return { ok: false, status: 404, message: 'Không tìm thấy bài kiểm tra.' };
    }
    const examData = examSnap.data();

    if (examData.status !== 'active') {
        return { ok: false, status: 403, message: 'Bài kiểm tra đã đóng hoặc chưa mở, không thể tiếp tục.' };
    }

    const memberSnap = await dbAdmin
        .collection('class_members')
        .doc(`${studentId}_${examData.class_id}`)
        .get();
    if (!memberSnap.exists || memberSnap.data().status !== 'active') {
        return { ok: false, status: 403, message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' };
    }

    return { ok: true, examData };
}

/**
 * Tên lớp THẬT lấy từ classes/{classId}.className (Admin SDK).
 * Từ bước 3.2, exams.class_id là ID lớp thật (chính là mã tham gia lớp, vd "AB12CD"),
 * không còn là chữ tự nhập như "9A1" nữa — nếu cứ tin className client gửi kèm
 * (lam_bai.js dùng class_id làm dự phòng) thì results.className sẽ hiện ra mã lớp.
 * Lỗi ở đây KHÔNG được chặn việc nộp bài -> trả null để nơi gọi tự dùng giá trị dự phòng.
 */
async function loadClassNameById(classId) {
    if (!classId || typeof classId !== 'string') return null;
    try {
        const classSnap = await dbAdmin.collection('classes').doc(classId).get();
        if (!classSnap.exists) return null;
        const name = classSnap.data().className;
        return (typeof name === 'string' && name.trim()) ? name.trim() : null;
    } catch (classErr) {
        console.error('Không lấy được tên lớp (không chặn việc chấm điểm):', classErr.message);
        return null;
    }
}

/**
 * Lấy nội dung câu hỏi thật theo danh sách ID, chia chunk 10 vì toán tử
 * Firestore "in" giới hạn tối đa 10 giá trị/lần truy vấn. Giữ đúng thứ tự
 * questionIds ban đầu; bỏ qua câu hỏi đã bị xoá khỏi ngân hàng.
 */
async function fetchQuestionsByIds(questionIds) {
    const chunks = [];
    for (let i = 0; i < questionIds.length; i += 10) {
        chunks.push(questionIds.slice(i, i + 10));
    }

    const chunkSnaps = await Promise.all(
        chunks.map((chunk) =>
            dbAdmin
                .collection('questions')
                .where(FieldPath.documentId(), 'in', chunk)
                .get()
        )
    );

    const questionMap = {};
    chunkSnaps.forEach((snap) => {
        snap.docs.forEach((d) => {
            questionMap[d.id] = { id: d.id, ...d.data() };
        });
    });

    return questionIds.map((id) => questionMap[id]).filter(Boolean);
}

/**
 * Biến thể của loadExamForStudent() nhưng tra theo roomCode thay vì exam_id
 * — dùng cho GET /api/get-exam-questions (khớp luồng thật của
 * lam_bai.html?code=...). Tự query "exams" theo roomCode + status=='active'
 * ngay trên server (không tin exam_id do client tự gửi lên), rồi soát cùng
 * điều kiện thành viên lớp active như bản gốc.
 */
async function loadExamForStudentByRoomCode(roomCode, studentId) {
    const examsSnap = await dbAdmin
        .collection('exams')
        .where('roomCode', '==', roomCode)
        .where('status', '==', 'active')
        .limit(1)
        .get();

    if (examsSnap.empty) {
        return { ok: false, status: 404, message: 'Mã phòng không tồn tại hoặc đã đóng.' };
    }

    const examDoc = examsSnap.docs[0];
    const examData = examDoc.data();

    const memberSnap = await dbAdmin
        .collection('class_members')
        .doc(`${studentId}_${examData.class_id}`)
        .get();
    if (!memberSnap.exists || memberSnap.data().status !== 'active') {
        return { ok: false, status: 403, message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' };
    }

    return { ok: true, examId: examDoc.id, examData };
}

/**
 * --- (Phase 2 — Task 3) CHỐNG GIAN LẬN THỜI GIAN: ghi nhận / đọc lại mốc
 * bắt đầu làm bài THẬT trên server ---
 *
 * Trước đây server hoàn toàn TIN TƯỞNG giá trị "timeUsed" (giây) do client
 * (lam_bai.js) tự tính rồi gửi kèm lúc /api/submit-exam — học sinh chỉ cần
 * sửa biến này trong DevTools trước khi gọi API là có thể "làm bài không
 * giới hạn thời gian" mà vẫn được server ghi nhận như nộp đúng giờ.
 *
 * Bản vá: mỗi khi học sinh gọi GET /api/get-exam-questions (tức là THỰC SỰ
 * bắt đầu vào phòng thi), server ghi 1 mốc "startedAt" (epoch ms) vào
 * collection RIÊNG "exam_sessions", doc id "{examId}_{studentId}" — dùng
 * Admin SDK nên học sinh không thể tự sửa/xoá qua Firestore Rules.
 *
 * QUAN TRỌNG: nếu session đã tồn tại từ trước (học sinh F5 lại trang giữa
 * chừng, hoặc gọi lại API vì mất mạng), KHÔNG ghi đè startedAt — giữ
 * nguyên mốc bắt đầu GỐC. Nếu ghi đè mỗi lần gọi, học sinh chỉ cần F5 liên
 * tục là "reset" được đồng hồ thật trên server, quay lại y hệt lỗ hổng cũ.
 * Đây cũng chính là mốc mà lam_bai.js dùng để tính lại endTimeTimestamp khi
 * khôi phục tiến trình từ localStorage (Task 2) — 2 cơ chế cùng phối hợp:
 * client autosave để KHÔNG MẤT bài, server startedAt để KHÔNG GIAN LẬN được
 * thời gian, 2 việc độc lập nhau.
 *
 * Trả về startedAtMs (number, epoch millisecond) — luôn là mốc THẬT đầu
 * tiên học sinh vào phòng thi này, bất kể gọi hàm này bao nhiêu lần.
 */
async function getOrStartExamSession(examId, studentId, examData) {
    const sessionRef = dbAdmin.collection('exam_sessions').doc(`${examId}_${studentId}`);
    const sessionSnap = await sessionRef.get();

    if (sessionSnap.exists && typeof sessionSnap.data().startedAtMs === 'number') {
        return sessionSnap.data().startedAtMs;
    }

    const startedAtMs = Date.now();
    // set({...}, {merge:true}) thay vì tạo mới hoàn toàn: an toàn nếu 2
    // request GET /api/get-exam-questions chạy gần như đồng thời (double
    // click / mạng chập chờn gọi lại) — dù có ghi đè vài ms cũng chỉ lệch
    // không đáng kể, không tạo ra 2 document khác nhau cho cùng 1 lượt thi.
    await sessionRef.set({
        examId,
        studentId,
        startedAtMs,
        startedAt: FieldValue.serverTimestamp(),
        duration: Number(examData.duration) > 0 ? Number(examData.duration) : 15,
        unlimitedTime: examData.unlimitedTime === true
    }, { merge: true });

    return startedAtMs;
}

/**
 * Xáo mảng theo Fisher-Yates, dùng PRNG (mulberry32) được seed bằng 1 chuỗi
 * cố định (examId + studentId) -> luôn ra CÙNG 1 thứ tự cho cùng 1 học sinh
 * + cùng 1 bài thi, kể cả khi họ reload lại trang giữa chừng (tránh đổi thứ
 * tự liên tục gây rối, vì đáp án vẫn được lưu theo questionId nên việc xáo
 * thứ tự không ảnh hưởng gì tới độ chính xác khi chấm điểm).
 */
function seededShuffle(array, seedString) {
    let seed = 0;
    for (let i = 0; i < seedString.length; i++) {
        seed = (Math.imul(seed, 31) + seedString.charCodeAt(i)) | 0;
    }

    function nextRandom() {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * --- API Lấy câu hỏi theo Mã phòng thi (GET, dùng cho luồng lam_bai.js) ---
 *
 * Khác với /api/get-exam-questions (POST, nhận exam_id) ở dưới — vẫn giữ
 * nguyên để không phá vỡ bất kỳ chỗ nào khác đang gọi nó — bản GET này nhận
 * thẳng roomCode qua query string, khớp đúng URL thật lam_bai.html?code=...,
 * và cộng thêm 2 lớp mới:
 *
 *   - Giới hạn số lần làm bài (examData.maxAttempts): đếm qua collection
 *     RIÊNG "exam_attempts" (không đếm trực tiếp "results", vì "results"
 *     hiện dùng doc id cố định "{examId}_{studentId}" nên bị GHI ĐÈ mỗi lần
 *     nộp lại — không phản ánh đúng số lần đã làm thật). "exam_attempts"
 *     được cộng dồn (increment) mỗi lần /api/submit-exam chấm điểm thành
 *     công — xem đoạn code tương ứng ở endpoint đó.
 *   - shuffleQuestions: nếu examData bật cờ này, xáo thứ tự câu hỏi bằng
 *     seed cố định theo (examId + studentId).
 *
 * Query:  ?code=<roomCode>
 * Header: Authorization: Bearer <Firebase ID Token>
 */
app.get('/api/get-exam-questions', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid; // Từ token đã xác thực — KHÔNG tin bất kỳ studentId nào trên query string
        const roomCode = typeof req.query.code === 'string' ? req.query.code.trim() : '';

        if (!roomCode) {
            return res.status(400).json({ message: 'Thiếu mã phòng thi (code).' });
        }

        // 1 + 2. Tìm bài thi theo roomCode + xác nhận học sinh là thành viên active của lớp.
        const access = await loadExamForStudentByRoomCode(roomCode, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const { examId, examData } = access;

        // 3. Giới hạn số lần làm bài, nếu giáo viên có cấu hình maxAttempts > 0.
        const maxAttempts = Number(examData.maxAttempts) > 0 ? Number(examData.maxAttempts) : null;
        if (maxAttempts !== null) {
            const attemptSnap = await dbAdmin.collection('exam_attempts').doc(`${examId}_${studentId}`).get();
            const usedAttempts = attemptSnap.exists ? (Number(attemptSnap.data().count) || 0) : 0;

            if (usedAttempts >= maxAttempts) {
                return res.status(403).json({ message: 'Bạn đã hết số lần làm bài cho phép đối với bài kiểm tra này.' });
            }
        }

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        // 3b. (Phase 2 — Task 3) Ghi nhận / đọc lại mốc BẮT ĐẦU làm bài thật
        //     trên server — xem chi tiết đầy đủ ở getOrStartExamSession()
        //     phía trên. Đây là nguồn THẬT DUY NHẤT để đối chiếu thời gian
        //     lúc /api/submit-exam, không tin "timeUsed" client tự gửi.
        const startedAtMs = await getOrStartExamSession(examId, studentId, examData);

        // 4. Lấy nội dung câu hỏi thật (chia chunk 10, dùng chung fetchQuestionsByIds).
        let orderedQuestions = await fetchQuestionsByIds(questionIds);

        // 4b. Xáo thứ tự câu hỏi nếu giáo viên bật shuffleQuestions.
        if (examData.shuffleQuestions === true) {
            orderedQuestions = seededShuffle(orderedQuestions, `${examId}_${studentId}`);
        }

        // 5. SANITIZE — bước quan trọng nhất: xoá sạch mọi trường chứa đáp án
        //    đúng trước khi trả JSON (xem ghi chú đầy đủ ở bản POST bên dưới).
        //    ĐỒNG THỜI (Phase 2 — Task 3): đảm bảo trường "image" (link ảnh
        //    Cloudinary của câu hỏi, nếu có) LUÔN được trả xuống client —
        //    spread { ...q } vốn đã giữ nguyên "image", nhưng khai báo
        //    tường minh ở đây để không ai vô tình xoá nhầm field này khi
        //    sửa logic sanitize sau này (điểm dễ quên nhất mỗi khi thêm bớt
        //    field mới trong "questions").
        const sanitizedQuestions = orderedQuestions.map((q) => {
            const clean = { ...q };

            if (Array.isArray(clean.answers)) {
                clean.answers = clean.answers.map((ans) => {
                    if (!ans || typeof ans !== 'object') return ans;
                    const { correct, ...rest } = ans;
                    return rest;
                });
            }

            delete clean.correctAnswer;
            delete clean.essayAnswer;
            delete clean.explanation; // lời giải chỉ được lộ SAU khi nộp bài (xem /api/get-review-material)

            // Đảm bảo luôn có field "image" (chuỗi rỗng nếu câu hỏi không có
            // ảnh) để Frontend (lam_bai.js) không cần tự kiểm tra undefined.
            clean.image = typeof q.image === 'string' ? q.image : '';

            return clean;
        });

        return res.json({
            examId,
            title: examData.quizName || examData.title || '',
            duration: examData.duration || 15,
            allowSkip: examData.allowSkip !== false,
            allowFlagForReview: examData.allowFlagForReview === true,
            // Trả kèm mốc bắt đầu THẬT (ms) — không bắt buộc lam_bai.js phải
            // dùng giá trị này (client vẫn tự tính endTimeTimestamp để hiển
            // thị đồng hồ mượt), nhưng hữu ích nếu sau này cần debug lệch
            // giờ giữa client/server.
            startedAt: startedAtMs,
            questions: sanitizedQuestions
        });
    } catch (error) {
        console.error('Lỗi lấy câu hỏi theo mã phòng:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
    }
});

/**
 * Xoá mọi trường chứa đáp án đúng khỏi 1 câu hỏi trước khi gửi xuống client
 * (cùng logic với bước SANITIZE của GET /api/get-exam-questions ở trên).
 */
function sanitizeQuestionForClient(q) {
    const clean = { ...q };

    if (Array.isArray(clean.answers)) {
        clean.answers = clean.answers.map((ans) => {
            if (!ans || typeof ans !== 'object') return ans;
            const { correct, ...rest } = ans;
            return rest;
        });
    }

    delete clean.correctAnswer;
    delete clean.essayAnswer;
    delete clean.explanation;
    clean.image = typeof q.image === 'string' ? q.image : '';

    return clean;
}

/**
 * --- API THI THỬ của giáo viên (GET) ---
 * Dùng cho nút [Thi thử]: lam_bai.html?exam_id=<id>&preview=1
 *
 * Khác /api/get-exam-questions (dành cho học sinh):
 *   - Tra theo exam_id, KHÔNG cần roomCode, KHÔNG yêu cầu status == 'active'
 *     (giáo viên thi thử được cả bài nháp).
 *   - KHÔNG kiểm tra thành viên lớp; thay vào đó bắt buộc
 *     examData.teacher_id === uid trong token -> chỉ chủ bài thi mới xem được.
 *   - KHÔNG ghi "exam_sessions" / "exam_attempts" / "results": thi thử không
 *     để lại dấu vết nào trong dữ liệu học sinh.
 *   - Câu hỏi vẫn được sanitize (không lộ đáp án) để trải nghiệm giống học sinh.
 */
app.get('/api/preview-exam', verifyFirebaseToken, async (req, res) => {
    try {
        const examId = typeof req.query.exam_id === 'string' ? req.query.exam_id.trim() : '';
        if (!examId) {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }

        const examSnap = await dbAdmin.collection('exams').doc(examId).get();
        if (!examSnap.exists) {
            return res.status(404).json({ message: 'Không tìm thấy bài kiểm tra.' });
        }
        const examData = examSnap.data();

        if (examData.teacher_id !== req.uid) {
            return res.status(403).json({ message: 'Chỉ giáo viên tạo bài kiểm tra này mới được thi thử.' });
        }

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        let orderedQuestions = await fetchQuestionsByIds(questionIds);
        if (examData.shuffleQuestions === true) {
            orderedQuestions = seededShuffle(orderedQuestions, `${examId}_${req.uid}`);
        }

        return res.json({
            examId,
            preview: true,
            title: examData.quizName || examData.title || '',
            subject: examData.subject || '',
            duration: examData.duration || 15,
            allowSkip: examData.allowSkip !== false,
            allowFlagForReview: examData.allowFlagForReview === true,
            questions: orderedQuestions.map(sanitizeQuestionForClient)
        });
    } catch (error) {
        console.error('Lỗi thi thử bài kiểm tra:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải bài thi thử.' });
    }
});

// --- API Xử lý Bóc tách tài liệu (PDF/Word/Forms) ---
//
// CHỐNG "BỊA" CÂU HỎI (hallucination) — 4 lớp:
//   1. System prompt: AI chỉ là công cụ TRÍCH XUẤT, cấm sáng tác, không có
//      câu hỏi thì trả [].
//   2. temperature: 0 + responseMimeType JSON: bớt "sáng tạo", output đúng cấu trúc.
//   3. Google Forms: Gemini KHÔNG mở được URL. Bản cũ chỉ đưa cho nó cái link
//      -> nó tự bịa câu hỏi cho có. Nay server tự tải form, đưa DỮ LIỆU THẬT
//      của form cho AI trích xuất.
//   4. Kiểm tra lại output: bỏ mọi câu hỏi sai cấu trúc trước khi trả về.
const EXTRACT_SYSTEM_PROMPT = `Bạn LÀ công cụ trích xuất dữ liệu, KHÔNG phải người soạn đề.
Nhiệm vụ: CHỈ ĐƯỢC trích xuất những câu hỏi CÓ SẴN trong tài liệu được cung cấp.

QUY TẮC BẮT BUỘC:
1. TUYỆT ĐỐI KHÔNG tự sáng tác, suy luận hay thêm bớt câu hỏi, đáp án hoặc lời giải. Không viết thêm câu hỏi cho "đủ số lượng", không dùng kiến thức bên ngoài tài liệu.
2. Nếu tài liệu không chứa câu hỏi nào (trắc nghiệm, đúng/sai hoặc tự luận), trả về mảng rỗng [].
3. Giữ nguyên văn câu hỏi và từng đáp án như trong tài liệu. Không diễn đạt lại, không sửa số liệu.
4. Đáp án đúng: CHỈ đặt "correct": true khi tài liệu CHỈ RÕ đáp án đúng (đáp án cuối bài, in đậm, gạch chân, dấu đánh dấu). Nếu tài liệu không chỉ rõ, đặt "correct": false cho TẤT CẢ đáp án. TUYỆT ĐỐI KHÔNG tự giải bài để chọn đáp án đúng.
5. "explanation": chỉ lấy lời giải CÓ SẴN trong tài liệu; không có thì để chuỗi rỗng "".
6. "subject" và "grade": chỉ điền khi tài liệu ghi rõ; không có thì để chuỗi rỗng "". "difficulty": nếu tài liệu không ghi thì dùng "medium".
7. Công thức toán giữ ở dạng LaTeX: dùng \\( ... \\) cho công thức trong dòng và $$ ... $$ cho công thức riêng dòng.

Trả về MỘT MẢNG JSON duy nhất theo đúng định dạng:
[
  {
    "question": "Nội dung câu hỏi",
    "type": "multiple_choice" | "essay" | "true_false",
    "subject": "Tên môn học (chuỗi rỗng nếu tài liệu không ghi)",
    "grade": "Khối lớp (chuỗi rỗng nếu tài liệu không ghi)",
    "difficulty": "easy" | "medium" | "hard",
    "score": 1,
    "answers": [{"text": "Đáp án A", "correct": false}, {"text": "Đáp án B", "correct": false}] (Dùng cho trắc nghiệm),
    "essayAnswer": "Đáp án tự luận mẫu CÓ SẴN trong tài liệu (nếu có)" (Dùng cho tự luận),
    "explanation": "Lời giải có sẵn trong tài liệu (chuỗi rỗng nếu không có)"
  }
]
CHỈ TRẢ VỀ CHUỖI JSON, KHÔNG BỌC TRONG MARKDOWN VÀ KHÔNG THÊM VĂN BẢN NÀO NGOÀI MẢNG JSON.`;

const EXTRACT_VALID_TYPES = ['multiple_choice', 'essay', 'true_false'];

/** Bỏ mọi phần tử không đúng cấu trúc (thiếu nội dung, sai type, trắc nghiệm thiếu đáp án). */
function sanitizeExtractedQuestions(raw) {
    if (!Array.isArray(raw)) return [];

    return raw.filter((q) => {
        if (!q || typeof q.question !== 'string' || q.question.trim() === '') return false;
        if (!EXTRACT_VALID_TYPES.includes(q.type)) return false;

        if (q.type === 'multiple_choice') {
            return Array.isArray(q.answers)
                && q.answers.length >= 2
                && q.answers.every((a) => a && typeof a.text === 'string' && a.text.trim() !== '');
        }
        return true;
    });
}

/**
 * Tải dữ liệu THẬT của 1 Google Form công khai (biến FB_PUBLIC_LOAD_DATA_ nhúng
 * trong trang viewform). Chỉ cho phép docs.google.com/forms và forms.gle để
 * tránh bị lợi dụng làm proxy gọi URL bất kỳ (SSRF). Cần Node 18+ (fetch có sẵn).
 * Lưu ý: trang công khai của Google Forms KHÔNG chứa đáp án đúng.
 */
async function fetchGoogleFormsData(formsUrl) {
    let url;
    try {
        url = new URL(formsUrl);
    } catch (e) {
        throw new Error('Link Google Forms không hợp lệ.');
    }

    const isAllowedHost =
        (url.hostname === 'docs.google.com' && url.pathname.startsWith('/forms/')) ||
        url.hostname === 'forms.gle';
    if (url.protocol !== 'https:' || !isAllowedHost) {
        throw new Error('Link Google Forms không hợp lệ.');
    }

    const response = await fetch(url.href, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error('Không mở được Google Forms. Hãy đặt form ở chế độ "Bất kỳ ai có đường liên kết".');
    }

    const html = await response.text();
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*<\/script>/);
    if (!match) {
        throw new Error('Không đọc được nội dung form (form yêu cầu đăng nhập hoặc không công khai).');
    }

    return match[1].slice(0, 200000);
}

app.post('/api/extract-questions', async (req, res) => {
    try {
        const { source, mimeType, fileBase64, formsUrl } = req.body;
        console.log("Đã nhận yêu cầu xử lý từ frontend:", source);

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash-lite",
            systemInstruction: EXTRACT_SYSTEM_PROMPT,
            generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        });

        let requestContent;

        if (source === 'file' && fileBase64) {
            requestContent = [
                "Trích xuất các câu hỏi CÓ SẴN trong tài liệu đính kèm. Nếu không có câu hỏi nào, trả về [].",
                {
                    inlineData: {
                        data: fileBase64,
                        mimeType: mimeType || "application/pdf"
                    }
                }
            ];
        } else if (source === 'google-forms' && formsUrl) {
            let formsData;
            try {
                formsData = await fetchGoogleFormsData(formsUrl);
            } catch (formsError) {
                return res.status(422).json({ message: formsError.message });
            }
            requestContent = [
                "Dưới đây là dữ liệu thô (JSON) của một Google Form. CHỈ trích xuất các câu hỏi và lựa chọn có trong dữ liệu này. " +
                "Google Forms không chứa đáp án đúng nên đặt \"correct\": false cho tất cả đáp án. Nếu không có câu hỏi nào, trả về [].\n\n" +
                formsData
            ];
        } else {
            return res.status(400).json({ message: "Thiếu dữ liệu đầu vào (file hoặc link)." });
        }

        const result = await model.generateContent(requestContent);
        const text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (parseError) {
            console.error("AI trả về JSON không hợp lệ:", text.slice(0, 300));
            return res.status(422).json({ message: "AI trả về dữ liệu không hợp lệ. Vui lòng thử lại." });
        }

        // Chấp nhận cả mảng thuần lẫn { questions: [...] }, rồi lọc lại cho chắc.
        const rawList = Array.isArray(parsed) ? parsed : parsed && parsed.questions;

        // Trả về đúng định dạng { questions: [...] } mà Frontend yêu cầu
        res.json({ questions: sanitizeExtractedQuestions(rawList) });

    } catch (error) {
        console.error("Lỗi bóc tách tài liệu:", error);
        res.status(500).json({ message: "Lỗi server khi bóc tách tài liệu." });
    }
});

// --- API Xử lý biên dịch Toán học ---
app.post('/api/compile-math', async (req, res) => {
    try {
        const { input } = req.body;
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Đồng bộ model 3.5 Flash Lite cho phần Toán học
        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash-lite",
            systemInstruction: "Bạn là bộ chuyển đổi công thức Toán học sang mã LaTeX. CHỈ TRẢ VỀ JSON THUẦN TÚY với cấu trúc: {\"ok\": true, \"type\": \"math\"|\"chemistry\", \"latex\": \"mã_latex\"}. KHÔNG bọc trong markdown hay ký hiệu $ hay $$. TUYỆT ĐỐI không chào hỏi hay giải thích."
        });
        const result = await model.generateContent(input);
        let text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (error) {
        console.error("Lỗi biên dịch Toán:", error);
        res.status(500).json({ ok: false, error: "Lỗi server khi biên dịch toán." });
    }
});

/**
 * --- API Nộp bài & Chấm điểm (chạy trên server, học sinh không can thiệp được) ---
 *
 * Payload từ client (hocsinh.js):
 *   {
 *     exam_id: string,
 *     answers: { [questionId: string]: number },  // optionIndex học sinh chọn
 *     timeUsed: number,   // giây
 *     cheatWarnings?: number,
 *     cheatLogs?: any[]
 *   }
 *
 * Header bắt buộc: Authorization: Bearer <Firebase ID Token>
 */
app.post('/api/submit-exam', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid; // Lấy từ token đã xác thực, KHÔNG lấy từ body
        const {
            exam_id, answers, timeUsed, cheatWarnings, cheatLogs,
            // Denormalize (mục 1.3 báo cáo): các field hiển thị hocsinh.js gửi kèm
            // lúc nộp bài để ghi thẳng vào "results", tránh bảng điểm ketqua.js
            // phải join thêm collection khác (đặc biệt "className" — examData
            // hiện chỉ có class_id chứ không có tên lớp, nên đây là NGUỒN DUY
            // NHẤT có className). studentName/quizName/subject vẫn ưu tiên giá
            // trị lấy từ hồ sơ/exam thật ở server (xem bước 5 & 6 bên dưới) —
            // giá trị client gửi chỉ dùng làm dự phòng khi server không có sẵn.
            studentName: clientStudentName,
            className,
            quizName: clientQuizName,
            subject: clientSubject
        } = req.body;

        if (!exam_id || typeof exam_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }
        const safeAnswers = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};

        // 1 + 2. Lấy bài kiểm tra thật + xác nhận học sinh là thành viên active
        //         của lớp sở hữu bài này (không tin dữ liệu exam client gửi kèm).
        const access = await loadExamForStudent(exam_id, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const examData = access.examData;

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        // 2b. (Phase 2 — Task 3) CHỐNG GIAN LẬN THỜI GIAN — không tin tưởng
        // tuyệt đối "timeUsed" do client tự tính rồi gửi lên nữa. Đối chiếu
        // với "startedAt" đã ghi nhận THẬT trên server lúc học sinh gọi GET
        // /api/get-exam-questions (xem getOrStartExamSession() phía trên).
        //
        //   - Không có session (học sinh gọi thẳng /api/submit-exam mà chưa
        //     từng gọi get-exam-questions cho đúng bài này) -> KHÔNG có căn
        //     cứ nào để tin đây là 1 lượt làm bài hợp lệ -> từ chối luôn.
        //   - Có session -> tính serverElapsedSeconds = (thời điểm nộp) -
        //     (thời điểm bắt đầu THẬT). So với thời lượng cấu hình
        //     (examData.duration, phút) CỘNG THÊM dung sai 2 phút (network
        //     lag, độ trễ gọi API...). Nếu bài KHÔNG giới hạn thời gian
        //     (examData.unlimitedTime === true) thì bỏ qua bước so sánh này.
        //   - Vượt quá dung sai -> KHÔNG chặn đứng việc nộp bài (học sinh có
        //     thể đã làm xong thật, chỉ là mạng chậm/máy đơ) nhưng ĐÁNH DẤU
        //     bài nộp là "nộp trễ / đáng ngờ" (lateSubmission = true) thay
        //     vì âm thầm tin timeUsed do client gửi — giáo viên xem kết quả
        //     sẽ thấy rõ cờ này để tự quyết định có huỷ bài hay không.
        //   - timeUsedSeconds LƯU VÀO "results" LUÔN LÀ GIÁ TRỊ SERVER TỰ
        //     TÍNH (serverElapsedSeconds), KHÔNG dùng "timeUsed" client gửi
        //     làm nguồn chính nữa — giá trị client gửi chỉ lưu kèm riêng để
        //     đối chiếu/debug (xem payload.clientReportedTimeUsedSeconds).
        const sessionSnap = await dbAdmin.collection('exam_sessions').doc(`${exam_id}_${studentId}`).get();
        if (!sessionSnap.exists || typeof sessionSnap.data().startedAtMs !== 'number') {
            return res.status(400).json({
                message: 'Không tìm thấy phiên làm bài hợp lệ. Vui lòng vào lại phòng thi từ đầu.'
            });
        }
        const sessionData = sessionSnap.data();
        const startedAtMs = sessionData.startedAtMs;
        const serverElapsedSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

        const isUnlimitedTime = examData.unlimitedTime === true;
        const allowedDurationSeconds = (Number(examData.duration) > 0 ? Number(examData.duration) : 15) * 60;
        const TOLERANCE_SECONDS = 120; // dung sai 2 phút do độ trễ mạng
        const isLateSubmission = !isUnlimitedTime && serverElapsedSeconds > (allowedDurationSeconds + TOLERANCE_SECONDS);

        if (isLateSubmission) {
            console.warn(`Nộp bài trễ hơn dung sai cho phép: exam=${exam_id}, student=${studentId}, serverElapsedSeconds=${serverElapsedSeconds}, allowedDurationSeconds=${allowedDurationSeconds}`);
        }

        // 3. Lấy nội dung câu hỏi thật (chia chunk 10 vì toán tử "in" giới hạn 10-30
        //    phần tử tuỳ phiên bản; giữ 10 cho an toàn, khớp cách hocsinh.js đang làm)
        const questions = await fetchQuestionsByIds(questionIds);

        // 4. CHẤM ĐIỂM THẬT — đây là phần học sinh không thể giả mạo được nữa vì
        //    toàn bộ logic này chạy trên server, dùng đáp án đúng lấy trực tiếp
        //    từ Firestore chứ không phải dữ liệu client gửi lên.
        //    Cộng điểm theo field "score" của từng câu (nếu có) thay vì chia đều:
        //    câu nào không có "score" thì mặc định coi là 1 điểm.
        let correctCount = 0;
        let earnedPoints = 0;
        let totalPoints = 0;
        // Mảng đối chiếu ĐẦY ĐỦ — LUÔN được lưu full vào "results" bất kể cờ
        // hiển thị của giáo viên, để dùng cho giáo viên xem/chấm và cho học
        // sinh "Xem lại" sau này qua /api/get-result-detail. Việc ẩn bớt field
        // theo showCorrectAnswers/showExplanation CHỈ áp dụng lên response trả
        // về ngay lúc nộp bài (xem bước 7 bên dưới), không áp lên dữ liệu lưu.
        const details = [];
        // GIAI ĐOẠN 4.3: các câu Tự luận / Upload file KHÔNG tự chấm được -> gom vào
        // manualItems để giáo viên chấm ở SpeedGrader (quan-ly-ket-qua).
        const manualItems = [];

        questions.forEach((q) => {
            if (isManualQuestionServer(q)) {
                manualItems.push({
                    questionId: q.id,
                    type: q.type,
                    questionText: q.question || q.text || '',
                    points: Number(q.score) > 0 ? Number(q.score) : 1,
                    ...extractManualAnswerServer(q, safeAnswers[q.id])
                });
                return;
            }

            const points = Number(q.score) > 0 ? Number(q.score) : 1;
            totalPoints += points;

            const correctIndex = getCorrectIndexServer(q);
            const studentAnswer = safeAnswers[q.id];
            const isCorrect = correctIndex !== -1 && studentAnswer === correctIndex;

            if (isCorrect) {
                correctCount += 1;
                earnedPoints += points;
            }

            details.push({
                questionId: q.id,
                studentAnswer: typeof studentAnswer === 'number' ? studentAnswer : null,
                correctAnswer: correctIndex,
                isCorrect,
                points,
                explanation: typeof q.explanation === 'string' ? q.explanation : ''
            });
        });

        const totalQuestions = questions.length;
        // GIAI ĐOẠN 4.3: có câu chấm tay -> CHƯA có điểm chính thức (score = null,
        // gradingStatus = 'pending') cho tới khi giáo viên chấm qua /api/grade-result.
        // autoScore chỉ là điểm riêng của phần trắc nghiệm, để giáo viên tham khảo.
        const hasManualItems = manualItems.length > 0;
        const gradingStatus = hasManualItems ? 'pending' : 'graded';
        const autoScore = totalPoints > 0 ? Number(((earnedPoints / totalPoints) * 10).toFixed(1)) : null;
        const score = hasManualItems ? null : (autoScore !== null ? autoScore : 0);

        // 5. Lấy tên học sinh thật từ hồ sơ (không tin studentName client tự gửi
        //    làm nguồn CHÍNH — chỉ dùng làm dự phòng nếu hồ sơ không có tên).
        let studentName = 'Học sinh';
        try {
            const userSnap = await dbAdmin.collection('users').doc(studentId).get();
            if (userSnap.exists) {
                const u = userSnap.data();
                studentName = u.fullname || u.displayName || studentName;
            }
        } catch (nameErr) {
            console.error('Không lấy được tên học sinh (không chặn việc chấm điểm):', nameErr.message);
        }
        if (studentName === 'Học sinh' && typeof clientStudentName === 'string' && clientStudentName.trim()) {
            studentName = clientStudentName.trim();
        }

        // 5b. Tên lớp thật từ collection "classes" (xem loadClassNameById()).
        const serverClassName = await loadClassNameById(examData.class_id);

        // 6. Ghi kết quả bằng Admin SDK — bypass Firestore Rules hoàn toàn,
        //    nên rule results.create/update phía client có bị khoá (if false)
        //    cũng không ảnh hưởng gì tới việc ghi này.
        const payload = {
            teacher_id: examData.teacher_id || '',
            exam_id,
            student_id: studentId,
            studentName,
            class_id: examData.class_id || '',
            // BƯỚC 3.4 — DENORMALIZE SỔ ĐIỂM: chép thẳng từ exam (nguồn thật ở server,
            // KHÔNG lấy từ req.body) vào "results" để bảng Sổ điểm ở quan-ly-lop.js
            // gom điểm theo cột chỉ với 1 query trên "results", không phải join "exams".
            // Exam cũ (tạo trước bước 3.2) chưa có 2 field này -> ghi '' và Sổ điểm sẽ bỏ qua.
            gradebookColumnId: examData.gradebookColumnId || '',
            gradebookColumnName: examData.gradebookColumnName || '',
            // Bài đã nộp và được chấm xong. Sổ điểm CHỈ tính các bài có status này.
            // GIAI ĐOẠN 4.3: bài còn phần chấm tay để 'pending_grading' -> Sổ điểm tự bỏ qua
            // (không bị tính 0 điểm) cho tới khi giáo viên chấm xong, lúc đó
            // /api/grade-result chuyển lại thành 'submitted'.
            status: hasManualItems ? 'pending_grading' : 'submitted',
            // className: ưu tiên tên lớp THẬT tra từ "classes" (serverClassName). Giá trị
            // client gửi kèm chỉ là dự phòng khi không tra được (field hiển thị, không ảnh hưởng điểm số).
            className: serverClassName
                || ((typeof className === 'string' && className.trim()) ? className.trim() : 'Không xác định'),
            subject: examData.subject || (typeof clientSubject === 'string' ? clientSubject : ''),
            // FIX kèm theo: exam dùng field "quizName" (không phải "title") —
            // xem mục 1.1 báo cáo. Đọc đúng field thật để không ghi results rỗng.
            quizName: examData.quizName || examData.title || (typeof clientQuizName === 'string' ? clientQuizName : ''),
            score,
            // --- GIAI ĐOẠN 4.3: chấm bài thủ công ---
            gradingStatus,                                   // 'pending' | 'graded'
            autoScore: hasManualItems ? autoScore : null,    // điểm riêng phần trắc nghiệm (tham khảo)
            manualItems,                                     // [{ questionId, type, questionText, points, essayAnswer | fileUrl }]
            teacherFeedback: '',                             // làm lại bài -> xoá lời phê của lượt trước
            correctCount,
            totalQuestions,
            // FIX (mục 1.4 báo cáo): trước đây KHÔNG lưu đáp án học sinh đã
            // chọn vào "results", nên màn "Xem lại" không có gì để tô đỏ đáp
            // án sai. answers vẫn là safeAnswers đã chấm điểm thật ở bước 4
            // (không tin dữ liệu client gửi thêm sau khi đã dùng để chấm).
            answers: safeAnswers,
            details,
            cheatWarnings: Number(cheatWarnings) || 0,
            cheatLogs: Array.isArray(cheatLogs) ? cheatLogs : [],
            // (Phase 2 — Task 3) Nguồn SỰ THẬT DUY NHẤT cho thời gian làm
            // bài giờ là serverElapsedSeconds (tính từ startedAt ghi nhận
            // trên server), không còn dùng thẳng "timeUsed" client gửi lên
            // nữa. clientReportedTimeUsedSeconds vẫn giữ lại để đối chiếu/
            // debug khi cần điều tra chênh lệch bất thường.
            timeUsedSeconds: serverElapsedSeconds,
            clientReportedTimeUsedSeconds: Number(timeUsed) || 0,
            lateSubmission: isLateSubmission,
            submitTime: FieldValue.serverTimestamp()
        };

        const resultRef = dbAdmin.collection('results').doc(`${exam_id}_${studentId}`);
        // GIAI ĐOẠN 4.3: nộp lại -> lưu bản cũ (điểm + lời phê) vào results/{id}/attempts
        // rồi mới ghi đè. set() KHÔNG merge nên điểm/lời phê/gradedAt cũ bị xoá sạch,
        // bài mới luôn bắt đầu từ trạng thái pending (nếu có câu chấm tay).
        await archivePreviousResultAttempt(resultRef);
        await resultRef.set(payload);

        // (Phase 2 — Task 3) Dọn session sau khi đã chấm điểm xong — lượt
        // thi này coi như đã kết thúc; nếu maxAttempts cho phép làm lại,
        // lần GET /api/get-exam-questions tiếp theo sẽ tạo session MỚI với
        // startedAt MỚI (đúng ý nghĩa "bắt đầu lại từ đầu"), không bị dính
        // startedAt của lượt cũ khiến lượt mới bị tính nộp trễ ngay lập tức.
        await dbAdmin.collection('exam_sessions').doc(`${exam_id}_${studentId}`).delete().catch((cleanupErr) => {
            console.error('Không xoá được exam_sessions sau khi nộp bài (không chặn kết quả đã lưu):', cleanupErr.message);
        });

        // Cộng dồn số lần đã làm bài — dùng cho maxAttempts ở GET
        // /api/get-exam-questions (theo roomCode). Tách riêng khỏi "results"
        // vì "results" bị ghi đè theo doc id cố định "{examId}_{studentId}"
        // nên không đếm được số lần làm thật nếu học sinh nộp lại nhiều lần.
        await dbAdmin.collection('exam_attempts').doc(`${exam_id}_${studentId}`).set({
            examId: exam_id,
            studentId,
            count: FieldValue.increment(1),
            lastSubmittedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        // 7. Trả JSON về client — CHỈ lộ Điểm/Đáp án đúng/Lời giải nếu giáo
        //    viên đã bật cờ tương ứng trong examData. Dữ liệu đầy đủ (details ở
        //    trên) vẫn luôn được lưu full vào "results" bất kể cờ này; ở đây chỉ
        //    lọc bớt những gì gửi ra NGOÀI ngay lúc nộp bài.
        const responsePayload = { ok: true, gradingStatus };

        if (examData.showScoreImmediately === true) {
            // score = null khi bài đang chờ chấm -> Frontend phải hiện "Chờ chấm", không toFixed().
            responsePayload.score = score;
            responsePayload.correctCount = correctCount;
            responsePayload.totalQuestions = totalQuestions;
        }

        if (examData.showCorrectAnswers === true || examData.showExplanation === true) {
            responsePayload.details = details.map((item) => {
                const filtered = {
                    questionId: item.questionId,
                    studentAnswer: item.studentAnswer,
                    isCorrect: item.isCorrect
                };
                if (examData.showCorrectAnswers === true) {
                    filtered.correctAnswer = item.correctAnswer;
                }
                if (examData.showExplanation === true) {
                    filtered.explanation = item.explanation;
                }
                return filtered;
            });
        }

        // 8. Cờ hiển thị nút "Tải file ôn tập" ở màn kết quả. Kiểm tra lại
        //    bằng CHÍNH hàm mà /api/get-review-material dùng (checkReviewDownloadAccess)
        //    để nút hiện <=> tải được. Lỗi ở bước này KHÔNG được làm hỏng việc
        //    nộp bài (điểm đã ghi xong ở trên) -> bọc try/catch riêng.
        try {
            const reviewAccess = await checkReviewDownloadAccess(exam_id, examData, studentId);
            responsePayload.allowDownloadReview = reviewAccess.ok;
            if (!reviewAccess.ok && reviewAccess.locked) {
                responsePayload.downloadReviewNote = reviewAccess.message;
            }
        } catch (reviewErr) {
            console.error('Không kiểm tra được quyền tải file ôn tập (không chặn việc nộp bài):', reviewErr.message);
            responsePayload.allowDownloadReview = false;
        }

        return res.json(responsePayload);
    } catch (error) {
        console.error('Lỗi chấm điểm / nộp bài:', error);
        return res.status(500).json({ message: 'Lỗi server khi nộp bài. Vui lòng thử lại.' });
    }
});

/**
 * --- API Lấy câu hỏi cho học sinh làm bài (ĐÃ SANITIZE ĐÁP ÁN ĐÚNG) ---
 *
 * FIX BẢO MẬT (mục 0.2 báo cáo): trước đây hocsinh.js đọc thẳng collection
 * "questions" qua Firestore SDK (rule "allow read: if signedIn();"), nghĩa
 * là bất kỳ học sinh nào mở DevTools cũng lấy được TOÀN BỘ đáp án đúng của
 * TOÀN BỘ ngân hàng câu hỏi (không chỉ bài đang thi), vì Firestore Rules
 * không thể lọc field trong response — chỉ chặn được toàn bộ document hoặc
 * không gì cả.
 *
 * Từ giờ: học sinh KHÔNG còn quyền đọc "questions" trực tiếp (xem
 * firestore.rules mục 5 đã khoá lại "chỉ giáo viên sở hữu"). Mọi câu hỏi
 * học sinh cần để làm bài phải đi qua endpoint này — nơi Backend (Admin
 * SDK, bypass Rules) chủ động XOÁ SẠCH mọi trường chứa đáp án đúng trước
 * khi trả JSON, nên kể cả bắt được response qua tab Network cũng không
 * thấy đáp án đúng nằm ở đâu.
 *
 * Payload: { exam_id: string }
 * Header:  Authorization: Bearer <Firebase ID Token>
 */
app.post('/api/get-exam-questions', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid; // từ token đã xác thực, không tin body
        const { exam_id } = req.body;

        if (!exam_id || typeof exam_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }

        // 1 + 2. Lấy bài kiểm tra thật + xác nhận học sinh là thành viên active
        //         của lớp sở hữu bài này (dùng chung logic với /api/submit-exam).
        const access = await loadExamForStudent(exam_id, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const examData = access.examData;

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        // 3. Lấy nội dung câu hỏi thật (chia chunk 10, giống /api/submit-exam)
        const orderedQuestions = await fetchQuestionsByIds(questionIds);

        // 4. SANITIZE — bước quan trọng nhất. Bỏ sót 1 trường ở đây là lỗ
        //    hổng 0.2 coi như vẫn còn nguyên, chỉ đổi chỗ rò rỉ.
        const sanitizedQuestions = orderedQuestions.map((q) => {
            const clean = { ...q };

            if (Array.isArray(clean.answers)) {
                clean.answers = clean.answers.map((ans) => {
                    if (!ans || typeof ans !== 'object') return ans;
                    const { correct, ...rest } = ans; // bỏ field "correct"
                    return rest;
                });
            }

            delete clean.correctAnswer; // schema cũ (options[] + correctAnswer)
            delete clean.essayAnswer;   // đáp án mẫu tự luận
            delete clean.explanation;   // lời giải chỉ lộ sau khi nộp bài

            return clean;
        });

        return res.json({ questions: sanitizedQuestions });
    } catch (error) {
        console.error('Lỗi lấy câu hỏi cho học sinh:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
    }
});

/**
 * --- API Lấy chi tiết bài làm để học sinh "Xem lại" (mục 1.4 báo cáo) ---
 *
 * Học sinh không còn quyền đọc "questions" trực tiếp (đã khoá ở
 * firestore.rules mục 5), nên không thể tự ghép câu hỏi + đáp án đúng +
 * đáp án đã chọn để hiển thị màn xem lại. Backend (Admin SDK, bypass Rules)
 * đọc cả "results" lẫn "questions" rồi ghép sẵn thành báo cáo hoàn chỉnh.
 *
 * FIX (mục 1.4 báo cáo — bản trước LUÔN trả full đáp án đúng + giải thích,
 * BỎ QUA hoàn toàn 3 cờ cấu hình của giáo viên trong "exams". Nghĩa là dù
 * giáo viên tắt showScoreImmediately/showCorrectAnswers/showExplanation,
 * học sinh vẫn có thể tự gọi thẳng endpoint này qua DevTools để xem trước
 * đáp án đúng và lời giải — cùng một lỗ hổng "0.2" đã vá cho lúc làm bài,
 * chỉ là lộ ra ở một endpoint khác). Giờ áp dụng ĐÚNG 3 cờ, theo thứ tự
 * lồng nhau (khớp yêu cầu Task 1.4):
 *
 *   showScoreImmediately == false
 *     -> KHÔNG trả score/correctCount/skippedCount/totalQuestions, và
 *        KHÔNG trả câu hỏi/đáp án gì cả (kể cả khi 2 cờ dưới đang bật).
 *   showScoreImmediately == true
 *     -> trả điểm số + số câu đúng/sai/bỏ qua.
 *     showCorrectAnswers == true
 *       -> trả thêm danh sách câu hỏi kèm đáp án học sinh đã chọn +
 *          đáp án đúng thực sự (để Frontend tô Xanh/Đỏ).
 *       showExplanation == true
 *         -> mỗi câu có thêm trả về "Lời giải chi tiết".
 *
 * Nếu muốn 3 cờ độc lập với nhau (không lồng), bỏ phần "&&
 * showScoreImmediately"/"&& showCorrectAnswers" ở 2 dòng tính cờ bên dưới.
 *
 * Payload: { result_id: string }   // chính là "{exam_id}_{student_id}"
 * Header:  Authorization: Bearer <Firebase ID Token>
 */
app.post('/api/get-result-detail', verifyFirebaseToken, async (req, res) => {
    try {
        const { result_id } = req.body;
        if (!result_id || typeof result_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu result_id.' });
        }

        // 1 + 2. Đọc document "results/{result_id}" bằng Admin SDK.
        const resultSnap = await dbAdmin.collection('results').doc(result_id).get();
        if (!resultSnap.exists) {
            return res.status(404).json({ message: 'Không tìm thấy bài làm.' });
        }
        const resultData = resultSnap.data();

        // 3. Bảo mật: chỉ chính học sinh đã làm bài này mới được xem lại —
        //    chặn học sinh tự sửa result_id trên DevTools để xem đáp án của
        //    người khác. So sánh với uid THẬT từ token, không tin body.
        if (resultData.student_id !== req.uid) {
            return res.status(403).json({ message: 'Bạn không có quyền xem bài làm của người khác.' });
        }

        // 4. Lấy cờ cấu hình hiển thị từ "exams" — nguồn DUY NHẤT quyết định
        //    học sinh được xem gì. Exam bị xoá / thiếu field -> coi như tắt
        //    hết (an toàn hơn là mặc định lộ đáp án).
        const examSnap = await dbAdmin.collection('exams').doc(resultData.exam_id).get();
        const examData = examSnap.exists ? examSnap.data() : {};

        const scoreVisible = examData.showScoreImmediately === true;
        const questionsVisible = scoreVisible && examData.showCorrectAnswers === true;
        const explanationVisible = questionsVisible && examData.showExplanation === true;

        // 5. "details" ĐẦY ĐỦ đã được /api/submit-exam lưu sẵn vào "results"
        //    bất kể cờ hiển thị (xem ghi chú ở đó) — dùng lại để tính số câu
        //    đúng/sai/bỏ qua, KHÔNG cần chấm lại.
        const fullDetails = Array.isArray(resultData.details) ? resultData.details : [];
        const totalQuestions = Number(resultData.totalQuestions) || fullDetails.length;
        const correctCount = Number(resultData.correctCount) || 0;
        const skippedCount = fullDetails.filter(
            (d) => d.studentAnswer === null || d.studentAnswer === undefined
        ).length;
        // GIAI ĐOẠN 4.3: câu Tự luận / Upload không nằm trong details nên không được tính là "sai".
        const manualCount = Array.isArray(resultData.manualItems) ? resultData.manualItems.length : 0;
        const incorrectCount = Math.max(0, totalQuestions - manualCount - correctCount - skippedCount);

        const responsePayload = {
            ok: true,
            studentName: resultData.studentName || '',
            quizName: resultData.quizName || '',
            className: resultData.className || '',
            subject: resultData.subject || '',
            submitTime: (resultData.submitTime && typeof resultData.submitTime.toDate === 'function')
                ? resultData.submitTime.toDate().toISOString()
                : null,
            scoreVisible,
            questionsVisible,
            explanationVisible,
            // GIAI ĐOẠN 4.3: 'pending' = còn phần chờ giáo viên chấm (score có thể là null)
            gradingStatus: resultData.gradingStatus || 'graded'
        };

        if (scoreVisible) {
            responsePayload.score = (resultData.score === undefined) ? null : resultData.score;
            if (typeof resultData.teacherFeedback === 'string' && resultData.teacherFeedback.trim() !== '') {
                responsePayload.teacherFeedback = resultData.teacherFeedback;
            }
            responsePayload.correctCount = correctCount;
            responsePayload.incorrectCount = incorrectCount;
            responsePayload.skippedCount = skippedCount;
            responsePayload.totalQuestions = totalQuestions;
        }

        if (questionsVisible) {
            // Chỉ khi được phép xem đáp án mới cần chọc vào "questions" lấy
            // text + các phương án (details đã có sẵn correctAnswer/isCorrect
            // rồi, không cần tính lại bằng getCorrectIndexServer).
            const questionIds = fullDetails.map((d) => d.questionId).filter(Boolean);
            const questions = await fetchQuestionsByIds(questionIds);
            const questionMap = {};
            questions.forEach((q) => { questionMap[q.id] = q; });

            responsePayload.questions = fullDetails.map((d) => {
                const q = questionMap[d.questionId] || {};
                const item = {
                    id: d.questionId,
                    text: q.question || q.text || '',
                    options: getOptionTextsServer(q),
                    studentAnswer: typeof d.studentAnswer === 'number' ? d.studentAnswer : null,
                    correctAnswer: typeof d.correctAnswer === 'number' ? d.correctAnswer : -1,
                    isCorrect: d.isCorrect === true
                };
                if (explanationVisible) {
                    item.explanation = typeof d.explanation === 'string' ? d.explanation : '';
                }
                return item;
            });
        }

        // 6. Trả báo cáo đã lọc sẵn theo cờ — Frontend chỉ việc render đúng
        //    những gì server gửi, không tự suy diễn/ước lượng thêm.
        return res.json(responsePayload);
    } catch (error) {
        console.error('Lỗi lấy chi tiết bài làm:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải chi tiết bài làm.' });
    }
});

// ===== GIAI ĐOẠN 4.3 (SpeedGrader) + 4.4 (Miễn thi) — BẮT ĐẦU: API GIÁO VIÊN CHẤM BÀI / MIỄN THI =====
/**
 * --- API Giáo viên chấm điểm bài Tự luận / Upload file, hoặc cho học sinh Miễn thi ---
 *
 * Client (quan-ly-ket-qua.js -> submitGrade) gửi:
 *   Header : Authorization: Bearer <Firebase ID token của GIÁO VIÊN>
 *   Body   : {
 *     result_id            : string        — id document trong collection "results" ("{exam_id}_{student_id}")
 *     score                : number|null   — điểm CUỐI CÙNG của cả bài (0 -> maxScore, mặc định 10); null khi miễn thi
 *     isExcused            : boolean       — true = Miễn thi (không tính điểm bài này)
 *     teacherFeedback      : string        — lời phê, tối đa 2000 ký tự (có thể rỗng)
 *     expectedSubmitTimeMs : number|null   — mốc nộp bài (ms) của bản giáo viên đang xem
 *   }
 * Lỗi trả về: JSON { ok:false, message, code } — client đọc `message` và `code`.
 *
 * KẾT QUẢ GHI VÀO results/{result_id}:
 *   isExcused === true  -> status:'excused',   excused:true,  score:null,    gradingStatus:'graded'
 *   isExcused === false -> status:'submitted', excused:false, score:<điểm>,  gradingStatus:'graded'
 *   cả hai trường hợp   -> teacherFeedback, gradedAt (server time), gradedBy (uid giáo viên)
 *
 * Mã lỗi: 400 dữ liệu sai | 401 token sai/hết hạn | 403 không phải giáo viên chủ bài
 *         | 404 không có bài làm | 409 học sinh vừa nộp lại bài lúc đang chấm.
 *
 * Bảo mật:
 *   - CHỈ giáo viên sở hữu bài (results.teacher_id === uid trong token) mới chấm / miễn thi được.
 *   - Điểm được kiểm tra lại ở server (số hữu hạn, trong [0, maxScore]).
 *
 * Chống ghi đè nhầm khi học sinh "làm lại bài" giữa lúc giáo viên đang chấm:
 *   /api/submit-exam ghi đè results/{id} (submitTime mới). Nếu expectedSubmitTimeMs
 *   không khớp submitTime hiện tại -> 409, KHÔNG ghi điểm của bản cũ lên bài mới.
 *   Đọc + kiểm tra + ghi nằm trong 1 transaction nên không có khe hở giữa 2 bước.
 *
 * Lưu ý tích hợp: route này tự xác thực token bên trong (để trả đúng định dạng lỗi
 * { ok:false, message, code }) nên KHÔNG dùng middleware verifyFirebaseToken —
 * middleware đó vẫn giữ nguyên cho các route khác.
 */
const GRADE_FEEDBACK_MAX_CHARS = 2000;
const GRADE_DEFAULT_MAX_SCORE = 10;

/** Lỗi có mã HTTP, để ném từ trong transaction rồi trả JSON đúng định dạng client mong đợi. */
class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code || null;
    }
}

/** Timestamp Firestore | Date | number (ms) -> số ms; không đọc được thì null. */
function toMillis(value) {
    if (value === null || value === undefined) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function getBearerToken(req) {
    const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
}

/**
 * Tạo handler cho POST /api/grade-result.
 * Tách thành factory (nhận authAdmin + dbAdmin + FieldValue) để dễ kiểm thử mà không cần chạy server thật.
 */
function createGradeResultHandler({ authAdmin, dbAdmin, FieldValue }) {
    return async function gradeResultHandler(req, res) {
        try {
            /* ---------- 1) Xác thực: phải có ID token hợp lệ ---------- */
            const idToken = getBearerToken(req);
            if (!idToken) throw new HttpError(401, 'Thiếu thông tin đăng nhập.', 'unauthenticated');

            let uid;
            try {
                uid = (await authAdmin.verifyIdToken(idToken)).uid;
            } catch (err) {
                console.error('Token không hợp lệ hoặc đã hết hạn:', err.message);
                throw new HttpError(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.', 'unauthenticated');
            }

            /* ---------- 2) Kiểm tra dữ liệu gửi lên ---------- */
            const body = req.body || {};
            const resultId = typeof body.result_id === 'string' ? body.result_id.trim() : '';
            if (!resultId || resultId.includes('/')) {
                throw new HttpError(400, 'Thiếu hoặc sai result_id.', 'invalid-argument');
            }

            // isExcused phải là boolean thật (client cũ chưa gửi trường này -> coi như false)
            if (body.isExcused !== undefined && typeof body.isExcused !== 'boolean') {
                throw new HttpError(400, 'isExcused phải là true hoặc false.', 'invalid-argument');
            }
            const isExcused = body.isExcused === true;

            let feedback = '';
            if (body.teacherFeedback !== undefined && body.teacherFeedback !== null) {
                if (typeof body.teacherFeedback !== 'string') {
                    throw new HttpError(400, 'Lời phê phải là chuỗi ký tự.', 'invalid-argument');
                }
                feedback = body.teacherFeedback.trim();
                if (feedback.length > GRADE_FEEDBACK_MAX_CHARS) {
                    throw new HttpError(400, `Lời phê tối đa ${GRADE_FEEDBACK_MAX_CHARS} ký tự.`, 'invalid-argument');
                }
            }

            const expectedSubmitTimeMs = (typeof body.expectedSubmitTimeMs === 'number'
                && Number.isFinite(body.expectedSubmitTimeMs)) ? body.expectedSubmitTimeMs : null;

            // Điểm chỉ bắt buộc khi KHÔNG miễn thi. (Khi miễn thi, mọi giá trị `score` client gửi đều bị bỏ qua.)
            let score = null;
            if (!isExcused) {
                if (typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0) {
                    throw new HttpError(400, 'Điểm số phải là một số không âm.', 'invalid-argument');
                }
                score = Math.round(body.score * 100) / 100;
            }

            /* ---------- 3) Đọc + kiểm tra + ghi trong 1 transaction ---------- */
            const ref = dbAdmin.collection('results').doc(resultId);

            const saved = await dbAdmin.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) {
                    throw new HttpError(404, 'Không tìm thấy bài làm (có thể đã bị xóa).', 'not-found');
                }
                const data = snap.data();

                // Chỉ giáo viên CHỦ của bài mới được chấm / miễn thi
                if (data.teacher_id !== uid) {
                    throw new HttpError(403, 'Bạn không có quyền chấm bài làm này.', 'permission-denied');
                }

                // Học sinh nộp lại trong lúc giáo viên đang chấm -> từ chối, KHÔNG ghi đè lên bài mới.
                // Giữ dung sai 1ms (như route cũ) để tránh báo 409 oan do làm tròn timestamp;
                // và chỉ so khi bài có submitTime đọc được.
                const currentSubmitMs = toMillis(data.submitTime);
                if (expectedSubmitTimeMs !== null && currentSubmitMs !== null
                    && Math.abs(Math.floor(currentSubmitMs) - Math.floor(expectedSubmitTimeMs)) > 1) {
                    throw new HttpError(
                        409,
                        'Học sinh vừa nộp lại bài. Bài làm đã được cập nhật, vui lòng chấm lại.',
                        'submission-changed'
                    );
                }

                const update = {
                    teacherFeedback: feedback,
                    gradingStatus: 'graded',
                    gradedAt: FieldValue.serverTimestamp(),
                    gradedBy: uid
                };

                if (isExcused) {
                    // MIỄN THI: bài không có điểm và bị loại khỏi điểm cột / điểm môn (gradebook-engine bỏ qua status 'excused')
                    update.status = 'excused';
                    update.excused = true;
                    update.score = null;
                } else {
                    const maxScore = Number(data.maxScore) > 0 ? Number(data.maxScore) : GRADE_DEFAULT_MAX_SCORE;
                    if (score > maxScore) {
                        throw new HttpError(400, `Điểm không được lớn hơn ${maxScore}.`, 'invalid-argument');
                    }
                    // Bỏ miễn thi (nếu trước đó có) + chấm điểm bình thường: bài quay lại trạng thái đã nộp
                    update.status = 'submitted';
                    update.excused = false;
                    update.score = score;
                }

                tx.update(ref, update);
                return { status: update.status, excused: update.excused, score: update.score };
            });

            return res.json({ ok: true, ...saved });
        } catch (err) {
            if (err instanceof HttpError) {
                return res.status(err.status).json({ ok: false, message: err.message, code: err.code });
            }
            console.error('[/api/grade-result] Lỗi không mong đợi:', err);
            return res.status(500).json({ ok: false, message: 'Lỗi máy chủ khi lưu điểm. Vui lòng thử lại.', code: 'internal' });
        }
    };
}

app.post('/api/grade-result', createGradeResultHandler({ authAdmin, dbAdmin, FieldValue }));
// ===== GIAI ĐOẠN 4.3 (SpeedGrader) + 4.4 (Miễn thi) — KẾT THÚC: API GIÁO VIÊN CHẤM BÀI / MIỄN THI =====

/**
 * --- (Tính năng mới) FILE ÔN TẬP SAU KHI NỘP BÀI ---
 *
 * Học sinh nộp bài xong có thể tải về trọn bộ đề thi kèm đáp án đúng + lời
 * giải (PDF/Word) để ôn tập offline. Quyền tải do GIÁO VIÊN quyết định lúc
 * tạo bài (field exams.allowDownloadReview, xem tao-bai-kiem-tra.js).
 *
 * Vì collection "questions" đã khoá quyền đọc của học sinh (chỉ giáo viên
 * sở hữu đọc được), dữ liệu đề + đáp án PHẢI đi qua server (Admin SDK). Mọi
 * điều kiện dưới đây đều kiểm ở server, không tin bất cứ gì client gửi:
 *
 *   1. Giáo viên đã bật allowDownloadReview cho bài này.
 *   2. Nhất quán với các cờ hiển thị sẵn có, theo thứ tự lồng nhau giống
 *      /api/get-result-detail: phải bật showScoreImmediately VÀ
 *      showCorrectAnswers (file này chứa đáp án đúng, không thể "mở cửa
 *      sau" trong khi giáo viên đang tắt hiện đáp án). Lời giải chỉ kèm
 *      theo nếu giáo viên bật showExplanation.
 *   3. Học sinh ĐÃ NỘP BÀI: tồn tại results/{exam_id}_{uid}.
 *   4. Nếu bài cho làm nhiều lần (maxAttempts > 1) thì chỉ mở khi học sinh
 *      đã dùng HẾT lượt — nếu không, tải file đáp án xong là làm lại lần
 *      sau được điểm cao dễ dàng.
 *
 * File xuất ra KHÔNG chứa điểm hay bài làm cá nhân — chỉ đề + đáp án + lời
 * giải, theo đúng thứ tự giáo viên xếp câu hỏi (không xáo trộn).
 */
async function checkReviewDownloadAccess(examId, examData, studentId) {
    if (examData.allowDownloadReview !== true) {
        return { ok: false, status: 403, message: 'Giáo viên không bật tính năng tải file ôn tập cho bài kiểm tra này.' };
    }
    if (examData.showScoreImmediately !== true || examData.showCorrectAnswers !== true) {
        return { ok: false, status: 403, message: 'Giáo viên chưa mở phần xem đáp án cho bài kiểm tra này.' };
    }

    const resultSnap = await dbAdmin.collection('results').doc(`${examId}_${studentId}`).get();
    if (!resultSnap.exists || resultSnap.data().student_id !== studentId) {
        return { ok: false, status: 403, message: 'Bạn cần nộp bài trước khi tải file ôn tập.' };
    }

    const maxAttempts = Number(examData.maxAttempts) > 1 ? Number(examData.maxAttempts) : null;
    if (maxAttempts !== null) {
        const attemptSnap = await dbAdmin.collection('exam_attempts').doc(`${examId}_${studentId}`).get();
        const usedAttempts = attemptSnap.exists ? (Number(attemptSnap.data().count) || 0) : 0;
        if (usedAttempts < maxAttempts) {
            return {
                ok: false,
                locked: true,
                status: 403,
                message: `Bạn còn ${maxAttempts - usedAttempts} lượt làm bài. File ôn tập sẽ mở sau khi bạn dùng hết số lượt.`
            };
        }
    }

    return { ok: true };
}

/**
 * Chuẩn hoá 1 câu hỏi về dạng gọn cho file ôn tập, hỗ trợ cả 2 schema
 * (answers[{text,correct}] và options[]+correctAnswer) — cùng cách
 * getCorrectIndexServer/getOptionTextsServer đang làm. Khác getCorrectIndexServer
 * ở chỗ trả về MỌI đáp án đúng (câu "nhiều đáp án").
 */
function toReviewQuestionServer(q, includeExplanation) {
    const type = typeof q.type === 'string' ? q.type : 'multiple_choice';

    let correctIndexes = [];
    if (Array.isArray(q.answers)) {
        q.answers.forEach((a, i) => { if (a && a.correct === true) correctIndexes.push(i); });
    } else if (typeof q.correctAnswer === 'number' && q.correctAnswer >= 0) {
        correctIndexes = [q.correctAnswer];
    }

    return {
        id: q.id,
        type,
        text: q.question || q.text || '',
        options: type === 'essay' ? [] : getOptionTextsServer(q),
        correctIndexes,
        essayAnswer: (type === 'essay' && typeof q.essayAnswer === 'string') ? q.essayAnswer : '',
        explanation: (includeExplanation && typeof q.explanation === 'string') ? q.explanation : '',
        image: typeof q.image === 'string' ? q.image : '',
        score: Number(q.score) > 0 ? Number(q.score) : 1
    };
}

app.post('/api/get-review-material', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid; // từ token đã xác thực, không tin body
        const { exam_id } = req.body || {};

        if (!exam_id || typeof exam_id !== 'string' || exam_id.includes('/')) {
            return res.status(400).json({ message: 'Thiếu hoặc sai exam_id.' });
        }

        const examSnap = await dbAdmin.collection('exams').doc(exam_id).get();
        if (!examSnap.exists) {
            return res.status(404).json({ message: 'Không tìm thấy bài kiểm tra.' });
        }
        const examData = examSnap.data();

        const access = await checkReviewDownloadAccess(exam_id, examData, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        const includeExplanation = examData.showExplanation === true;
        const questions = await fetchQuestionsByIds(questionIds);

        // Dữ liệu chứa đáp án -> tuyệt đối không cho trình duyệt/proxy cache lại.
        res.set('Cache-Control', 'no-store');
        return res.json({
            ok: true,
            title: examData.quizName || examData.title || 'Bài kiểm tra',
            subject: examData.subject || '',
            includeExplanation,
            questions: questions.map((q) => toReviewQuestionServer(q, includeExplanation))
        });
    } catch (error) {
        console.error('Lỗi lấy dữ liệu file ôn tập:', error);
        return res.status(500).json({ message: 'Lỗi server khi tạo file ôn tập.' });
    }
});

// Health check: frontend (tailieu.js...) ping route này để "đánh thức" server
// Render (free tier) và biết server đã sẵn sàng trước khi cho thao tác.
app.get('/api/health', (req, res) => {
    return res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Lệnh này bắt buộc phải có để server không bị "thoát sớm"
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});