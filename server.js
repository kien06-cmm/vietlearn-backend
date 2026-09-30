const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const {
    getCorrectIndicesServer,
    getOptionTextsServer,
    sanitizeQuestionForClient,
    isManualQuestionServer,
    extractManualAnswerServer,
    seededShuffle,
    gradeSubmission,
    normalizeQuestionType,
    translateMatchingAnswer,
    toReviewQuestionServer,
    buildOrderingResultView,
    buildDragDropResultView
} = require('./lib/grading');

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

// ===== MIDDLEWARE XÁC THỰC =====
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

async function requireTeacherRole(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!idToken) {
        return res.status(401).json({ message: 'Thiếu token xác thực. Vui lòng đăng nhập lại.' });
    }

    try {
        const decoded = await authAdmin.verifyIdToken(idToken);
        req.uid = decoded.uid;

        const userSnap = await dbAdmin.collection('users').doc(decoded.uid).get();
        const role = userSnap.exists ? userSnap.data().role : null;

        if (role !== 'giaovien' && role !== 'admin') {
            return res.status(403).json({ message: 'Chỉ tài khoản giáo viên hoặc admin mới được dùng tính năng này.' });
        }

        next();
    } catch (err) {
        console.error('Xác thực/kiểm tra quyền giáo viên thất bại:', err.message);
        return res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.' });
    }
}

// ===== HELPER: LƯU BẢN NỘP CŨ =====
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

// ===== HELPER: TRUY CẬP BÀI THI =====
async function loadExamForStudent(examId, studentId) {
    const examSnap = await dbAdmin.collection('exams').doc(examId).get();
    if (!examSnap.exists) {
        return { ok: false, status: 404, message: 'Không tìm thấy bài kiểm tra.' };
    }
    const examData = examSnap.data();

    if (examData.status !== 'active') {
        return { ok: false, status: 403, message: 'Bài kiểm tra đã đóng hoặc chưa mở, không thể tiếp tục.' };
    }

    if (!examData.class_id) {
        return { ok: true, examData };
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

    if (!examData.class_id) {
        return { ok: true, examId: examDoc.id, examData };
    }

    const memberSnap = await dbAdmin
        .collection('class_members')
        .doc(`${studentId}_${examData.class_id}`)
        .get();
    if (!memberSnap.exists || memberSnap.data().status !== 'active') {
        return { ok: false, status: 403, message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' };
    }

    return { ok: true, examId: examDoc.id, examData };
}

// ===== HELPER: TÊN LỚP =====
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

// ===== HELPER: LẤY CÂU HỎI THEO ID =====
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

// ===== HELPER: PHIÊN LÀM BÀI (CHỐNG GIAN LẬN THỜI GIAN) =====
async function getOrStartExamSession(examId, studentId, examData) {
    const sessionRef = dbAdmin.collection('exam_sessions').doc(`${examId}_${studentId}`);
    const sessionSnap = await sessionRef.get();

    if (sessionSnap.exists && typeof sessionSnap.data().startedAtMs === 'number') {
        return sessionSnap.data().startedAtMs;
    }

    const startedAtMs = Date.now();
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

// ===== API: LẤY CÂU HỎI THEO MÃ PHÒNG (GET) =====
app.get('/api/get-exam-questions', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid;
        const roomCode = typeof req.query.code === 'string' ? req.query.code.trim() : '';

        if (!roomCode) {
            return res.status(400).json({ message: 'Thiếu mã phòng thi (code).' });
        }

        const access = await loadExamForStudentByRoomCode(roomCode, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const { examId, examData } = access;

        // Giới hạn số lần làm bài
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

        // Ghi mốc bắt đầu làm bài
        const startedAtMs = await getOrStartExamSession(examId, studentId, examData);

        // Lấy + xáo câu hỏi
        let orderedQuestions = await fetchQuestionsByIds(questionIds);

        if (examData.shuffleQuestions === true) {
            orderedQuestions = seededShuffle(orderedQuestions, `${examId}_${studentId}`);
        }

        // Xoá đáp án đúng trước khi trả về
        const sanitizedQuestions = orderedQuestions.map(
            (q) => sanitizeQuestionForClient(q, `${examId}_${studentId}_${q.id}`)
        );

        return res.json({
            examId,
            title: examData.quizName || examData.title || '',
            duration: examData.duration || 15,
            allowSkip: examData.allowSkip !== false,
            allowFlagForReview: examData.allowFlagForReview === true,
            startedAt: startedAtMs,
            questions: sanitizedQuestions
        });
    } catch (error) {
        console.error('Lỗi lấy câu hỏi theo mã phòng:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
    }
});

// ===== API: THI THỬ (GIÁO VIÊN) =====
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
            questions: orderedQuestions.map((q) => sanitizeQuestionForClient(q, `${examId}_${req.uid}_${q.id}`))
        });
    } catch (error) {
        console.error('Lỗi thi thử bài kiểm tra:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải bài thi thử.' });
    }
});

