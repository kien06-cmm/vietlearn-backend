/**
 * lib/grading.js — GĐ 0.1 (BACKEND AN TOÀN + NỀN TẢNG)
 *
 * Toàn bộ logic THUẦN (pure — không đụng Firestore/Firebase Admin, không I/O)
 * dùng để chấm điểm và làm sạch dữ liệu câu hỏi trước khi trả cho client.
 * Được tách ra khỏi server.js với 2 mục đích:
 *
 *   1. server.js và các route (/api/submit-exam, /api/get-exam-questions,
 *      /api/get-result-detail, /api/get-review-material...) require() CHUNG
 *      1 bản logic duy nhất — sửa ở đây thì mọi nơi dùng đều được sửa theo,
 *      tránh tình trạng 2 nơi tự viết lại rồi lệch nhau (đã từng xảy ra với
 *      correct_option, xem ghi chú trong toReviewQuestionServer cũ).
 *   2. Vì không đụng Firestore/dotenv/process.exit(1) như server.js (server.js
 *      thoát tiến trình ngay khi thiếu biến môi trường Firebase), module này
 *      require() được thẳng trong file test mà KHÔNG cần mock Firebase Admin,
 *      KHÔNG cần biến môi trường nào cả.
 *
 * QUAN TRỌNG: mọi thay đổi ở đây ảnh hưởng trực tiếp tới việc chấm điểm hàng
 * loạt trên production — luôn chạy `npm test` trước khi sửa bất kỳ hàm nào
 * trong file này.
 */

/**
 * GĐ2 (migrate schema): đọc TOÀN BỘ chỉ số đáp án đúng của 1 câu hỏi, hỗ
 * trợ CẢ 3 dạng schema đang tồn tại thật trong dữ liệu:
 *  - MỚI (chuẩn): { correct_option: number | number[] | null }
 *      + number    -> 1 đáp án đúng (multiple_choice / true_false)
 *      + number[]  -> nhiều đáp án đúng cùng lúc (multiple_answer)
 *      + null      -> không xác định được đáp án đúng (essay, hoặc lỗi bóc tách)
 *  - CŨ 1: { answers: [{ text, correct: boolean }, ...] }  (dạng AI bóc tách ra)
 *  - CŨ 2: { options: string[], correctAnswer: number }     (dạng schema cũ)
 * LUÔN trả về MẢNG chỉ số (rỗng nếu không xác định được) — cho phép chấm
 * điểm dùng chung 1 logic cho cả trắc nghiệm đơn lẫn nhiều lựa chọn.
 */
function getCorrectIndicesServer(q) {
    if (Array.isArray(q.correct_option)) {
        return q.correct_option.filter((i) => typeof i === 'number');
    }
    if (typeof q.correct_option === 'number') {
        return [q.correct_option];
    }
    if (Array.isArray(q.answers)) {
        return q.answers.reduce((acc, a, i) => {
            if (a && a.correct === true) acc.push(i);
            return acc;
        }, []);
    }
    if (typeof q.correctAnswer === 'number') {
        return [q.correctAnswer];
    }
    return [];
}

/**
 * Tương thích ngược: CHỈ SỐ ĐÚNG ĐẦU TIÊN — dùng ở những chỗ cũ chỉ cần 1
 * số (vd hiển thị "correctAnswer" của câu trắc nghiệm đơn/true_false).
 * Với câu multiple_answer (nhiều đáp án đúng), dùng getCorrectIndicesServer()
 * thay vì hàm này.
 */
function getCorrectIndexServer(q) {
    const indices = getCorrectIndicesServer(q);
    return indices.length > 0 ? indices[0] : -1;
}

/**
 * Đọc danh sách text các đáp án — schema MỚI dùng "options: string[]" trực
 * tiếp; vẫn hỗ trợ schema CŨ "answers: [{text, correct}]" — dùng cho
 * /api/get-result-detail và file ôn tập để trả về danh sách đáp án đã
 * chuẩn hoá, khớp đúng cách hocsinh.js hiển thị lúc làm bài.
 */
