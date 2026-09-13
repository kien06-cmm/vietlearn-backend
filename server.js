const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

/**
 * --- FIREBASE ADMIN SDK — CẤU HÌNH BẰNG SERVICE ACCOUNT ---
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
 *    không admin.credential.cert() sẽ báo lỗi "Invalid PEM formatted
 *    message" khi khởi động server.
 *
 * KHÔNG dùng chung Service Account này ở phía frontend (login.js,
 * register.js...) — nó có toàn quyền Admin, chỉ được nằm trên server.
 */
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
});

const dbAdmin = admin.firestore();

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
        const decoded = await admin.auth().verifyIdToken(idToken);
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

// --- API Xử lý Bóc tách tài liệu (PDF/Word/Forms) ---
app.post('/api/extract-questions', async (req, res) => {
    try {
        const { source, mimeType, fileBase64, formsUrl } = req.body;
        console.log("Đã nhận yêu cầu xử lý từ frontend:", source);
        
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Sử dụng model Gemini 3.5 Flash Lite siêu tốc
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.5-flash-lite",
            systemInstruction: `Bạn là trợ lý AI chuyên phân tích tài liệu giáo dục. Nhiệm vụ của bạn là bóc tách các câu hỏi trong tài liệu và trả về MỘT MẢNG JSON duy nhất chứa các câu hỏi theo đúng định dạng sau:
[
  {
    "question": "Nội dung câu hỏi",
    "type": "multiple_choice" | "essay" | "true_false",
    "subject": "Tên môn học",
    "grade": "Khối lớp (ví dụ: 10, 11, 12)",
    "difficulty": "easy" | "medium" | "hard",
    "score": 1,
    "answers": [{"text": "Đáp án A", "correct": true}, {"text": "Đáp án B", "correct": false}] (Dùng cho trắc nghiệm),
    "essayAnswer": "Đáp án tự luận mẫu" (Dùng cho tự luận)
  }
]
TUYỆT ĐỐI CHỈ TRẢ VỀ CHUỖI JSON, KHÔNG BỌC TRONG KÝ HIỆU MARKDOWN HAY GIẢI THÍCH.`
        });

        let promptText = "";
        let requestContent = [];

        if (source === 'file' && fileBase64) {
            promptText = "Hãy bóc tách tất cả các câu hỏi có trong tài liệu đính kèm này.";
            requestContent = [
                promptText,
                {
                    inlineData: {
                        data: fileBase64,
                        mimeType: mimeType || "application/pdf"
                    }
                }
            ];
        } else if (source === 'google-forms' && formsUrl) {
             promptText = `Hãy phân tích đường link Google Forms sau đây và bóc tách các câu hỏi: ${formsUrl}`;
             requestContent = [promptText];
        } else {
             return res.status(400).json({ message: "Thiếu dữ liệu đầu vào (file hoặc link)." });
        }

        const result = await model.generateContent(requestContent);
        let text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        
        // Trả về đúng định dạng { questions: [...] } mà Frontend yêu cầu
        res.json({ questions: JSON.parse(text) });

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
        const { exam_id, answers, timeUsed, cheatWarnings, cheatLogs } = req.body;

        if (!exam_id || typeof exam_id !== 'string') {
            return res.status(400).json({ message: 'Thiếu exam_id.' });
        }
        const safeAnswers = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};

        // 1. Lấy bài kiểm tra thật từ Firestore (không tin dữ liệu exam mà client có thể gửi kèm)
        const examSnap = await dbAdmin.collection('exams').doc(exam_id).get();
        if (!examSnap.exists) {
            return res.status(404).json({ message: 'Không tìm thấy bài kiểm tra.' });
        }
        const examData = examSnap.data();

        if (examData.status !== 'active') {
            return res.status(403).json({ message: 'Bài kiểm tra đã đóng hoặc chưa mở, không thể nộp bài.' });
        }

        // 2. Xác nhận học sinh thực sự là thành viên active của lớp sở hữu bài này
        //    (chặn trường hợp học sinh có link/roomCode nhưng chưa từng tham gia lớp)
        const memberSnap = await dbAdmin
            .collection('class_members')
            .doc(`${studentId}_${examData.class_id}`)
            .get();
        if (!memberSnap.exists || memberSnap.data().status !== 'active') {
            return res.status(403).json({ message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' });
        }

        const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
        if (questionIds.length === 0) {
            return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
        }

        // 3. Lấy nội dung câu hỏi thật (chia chunk 10 vì toán tử "in" giới hạn 10-30
        //    phần tử tuỳ phiên bản; giữ 10 cho an toàn, khớp cách hocsinh.js đang làm)
        const chunks = [];
        for (let i = 0; i < questionIds.length; i += 10) {
            chunks.push(questionIds.slice(i, i + 10));
        }
        const chunkSnaps = await Promise.all(
            chunks.map((chunk) =>
                dbAdmin
                    .collection('questions')
                    .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
                    .get()
            )
        );
        const questionMap = {};
        chunkSnaps.forEach((snap) => {
            snap.docs.forEach((d) => {
                questionMap[d.id] = { id: d.id, ...d.data() };
            });
        });
        // Giữ đúng thứ tự questionIds ban đầu; bỏ qua câu hỏi đã bị xoá khỏi ngân hàng
        const questions = questionIds.map((id) => questionMap[id]).filter(Boolean);

        // 4. CHẤM ĐIỂM THẬT — đây là phần học sinh không thể giả mạo được nữa vì
        //    toàn bộ logic này chạy trên server, dùng đáp án đúng lấy trực tiếp
        //    từ Firestore chứ không phải dữ liệu client gửi lên.
        //    Cộng điểm theo field "score" của từng câu (nếu có) thay vì chia đều:
        //    câu nào không có "score" thì mặc định coi là 1 điểm.
        let correctCount = 0;
        let earnedPoints = 0;
        let totalPoints = 0;

        questions.forEach((q) => {
            const points = Number(q.score) > 0 ? Number(q.score) : 1;
            totalPoints += points;

            const correctIndex = getCorrectIndexServer(q);
            const studentAnswer = safeAnswers[q.id];

            if (correctIndex !== -1 && studentAnswer === correctIndex) {
                correctCount += 1;
                earnedPoints += points;
            }
        });

        const totalQuestions = questions.length;
        const score = totalPoints > 0 ? Number(((earnedPoints / totalPoints) * 10).toFixed(1)) : 0;

        // 5. Lấy tên học sinh thật từ hồ sơ (không tin studentName client tự gửi)
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

        // 6. Ghi kết quả bằng Admin SDK — bypass Firestore Rules hoàn toàn,
        //    nên rule results.create/update phía client có bị khoá (if false)
        //    cũng không ảnh hưởng gì tới việc ghi này.
        const payload = {
            teacher_id: examData.teacher_id || '',
            exam_id,
            student_id: studentId,
            studentName,
            class_id: examData.class_id || '',
            subject: examData.subject || '',
            // FIX kèm theo: exam dùng field "quizName" (không phải "title") —
            // xem mục 1.1 báo cáo. Đọc đúng field thật để không ghi results rỗng.
            quizName: examData.quizName || examData.title || '',
            score,
            correctCount,
            totalQuestions,
            cheatWarnings: Number(cheatWarnings) || 0,
            cheatLogs: Array.isArray(cheatLogs) ? cheatLogs : [],
            timeUsedSeconds: Number(timeUsed) || 0,
            submitTime: admin.firestore.FieldValue.serverTimestamp()
        };

        await dbAdmin.collection('results').doc(`${exam_id}_${studentId}`).set(payload);

        return res.json({ ok: true, score, correctCount, totalQuestions });
    } catch (error) {
        console.error('Lỗi chấm điểm / nộp bài:', error);
        return res.status(500).json({ message: 'Lỗi server khi nộp bài. Vui lòng thử lại.' });
    }
});

// Lệnh này bắt buộc phải có để server không bị "thoát sớm"
app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});