// ===== AI: BÓC TÁCH CÂU HỎI TỪ FILE =====
const EXTRACT_SYSTEM_PROMPT = `Bạn LÀ công cụ trích xuất dữ liệu, KHÔNG phải người soạn đề.
Nhiệm vụ: CHỈ ĐƯỢC trích xuất những câu hỏi CÓ SẴN trong tài liệu được cung cấp.

QUY TẮC BẮT BUỘC:
1. TUYỆT ĐỐI KHÔNG tự sáng tác, suy luận hay thêm bớt câu hỏi, đáp án hoặc lời giải. Không viết thêm câu hỏi cho "đủ số lượng", không dùng kiến thức bên ngoài tài liệu.
2. Nếu tài liệu không chứa câu hỏi nào (trắc nghiệm, đúng/sai hoặc tự luận), trả về mảng rỗng [].
3. Giữ nguyên văn câu hỏi và từng đáp án như trong tài liệu. Không diễn đạt lại, không sửa số liệu.
4. Đáp án đúng (correct_option): CHỈ điền số khi tài liệu CHỈ RÕ đáp án đúng (đáp án cuối bài, in đậm, gạch chân, dấu đánh dấu) — là CHỈ MỤC 0-based của đáp án đó trong mảng "options". Nếu tài liệu không chỉ rõ, đặt "correct_option": null. TUYỆT ĐỐI KHÔNG tự giải bài để chọn đáp án đúng.
5. "explanation": chỉ lấy lời giải CÓ SẴN trong tài liệu; không có thì để chuỗi rỗng "".
6. "subject" và "grade": chỉ điền khi tài liệu ghi rõ; không có thì để chuỗi rỗng "". "difficulty": nếu tài liệu không ghi thì dùng "medium".
7. Công thức toán giữ ở dạng LaTeX: dùng \\( ... \\) cho công thức trong dòng và $$ ... $$ cho công thức riêng dòng.

Trả về MỘT MẢNG JSON duy nhất theo ĐÚNG định dạng chuẩn sau (KHÔNG dùng tên field nào khác):
[
  {
    "question_text": "Nội dung câu hỏi",
    "type": "multiple_choice" | "essay" | "true_false",
    "subject": "Tên môn học (chuỗi rỗng nếu tài liệu không ghi)",
    "grade": "Khối lớp (chuỗi rỗng nếu tài liệu không ghi)",
    "difficulty": "easy" | "medium" | "hard",
    "score": 1,
    "options": ["Đáp án A", "Đáp án B"] (Dùng cho trắc nghiệm/đúng-sai; mảng chuỗi thuần, KHÔNG bọc {text, correct}),
    "correct_option": 0 (chỉ mục 0-based trong "options" — null nếu tài liệu không chỉ rõ; luôn null với type=essay),
    "image_url": "",
    "essayAnswer": "Đáp án tự luận mẫu CÓ SẴN trong tài liệu (nếu có)" (Dùng cho tự luận),
    "explanation": "Lời giải có sẵn trong tài liệu (chuỗi rỗng nếu không có)"
  }
]
CHỈ TRẢ VỀ CHUỖI JSON, KHÔNG BỌC TRONG MARKDOWN VÀ KHÔNG THÊM VĂN BẢN NÀO NGOÀI MẢNG JSON.`;