function getOptionTextsServer(q) {
    if (Array.isArray(q.answers)) {
        return q.answers.map((a) => (a && typeof a.text === 'string') ? a.text : '');
    }
    return Array.isArray(q.options) ? q.options : [];
}

/**
 * GĐ2: xoá mọi trường chứa đáp án đúng khỏi 1 câu hỏi trước khi gửi xuống
 * client, hỗ trợ CẢ schema mới (correct_option) lẫn schema cũ
 * (answers[].correct / correctAnswer) — dùng chung cho GET/POST
 * /api/get-exam-questions và /api/preview-exam.
 */
function sanitizeQuestionForClient(q) {
    const clean = { ...q };

    // Schema MỚI: field duy nhất lộ đáp án đúng là "correct_option".
    delete clean.correct_option;

    // Schema CŨ: "answers[].correct" và "correctAnswer".
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

    // "image_url" (schema mới) — luôn trả chuỗi rỗng nếu không có ảnh, vẫn
    // đọc được "image" (schema cũ) để không vỡ dữ liệu chưa migrate.
    clean.image_url = typeof q.image_url === 'string' ? q.image_url
        : (typeof q.image === 'string' ? q.image : '');
    delete clean.image;

    return clean;
}

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
 * Xáo mảng theo Fisher-Yates, dùng PRNG (mulberry32) được seed bằng 1 chuỗi
 * cố định (examId + studentId) -> luôn ra CÙNG 1 thứ tự cho cùng 1 học sinh
 * + cùng 1 bài thi, kể cả khi họ reload lại trang giữa chừng.
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
 * Chuẩn hoá 1 câu hỏi về dạng gọn cho file ôn tập — dùng chung
 * getCorrectIndicesServer()/getOptionTextsServer() để hỗ trợ CẢ schema mới
 * (correct_option) LẪN schema cũ (answers[].correct/correctAnswer).
 */
function toReviewQuestionServer(q, includeExplanation) {
    const type = typeof q.type === 'string' ? q.type : 'multiple_choice';
    const correctIndexes = getCorrectIndicesServer(q);

    return {
        id: q.id,
        type,
        text: q.question_text || q.question || q.text || '',
        options: type === 'essay' ? [] : getOptionTextsServer(q),
        correctIndexes,
        essayAnswer: (type === 'essay' && typeof q.essayAnswer === 'string') ? q.essayAnswer : '',
        explanation: (includeExplanation && typeof q.explanation === 'string') ? q.explanation : '',
        image: typeof q.image_url === 'string' && q.image_url ? q.image_url
            : (typeof q.image === 'string' ? q.image : ''),
        score: Number(q.score) > 0 ? Number(q.score) : 1
    };
}

/**
 * *** LOGIC CHẤM ĐIỂM THẬT — dùng bởi /api/submit-exam ***
 *
 * Nhận vào:
 *   - questions: mảng câu hỏi ĐẦY ĐỦ (đã lấy thật từ Firestore, có correct_option/answers...)
 *   - safeAnswers: object { [questionId]: number | number[] } — câu trả lời học sinh gửi lên
 *     (đã ép kiểu object ở nơi gọi, xem "safeAnswers" trong server.js)
 *
 * Trả về mọi thứ cần để route ghi vào "results" và trả response — KHÔNG tự
 * ghi Firestore, KHÔNG biết gì về request/response — hoàn toàn thuần
 * (deterministic: cùng input luôn ra cùng output), nên test được trực tiếp
 * mà không cần giả lập Firebase.
 */