const EXTRACT_VALID_TYPES = ['multiple_choice', 'essay', 'true_false'];

function sanitizeExtractedQuestions(raw) {
    if (!Array.isArray(raw)) return [];

    return raw.filter((q) => {
        if (!q) return false;
        const questionText = typeof q.question_text === 'string' ? q.question_text
            : (typeof q.question === 'string' ? q.question : '');
        if (questionText.trim() === '') return false;
        if (!EXTRACT_VALID_TYPES.includes(q.type)) return false;

        if (q.type === 'multiple_choice') {
            if (Array.isArray(q.options)) {
                return q.options.length >= 2
                    && q.options.every((o) => typeof o === 'string' && o.trim() !== '');
            }
            return Array.isArray(q.answers)
                && q.answers.length >= 2
                && q.answers.every((a) => a && typeof a.text === 'string' && a.text.trim() !== '');
        }
        return true;
    });
}

app.post('/api/extract-questions', requireTeacherRole, async (req, res) => {
    try {
        const { source, mimeType, fileBase64 } = req.body;
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
        } else {
            return res.status(400).json({ message: "Thiếu file PDF để xử lý. Hệ thống chỉ hỗ trợ file PDF, không còn hỗ trợ Google Forms." });
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

        const rawList = Array.isArray(parsed) ? parsed : parsed && parsed.questions;

        res.json({ questions: sanitizeExtractedQuestions(rawList) });

    } catch (error) {
        console.error("Lỗi bóc tách tài liệu:", error);
        res.status(500).json({ message: "Lỗi server khi bóc tách tài liệu." });
    }
});