function gradeSubmission(questions, safeAnswers) {
    let correctCount = 0;
    let earnedPoints = 0;
    let totalPoints = 0;
    // Mảng đối chiếu ĐẦY ĐỦ — dùng cho giáo viên xem/chấm và học sinh "Xem lại".
    const details = [];
    // Các câu Tự luận / Upload file KHÔNG tự chấm được -> gom vào manualItems
    // để giáo viên chấm ở SpeedGrader (quan-ly-ket-qua).
    const manualItems = [];

    questions.forEach((q) => {
        if (isManualQuestionServer(q)) {
            manualItems.push({
                questionId: q.id,
                type: q.type,
                questionText: q.question_text || q.question || q.text || '',
                points: Number(q.score) > 0 ? Number(q.score) : 1,
                ...extractManualAnswerServer(q, safeAnswers[q.id])
            });
            return;
        }

        const points = Number(q.score) > 0 ? Number(q.score) : 1;
        totalPoints += points;

        // GĐ2: chấm điểm thống nhất cho CẢ trắc nghiệm đơn (1 đáp án đúng)
        // lẫn multiple_answer (nhiều đáp án đúng cùng lúc).
        const correctIndices = getCorrectIndicesServer(q);
        const isMultipleAnswer = q.type === 'multiple_answer';
        const rawStudentAnswer = safeAnswers[q.id];

        let studentAnswerNormalized;
        let isCorrect;
        let correctAnswerForDetail;

        if (isMultipleAnswer) {
            const studentIndices = Array.isArray(rawStudentAnswer)
                ? rawStudentAnswer.filter((i) => typeof i === 'number')
                : (typeof rawStudentAnswer === 'number' ? [rawStudentAnswer] : []);
            // Rỗng -> coi như bỏ qua (null), khớp cách tính skippedCount ở
            // /api/get-result-detail (kiểm tra studentAnswer === null).
            studentAnswerNormalized = studentIndices.length > 0 ? studentIndices : null;
            const correctSet = new Set(correctIndices);
            const studentSet = new Set(studentIndices);
            // Đúng khi và chỉ khi 2 tập hợp chỉ số GIỐNG HỆT nhau (không thiếu, không thừa).
            isCorrect = correctIndices.length > 0
                && correctSet.size === studentSet.size
                && [...correctSet].every((i) => studentSet.has(i));
            correctAnswerForDetail = correctIndices;
        } else {
            const correctIndex = correctIndices.length > 0 ? correctIndices[0] : -1;
            studentAnswerNormalized = typeof rawStudentAnswer === 'number' ? rawStudentAnswer : null;
            isCorrect = correctIndex !== -1 && studentAnswerNormalized === correctIndex;
            correctAnswerForDetail = correctIndex;
        }

        if (isCorrect) {
            correctCount += 1;
            earnedPoints += points;
        }

        details.push({
            questionId: q.id,
            studentAnswer: studentAnswerNormalized,
            correctAnswer: correctAnswerForDetail,
            isCorrect,
            points,
            explanation: typeof q.explanation === 'string' ? q.explanation : ''
        });
    });

    const totalQuestions = questions.length;
    // Có câu chấm tay -> CHƯA có điểm chính thức (score = null,
    // gradingStatus = 'pending') cho tới khi giáo viên chấm qua /api/grade-result.
    // autoScore chỉ là điểm riêng của phần trắc nghiệm, để giáo viên tham khảo.
    const hasManualItems = manualItems.length > 0;
    const gradingStatus = hasManualItems ? 'pending' : 'graded';
    const autoScore = totalPoints > 0 ? Number(((earnedPoints / totalPoints) * 10).toFixed(1)) : null;
    const score = hasManualItems ? null : (autoScore !== null ? autoScore : 0);

    return {
        correctCount,
        earnedPoints,
        totalPoints,
        details,
        manualItems,
        totalQuestions,
        hasManualItems,
        gradingStatus,
        autoScore,
        score
    };
}

module.exports = {
    getCorrectIndicesServer,
    getCorrectIndexServer,
    getOptionTextsServer,
    sanitizeQuestionForClient,
    MANUAL_QUESTION_TYPES,
    MAX_ESSAY_LENGTH,
    isManualQuestionServer,
    isAllowedUploadUrl,
    extractManualAnswerServer,
    seededShuffle,
    toReviewQuestionServer,
    gradeSubmission
};