// ===== AI: BIÊN DỊCH TOÁN =====
app.post('/api/compile-math', requireTeacherRole, async (req, res) => {
    try {
        const { input } = req.body;
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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

// ===== API: NỘP BÀI & CHẤM ĐIỂM =====
app.post('/api/submit-exam', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid;
        const {
            exam_id, answers, timeUsed, cheatWarnings, cheatLogs,
            studentName: clientStudentName,
            className,
            quizName: clientQuizName,
            subject: clientSubject
        } = req.body;

        if (!exam_id || typeof exam_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }
        const safeAnswers = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};

        // Kiểm tra quyền vào bài
        const access = await loadExamForStudent(exam_id, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const examData = access.examData;

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        // Đối chiếu thời gian làm bài
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
        const TOLERANCE_SECONDS = 120;
        const isLateSubmission = !isUnlimitedTime && serverElapsedSeconds > (allowedDurationSeconds + TOLERANCE_SECONDS);

        if (isLateSubmission) {
            console.warn(`Nộp bài trễ hơn dung sai cho phép: exam=${exam_id}, student=${studentId}, serverElapsedSeconds=${serverElapsedSeconds}, allowedDurationSeconds=${allowedDurationSeconds}`);
        }

        const questions = await fetchQuestionsByIds(questionIds);

        // Dịch đáp án câu Ghép đôi về id thật
        const translatedAnswers = { ...safeAnswers };
        questions.forEach((q) => {
            if (normalizeQuestionType(q.type) === 'matching') {
                translatedAnswers[q.id] = translateMatchingAnswer(
                    q, safeAnswers[q.id], `${exam_id}_${studentId}_${q.id}`
                );
            }
        });

        // Chấm điểm
        const {
            correctCount,
            skippedCount,
            incorrectCount,
            details,
            manualItems,
            totalQuestions,
            hasManualItems,
            gradingStatus,
            autoScore,
            score
        } = gradeSubmission(questions, translatedAnswers);

        // Tên học sinh
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

        // Tên lớp
        const serverClassName = await loadClassNameById(examData.class_id);

        // Ghi kết quả
        const payload = {
            teacher_id: examData.teacher_id || '',
            exam_id,
            student_id: studentId,
            studentName,
            class_id: examData.class_id || '',
            gradebookColumnId: examData.gradebookColumnId || '',
            gradebookColumnName: examData.gradebookColumnName || '',
            status: hasManualItems ? 'pending_grading' : 'submitted',
            className: serverClassName
                || ((typeof className === 'string' && className.trim()) ? className.trim() : 'Không xác định'),
            subject: examData.subject || (typeof clientSubject === 'string' ? clientSubject : ''),
            quizName: examData.quizName || examData.title || (typeof clientQuizName === 'string' ? clientQuizName : ''),
            score,
            gradingStatus,
            autoScore: hasManualItems ? autoScore : null,
            manualItems,
            teacherFeedback: '',
            correctCount,
            totalQuestions,
            answers: safeAnswers,
            details,
            cheatWarnings: Number(cheatWarnings) || 0,
            cheatLogs: Array.isArray(cheatLogs) ? cheatLogs : [],
            timeUsedSeconds: serverElapsedSeconds,
            clientReportedTimeUsedSeconds: Number(timeUsed) || 0,
            lateSubmission: isLateSubmission,
            submitTime: FieldValue.serverTimestamp()
        };

        const resultRef = dbAdmin.collection('results').doc(`${exam_id}_${studentId}`);
        await archivePreviousResultAttempt(resultRef);
        await resultRef.set(payload);

        // Dọn phiên làm bài
        await dbAdmin.collection('exam_sessions').doc(`${exam_id}_${studentId}`).delete().catch((cleanupErr) => {
            console.error('Không xoá được exam_sessions sau khi nộp bài (không chặn kết quả đã lưu):', cleanupErr.message);
        });

        // Cộng dồn số lần làm bài
        await dbAdmin.collection('exam_attempts').doc(`${exam_id}_${studentId}`).set({
            examId: exam_id,
            studentId,
            count: FieldValue.increment(1),
            lastSubmittedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        // Dữ liệu trả về theo cờ hiển thị
        const responsePayload = { ok: true, gradingStatus };

        if (examData.showScoreImmediately === true) {
            responsePayload.score = score;
            responsePayload.correctCount = correctCount;
            responsePayload.skippedCount = skippedCount;
            responsePayload.incorrectCount = incorrectCount;
            responsePayload.totalQuestions = totalQuestions;
        }

        if (examData.showCorrectAnswers === true || examData.showExplanation === true) {
            responsePayload.details = details.map((item) => {
                const filtered = {
                    questionId: item.questionId,
                    studentAnswer: item.studentAnswer,
                    isCorrect: item.isCorrect,
                    skipped: item.skipped === true || item.studentAnswer === null || item.studentAnswer === undefined
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

        // Cờ nút tải file ôn tập
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

// ===== API: LẤY CÂU HỎI THEO EXAM_ID (POST) =====
app.post('/api/get-exam-questions', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid;
        const { exam_id } = req.body;

        if (!exam_id || typeof exam_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }

        const access = await loadExamForStudent(exam_id, studentId);
        if (!access.ok) {
            return res.status(access.status).json({ message: access.message });
        }
        const examData = access.examData;

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        const orderedQuestions = await fetchQuestionsByIds(questionIds);

        const sanitizedQuestions = orderedQuestions.map(
            (q) => sanitizeQuestionForClient(q, `${exam_id}_${studentId}_${q.id}`)
        );

        return res.json({ questions: sanitizedQuestions });
    } catch (error) {
        console.error('Lỗi lấy câu hỏi cho học sinh:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
    }
});

// ===== API: XEM LẠI BÀI LÀM =====
app.post('/api/get-result-detail', verifyFirebaseToken, async (req, res) => {
    try {
        const { result_id } = req.body;
        if (!result_id || typeof result_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu result_id.' });
        }

        const resultSnap = await dbAdmin.collection('results').doc(result_id).get();
        if (!resultSnap.exists) {
            return res.status(404).json({ message: 'Không tìm thấy bài làm.' });
        }
        const resultData = resultSnap.data();

        if (resultData.student_id !== req.uid) {
            return res.status(403).json({ message: 'Bạn không có quyền xem bài làm của người khác.' });
        }

        // Cờ hiển thị
        const examSnap = await dbAdmin.collection('exams').doc(resultData.exam_id).get();
        const examData = examSnap.exists ? examSnap.data() : {};

        const scoreVisible = examData.showScoreImmediately === true;
        const questionsVisible = scoreVisible && examData.showCorrectAnswers === true;
        const explanationVisible = questionsVisible && examData.showExplanation === true;

        // Thống kê đúng / sai / bỏ qua
        const fullDetails = Array.isArray(resultData.details) ? resultData.details : [];
        const totalQuestions = Number(resultData.totalQuestions) || fullDetails.length;
        const correctCount = Number(resultData.correctCount) || 0;
        const skippedCount = fullDetails.filter(
            (d) => d.skipped === true || d.studentAnswer === null || d.studentAnswer === undefined
        ).length;
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
            gradingStatus: resultData.gradingStatus || 'graded'
        };

        // Bài tự luận / upload
        if (Array.isArray(resultData.manualItems) && resultData.manualItems.length > 0) {
            responsePayload.manualItems = resultData.manualItems.map((item) => ({
                type: (item && item.type === 'upload') ? 'upload' : 'essay',
                questionText: (item && typeof item.questionText === 'string') ? item.questionText : '',
                essayAnswer: (item && typeof item.essayAnswer === 'string') ? item.essayAnswer : '',
                fileUrl: (item && typeof item.fileUrl === 'string') ? item.fileUrl : '',
                fileName: (item && typeof item.fileName === 'string') ? item.fileName : ''
            }));
        }

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
            const questionIds = fullDetails.map((d) => d.questionId).filter(Boolean);
            const questions = await fetchQuestionsByIds(questionIds);
            const questionMap = {};
            questions.forEach((q) => { questionMap[q.id] = q; });

            responsePayload.questions = fullDetails.map((d) => {
                const q = questionMap[d.questionId] || {};
                const canonicalType = typeof q.type === 'string' ? q.type : 'multiple_choice';
                const item = {
                    id: d.questionId,
                    type: canonicalType,
                    text: q.question_text || q.question || q.text || '',
                    options: getOptionTextsServer(q),
                    studentAnswer: Array.isArray(d.studentAnswer) ? d.studentAnswer
                        : (typeof d.studentAnswer === 'number' ? d.studentAnswer : null),
                    correctAnswer: Array.isArray(d.correctAnswer) ? d.correctAnswer
                        : (typeof d.correctAnswer === 'number' ? d.correctAnswer : -1),
                    isCorrect: d.isCorrect === true,
                    skipped: d.skipped === true
                };

                // Điền chỗ trống
                if (canonicalType === 'fill_blank' && Array.isArray(d.correctAnswer)) {
                    item.blanks = d.correctAnswer.map((b) => ({
                        acceptedAnswers: Array.isArray(b && b.acceptedAnswers) ? b.acceptedAnswers : []
                    }));
                }

                // Ghép đôi
                if (canonicalType === 'matching' && Array.isArray(d.correctAnswer)) {
                    const studentMap = (d.studentAnswer && typeof d.studentAnswer === 'object' && !Array.isArray(d.studentAnswer))
                        ? d.studentAnswer : {};
                    const pairById = {};
                    d.correctAnswer.forEach((p) => { if (p && p.id !== undefined && p.id !== null) pairById[p.id] = p; });

                    item.pairs = d.correctAnswer.map((p) => {
                        const chosenId = studentMap[p.id];
                        const chosenPair = (chosenId !== undefined && chosenId !== null) ? pairById[chosenId] : null;
                        return {
                            left: p.left,
                            right: p.right,
                            studentRight: chosenPair ? chosenPair.right : '',
                            isCorrect: (chosenId !== undefined && chosenId !== null) ? String(chosenId) === String(p.id) : false
                        };
                    });
                }

                // Sắp xếp
                if (canonicalType === 'ordering' && Array.isArray(d.correctAnswer)) {
                    const orderingView = buildOrderingResultView(q, d);
                    item.items = orderingView.items;
                    item.studentPositions = orderingView.studentPositions;
                }

                // Kéo-thả
                if (canonicalType === 'drag_drop' && Array.isArray(d.correctAnswer)) {
                    const dragDropView = buildDragDropResultView(q, d);
                    item.zones = dragDropView.zones;
                    item.distractors = dragDropView.distractors;
                }

                if (explanationVisible) {
                    item.explanation = typeof d.explanation === 'string' ? d.explanation : '';
                }
                return item;
            });
        }

        return res.json(responsePayload);
    } catch (error) {
        console.error('Lỗi lấy chi tiết bài làm:', error);
        return res.status(500).json({ message: 'Lỗi server khi tải chi tiết bài làm.' });
    }
});

// ===== API: GIÁO VIÊN CHẤM BÀI / MIỄN THI — BẮT ĐẦU =====
const GRADE_FEEDBACK_MAX_CHARS = 2000;
const GRADE_DEFAULT_MAX_SCORE = 10;

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code || null;
    }
}

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

function createGradeResultHandler({ authAdmin, dbAdmin, FieldValue }) {
    return async function gradeResultHandler(req, res) {
        try {
            // Xác thực
            const idToken = getBearerToken(req);
            if (!idToken) throw new HttpError(401, 'Thiếu thông tin đăng nhập.', 'unauthenticated');

            let uid;
            try {
                uid = (await authAdmin.verifyIdToken(idToken)).uid;
            } catch (err) {
                console.error('Token không hợp lệ hoặc đã hết hạn:', err.message);
                throw new HttpError(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.', 'unauthenticated');
            }

            // Kiểm tra dữ liệu gửi lên
            const body = req.body || {};
            const resultId = typeof body.result_id === 'string' ? body.result_id.trim() : '';
            if (!resultId || resultId.includes('/')) {
                throw new HttpError(400, 'Thiếu hoặc sai result_id.', 'invalid-argument');
            }

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

            let score = null;
            if (!isExcused) {
                if (typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0) {
                    throw new HttpError(400, 'Điểm số phải là một số không âm.', 'invalid-argument');
                }
                score = Math.round(body.score * 100) / 100;
            }

            // Transaction đọc + kiểm tra + ghi
            const ref = dbAdmin.collection('results').doc(resultId);

            const saved = await dbAdmin.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) {
                    throw new HttpError(404, 'Không tìm thấy bài làm (có thể đã bị xóa).', 'not-found');
                }
                const data = snap.data();

                if (data.teacher_id !== uid) {
                    throw new HttpError(403, 'Bạn không có quyền chấm bài làm này.', 'permission-denied');
                }

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
                    update.status = 'excused';
                    update.excused = true;
                    update.score = null;
                } else {
                    const maxScore = Number(data.maxScore) > 0 ? Number(data.maxScore) : GRADE_DEFAULT_MAX_SCORE;
                    if (score > maxScore) {
                        throw new HttpError(400, `Điểm không được lớn hơn ${maxScore}.`, 'invalid-argument');
                    }
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
// ===== API: GIÁO VIÊN CHẤM BÀI / MIỄN THI — KẾT THÚC =====

// ===== API: FILE ÔN TẬP =====
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

app.post('/api/get-review-material', verifyFirebaseToken, async (req, res) => {
    try {
        const studentId = req.uid;
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

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
    return res.status(200).json({ status: 'ok' });
});

// ===== KHỞI ĐỘNG SERVER =====
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});