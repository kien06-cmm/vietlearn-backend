/**
 * lib/grading.js — logic THUẦN (không I/O) để chấm điểm và làm sạch câu hỏi trước khi trả cho client.
 * Tách khỏi server.js để các route dùng chung 1 bản logic và để test được mà không cần Firebase/biến môi trường.
 * Luôn chạy `npm test` trước khi sửa hàm nào ở đây — ảnh hưởng trực tiếp việc chấm điểm production.
 */

/**
 * Trả về MẢNG chỉ số đáp án đúng (rỗng nếu không xác định được), hỗ trợ 3 schema:
 *  - mới: correct_option (number | number[] | null)
 *  - cũ 1: answers [{ text, correct }]
 *  - cũ 2: options + correctAnswer (number)
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

/** Chỉ số đúng đầu tiên (tương thích ngược). Câu multiple_answer thì dùng getCorrectIndicesServer(). */
function getCorrectIndexServer(q) {
    const indices = getCorrectIndicesServer(q);
    return indices.length > 0 ? indices[0] : -1;
}

/** Danh sách text đáp án, hỗ trợ "options: string[]" (mới) lẫn "answers: [{text, correct}]" (cũ). */
function getOptionTextsServer(q) {
    if (Array.isArray(q.answers)) {
        return q.answers.map((a) => (a && typeof a.text === 'string') ? a.text : '');
    }
    return Array.isArray(q.options) ? q.options : [];
}

/**
 * Xoá mọi trường chứa đáp án đúng khỏi câu hỏi trước khi gửi xuống client (schema mới lẫn cũ).
 * `seed` (`${examId}_${studentId}_${questionId}`) PHẢI khớp lúc chấm — xem translateMatchingAnswer().
 * Không có seed thì ẨN HẲN matching/ordering/drag_drop thay vì gửi thô (tránh lộ đáp án).
 *  - matching: cột phải đổi `id` thật (chính là đáp án) thành `token` = vị trí sau khi xáo.
 *  - ordering: xoá correctOrder, xáo thứ tự mục (thứ tự mảng gốc chính là đáp án).
 *  - fill_blank: chỉ gửi { index }, không gửi acceptedAnswers.
 */
function sanitizeQuestionForClient(q, seed) {
    const clean = { ...q };

    delete clean.correct_option;

    // Schema cũ: answers[].correct và correctAnswer
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

    // Đáp án câu Sắp xếp và Kéo-thả (bên dưới đọc lại từ q, không phải clean)
    delete clean.correctOrder;
    delete clean.correctMap;

    const canonicalType = normalizeQuestionType(q.type);
    if (canonicalType === 'matching' && Array.isArray(clean.pairs)) {
        clean.pairs = seed ? buildMatchingView(clean.pairs, seed) : { left: [], right: [] };
    }
    if (canonicalType === 'ordering' && Array.isArray(clean.items)) {
        // Dùng q.correctOrder (bản gốc), không phải clean.correctOrder (đã xoá ở trên).
        clean.items = seed ? buildOrderingView(clean.items, seed, q.correctOrder) : [];
    }
    if (canonicalType === 'drag_drop') {
        const view = seed ? buildDragDropView(q, seed) : { dragItems: [], dropZones: [] };
        clean.dragItems = view.dragItems;
        clean.dropZones = view.dropZones;
    }
    if (canonicalType === 'fill_blank' && Array.isArray(clean.blanks)) {
        clean.blanks = clean.blanks.map((_, index) => ({ index }));
    }

    // image_url (mới), dự phòng image (cũ, chưa migrate)
    clean.image_url = typeof q.image_url === 'string' ? q.image_url
        : (typeof q.image === 'string' ? q.image : '');
    delete clean.image;

    return clean;
}

/** Loại câu hỏi KHÔNG thể tự chấm, phải chờ giáo viên chấm (SpeedGrader). */
const MANUAL_QUESTION_TYPES = ['essay', 'upload'];

// (GĐ3.7B) Logic chấm / dựng dữ liệu "Xem lại" / file ôn tập của câu Kéo-thả nằm ở lib/dragdrop.js.
const {
    gradeDragDrop,
    buildDragDropResultView,
    buildDragDropTexts,
    buildDragDropReview
} = require('./dragdrop');

// Alias tên hiển thị -> type thật lưu trong Firestore (không đổi giá trị đã lưu).
// Luôn so sánh loại câu hỏi qua normalizeQuestionType(), không so thẳng q.type.
const TYPE_ALIASES = {
    multi_select: 'multiple_answer',
    open_ended: 'essay'
};

/** Trả về type THẬT (canonical) của 1 câu hỏi — giải alias nếu có. */
function normalizeQuestionType(type) {
    return TYPE_ALIASES[type] || type;
}

/** Giới hạn độ dài bài tự luận lưu vào results (document Firestore tối đa 1MB). */
const MAX_ESSAY_LENGTH = 20000;

function isManualQuestionServer(q) {
    return !!q && MANUAL_QUESTION_TYPES.includes(normalizeQuestionType(q && q.type));
}

/** Chỉ chấp nhận link https trên Cloudinary, để học sinh không nhét link lạ (javascript:...) cho giáo viên bấm khi chấm. */
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

/** Lấy câu trả lời câu chấm tay từ answers[questionId]; chấp nhận chuỗi thuần hoặc object. */
function extractManualAnswerServer(q, rawAnswer) {
    const asObject = (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) ? rawAnswer : null;

    if (normalizeQuestionType(q.type) === 'essay') {
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

/** Xáo Fisher-Yates với PRNG (mulberry32) seed theo chuỗi: cùng seed luôn ra cùng thứ tự (reload không đổi). */
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

/** Các mục câu Sắp xếp theo ĐÚNG thứ tự đáp án ([{id,text}]); dùng correctOrder, dự phòng thứ tự mảng items (như gradeOrdering). */
function getOrderedItemsServer(q) {
    const items = Array.isArray(q.items) ? q.items : [];
    const byId = {};
    items.forEach((it) => {
        if (it && it.id !== undefined && it.id !== null) byId[it.id] = it;
    });
    const ids = (Array.isArray(q.correctOrder) && q.correctOrder.length > 0)
        ? q.correctOrder
        : items.map((it) => (it ? it.id : undefined));
    return ids.map((id) => ({
        id,
        text: (byId[id] && typeof byId[id].text === 'string') ? byId[id].text : ''
    }));
}

/** Chuẩn hoá 1 câu hỏi về dạng gọn cho file ôn tập (hỗ trợ cả schema mới và cũ). Câu Sắp xếp có thêm "orderedItems". */
function toReviewQuestionServer(q, includeExplanation) {
    const type = typeof q.type === 'string' ? q.type : 'multiple_choice';
    const correctIndexes = getCorrectIndicesServer(q);

    const review = {
        id: q.id,
        type,
        text: q.question_text || q.question || q.text || '',
        options: normalizeQuestionType(type) === 'essay' ? [] : getOptionTextsServer(q),
        correctIndexes,
        essayAnswer: (normalizeQuestionType(type) === 'essay' && typeof q.essayAnswer === 'string') ? q.essayAnswer : '',
        explanation: (includeExplanation && typeof q.explanation === 'string') ? q.explanation : '',
        image: typeof q.image_url === 'string' && q.image_url ? q.image_url
            : (typeof q.image === 'string' ? q.image : ''),
        score: Number(q.score) > 0 ? Number(q.score) : 1
    };

    if (normalizeQuestionType(type) === 'ordering') {
        review.orderedItems = getOrderedItemsServer(q);
    }
    if (normalizeQuestionType(type) === 'drag_drop') {
        // (GĐ3.7B) dragDropPairs [{label,text}] + dragDropDistractors [text] — xem lib/dragdrop.js
        Object.assign(review, buildDragDropReview(q));
    }
    return review;
}

/** Chuẩn hoá đáp án điền-chỗ-trống để so sánh. PHẢI khớp normalizeBlankAnswer() trong frontend/core/gradebook-engine.js, nếu không điểm chính thức và màn Xem lại sẽ lệch nhau. */
function normalizeBlankAnswerServer(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Chấm "fill_blank": so từng ô với acceptedAnswers (không phân biệt hoa/thường, dấu). Điểm từng phần = ô đúng / tổng ô.
 * Học sinh nộp MẢNG chuỗi theo thứ tự chỗ trống (không phải object); field đáp án là "acceptedAnswers" (camelCase).
 * `skipped` = true khi không điền ô nào. Sửa hàm này phải chạy `npm test` (tests/grading.test.js).
 */
function gradeFillBlank(q, rawStudentAnswer) {
    const blanks = Array.isArray(q.blanks) ? q.blanks : [];
    const studentList = Array.isArray(rawStudentAnswer) ? rawStudentAnswer : [];
    const skipped = !studentList.some((v) => typeof v === 'string' && v.trim() !== '');

    if (blanks.length === 0) return { fraction: 0, studentAnswerNormalized: studentList, correctAnswerForDetail: [], skipped };

    let correctBlanks = 0;
    blanks.forEach((blank, i) => {
        const accepted = Array.isArray(blank.acceptedAnswers) ? blank.acceptedAnswers : [];
        const studentText = typeof studentList[i] === 'string' ? studentList[i] : '';
        const normalizedStudent = normalizeBlankAnswerServer(studentText);
        if (normalizedStudent && accepted.some((a) => normalizeBlankAnswerServer(a) === normalizedStudent)) {
            correctBlanks += 1;
        }
    });

    return {
        fraction: correctBlanks / blanks.length,
        studentAnswerNormalized: studentList,
        correctAnswerForDetail: blanks.map((b, i) => ({
            index: i,
            acceptedAnswers: Array.isArray(b.acceptedAnswers) ? b.acceptedAnswers : []
        })),
        skipped
    };
}

/**
 * Chấm "matching": left/right cùng "id" trong q.pairs là 1 cặp đúng. Học sinh nộp { [leftId]: rightId }.
 * Điểm từng phần = cặp đúng / tổng cặp. `skipped` = true khi không ghép cặp nào.
 */
function gradeMatching(q, rawStudentAnswer) {
    const pairs = Array.isArray(q.pairs) ? q.pairs : [];
    const studentMap = (rawStudentAnswer && typeof rawStudentAnswer === 'object' && !Array.isArray(rawStudentAnswer))
        ? rawStudentAnswer : {};
    const skipped = Object.keys(studentMap).length === 0;

    if (pairs.length === 0) return { fraction: 0, studentAnswerNormalized: studentMap, correctAnswerForDetail: [], skipped };

    let correctPairs = 0;
    pairs.forEach((pair) => {
        // Đúng khi học sinh ghép đúng leftId -> chính id của cặp đó (right thuộc đúng cặp).
        if (String(studentMap[pair.id]) === String(pair.id)) correctPairs += 1;
    });

    return {
        fraction: correctPairs / pairs.length,
        studentAnswerNormalized: studentMap,
        correctAnswerForDetail: pairs.map((p) => ({ id: p.id, left: p.left, right: p.right })),
        skipped
    };
}

/** (GĐ3.6.9) { [id]: text } của mọi mục trong câu Sắp xếp (mục thiếu id bị bỏ qua, text thiếu -> ''). */
function buildOrderingItemTexts(q) {
    const texts = {};
    (Array.isArray(q && q.items) ? q.items : []).forEach((it) => {
        if (it && it.id !== undefined && it.id !== null) {
            texts[it.id] = typeof it.text === 'string' ? it.text : '';
        }
    });
    return texts;
}

/** (GĐ3.6.9) `order` có đúng là 1 hoán vị của `ids` không (cùng số phần tử, không trùng, không id lạ). */
function isPermutationOfIds(order, ids) {
    if (!Array.isArray(order) || !Array.isArray(ids) || order.length !== ids.length) return false;
    const expected = new Set(ids.map((id) => String(id)));
    const seen = new Set();
    for (const id of order) {
        const key = String(id);
        if (!expected.has(key) || seen.has(key)) return false;
        seen.add(key);
    }
    return seen.size === expected.size;
}

/**
 * Dữ liệu "Xem lại" câu Sắp xếp cho ketqua.js, từ câu hỏi thật `q` và 1 phần tử `d` của results.details. Trả về:
 *   items            : text các mục theo đúng thứ tự chuẩn
 *   studentPositions : với mỗi vị trí học sinh xếp, vị trí chuẩn của id đó (-1 nếu id lạ; [] nếu bỏ qua)
 */
function buildOrderingResultView(q, d) {
    const correctIds = Array.isArray(d && d.correctAnswer) ? d.correctAnswer : [];
    const textById = {};
    (Array.isArray(q && q.items) ? q.items : []).forEach((it) => {
        if (it && it.id !== undefined && it.id !== null) textById[it.id] = it.text;
    });
    const items = correctIds.map((id) => (typeof textById[id] === 'string' ? textById[id] : ''));

    const positionById = {};
    correctIds.forEach((id, pos) => { positionById[id] = pos; });
    const studentIds = Array.isArray(d && d.studentAnswer) ? d.studentAnswer : [];
    const studentPositions = studentIds.map((id) => (typeof positionById[id] === 'number' ? positionById[id] : -1));

    return { items, studentPositions };
}

/**
 * Chấm "ordering": học sinh nộp mảng id đã sắp xếp. Điểm từng phần = số vị trí đúng / tổng số mục (so từng vị trí 1-1).
 * Đáp án đúng lấy từ correctOrder (tách riêng khỏi thứ tự mảng "items" để giáo viên sửa items không đổi đáp án);
 * dữ liệu cũ chưa có correctOrder thì dự phòng bằng thứ tự mảng items.
 * Không gửi gì / mảng rỗng -> `skipped: true` (phân biệt với sắp sai).
 */
function gradeOrdering(q, rawStudentAnswer) {
    const items = Array.isArray(q.items) ? q.items : [];
    const studentOrder = Array.isArray(rawStudentAnswer) ? rawStudentAnswer : [];

    const correctIds = (Array.isArray(q.correctOrder) && q.correctOrder.length > 0)
        ? q.correctOrder
        : items.map((i) => i.id);

    if (studentOrder.length === 0) {
        return { fraction: 0, studentAnswerNormalized: null, correctAnswerForDetail: correctIds, skipped: true };
    }

    if (correctIds.length === 0) {
        return { fraction: 0, studentAnswerNormalized: studentOrder, correctAnswerForDetail: [], skipped: false };
    }

    // Câu trả lời phải là hoán vị đúng của tập id đáp án. Client thật luôn gửi đủ nên
    // mảng thiếu/trùng/lạ chỉ đến từ việc sửa request -> 0 điểm, không phải "bỏ qua".
    if (!isPermutationOfIds(studentOrder, correctIds)) {
        return { fraction: 0, studentAnswerNormalized: studentOrder, correctAnswerForDetail: correctIds, skipped: false };
    }

    let correctPositions = 0;
    correctIds.forEach((id, index) => {
        if (String(studentOrder[index]) === String(id)) correctPositions += 1;
    });

    return {
        fraction: correctPositions / correctIds.length,
        studentAnswerNormalized: studentOrder,
        correctAnswerForDetail: correctIds,
        skipped: false
    };
}

/**
 * Xáo cột phải của câu ghép đôi và thay `id` thật (lộ đáp án) bằng `token` = vị trí sau khi xáo.
 * `seed` PHẢI giống hệt lúc chấm điểm (xem translateMatchingAnswer()).
 */
function buildMatchingView(pairs, seed) {
    const list = Array.isArray(pairs) ? pairs : [];
    const shuffledRight = seededShuffle(list, `${seed}:right`);
    return {
        left: list.map((p) => ({ id: p.id, text: p.left })),
        right: shuffledRight.map((p, i) => ({ token: i, text: p.right }))
    };
}

/**
 * Xáo các mục câu sắp xếp trước khi gửi cho học sinh (thứ tự mảng gốc chính là đáp án).
 * Nếu kết quả xáo tình cờ trùng thứ tự đúng (hay xảy ra với câu ít mục) thì xoay 1 vị trí — xác định,
 * cùng seed luôn ra cùng kết quả nên F5 không đổi thứ tự. `correctOrder` thiếu thì dùng thứ tự mảng `items`.
 */
function buildOrderingView(items, seed, correctOrder) {
    const list = Array.isArray(items) ? items : [];
    const correctIds = (Array.isArray(correctOrder) && correctOrder.length > 0)
        ? correctOrder
        : list.map((it) => it.id);

    let view = seededShuffle(list, seed);

    const isSameAsCorrect = view.length > 1
        && view.length === correctIds.length
        && view.every((it, i) => String(it.id) === String(correctIds[i]));
    if (isSameAsCorrect) {
        view = view.slice(1).concat(view[0]);
    }

    return view.map((it) => ({ id: it.id, text: it.text }));
}

/**
 * Bản câu "Kéo-thả" gửi cho học sinh. Schema: dragItems [{id,text}] (có thể có thẻ gây nhiễu),
 * dropZones [{id,label}], correctMap { [zoneId]: itemId } (đáp án, không bao giờ gửi xuống client).
 * Thứ tự dragItems thường trùng thứ tự ô nên xáo theo seed cố định, và xoay vòng nếu các thẻ đúng
 * tình cờ trùng thứ tự ô (giống buildOrderingView()).
 */
function buildDragDropView(q, seed) {
    const items = (Array.isArray(q && q.dragItems) ? q.dragItems : []).filter((it) => it && it.id !== undefined && it.id !== null);
    const zones = (Array.isArray(q && q.dropZones) ? q.dropZones : []).filter((z) => z && z.id !== undefined && z.id !== null);
    const map = (q && q.correctMap && typeof q.correctMap === 'object' && !Array.isArray(q.correctMap)) ? q.correctMap : {};

    const mappedIdsInZoneOrder = zones.map((z) => map[z.id]).filter((id) => id !== undefined && id !== null).map(String);
    const mappedSet = new Set(mappedIdsInZoneOrder);

    let view = seededShuffle(items, `${seed}:drag`);

    if (mappedIdsInZoneOrder.length > 1) {
        const sameAsCorrect = (list) => {
            const sub = list.filter((it) => mappedSet.has(String(it.id))).map((it) => String(it.id));
            return sub.length === mappedIdsInZoneOrder.length && sub.every((id, i) => id === mappedIdsInZoneOrder[i]);
        };
        for (let i = 0; i < view.length && sameAsCorrect(view); i++) {
            view = view.slice(1).concat(view[0]);
        }
    }

    return {
        dragItems: view.map((it) => ({ id: it.id, text: typeof it.text === 'string' ? it.text : '' })),
        dropZones: zones.map((z) => ({ id: z.id, label: typeof z.label === 'string' ? z.label : '' }))
    };
}

/**
 * Học sinh nộp { [leftId]: rightToken } (token = vị trí trong cột phải đã xáo). Dịch ngược token -> `id` thật
 * bằng cách xáo lại q.pairs với ĐÚNG seed lúc gửi, để gradeMatching() nhận { [leftId]: rightId }.
 * Seed lệch sẽ dịch sai toàn bộ câu trả lời.
 */
function translateMatchingAnswer(q, rawAnswer, seed) {
    const pairs = Array.isArray(q.pairs) ? q.pairs : [];
    const studentMap = (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) ? rawAnswer : {};
    const shuffledRight = seededShuffle(pairs, `${seed}:right`);

    const translated = {};
    Object.keys(studentMap).forEach((leftId) => {
        const rawToken = studentMap[leftId];
        if (typeof rawToken !== 'string' && typeof rawToken !== 'number') return;
        if (typeof rawToken === 'string' && rawToken.trim() === '') return;
        const token = Number(rawToken);
        if (Number.isInteger(token) && shuffledRight[token]) {
            translated[leftId] = shuffledRight[token].id;
        }
    });
    return translated;
}

/**
 * Logic chấm điểm thật, dùng bởi /api/submit-exam. Thuần (không ghi Firestore, cùng input luôn ra cùng output).
 *   - questions: mảng câu hỏi đầy đủ từ Firestore (có đáp án)
 *   - safeAnswers: { [questionId]: câu trả lời học sinh gửi lên }
 * Trả về mọi thứ route cần để ghi vào "results" và trả response.
 */
function gradeSubmission(questions, safeAnswers) {
    let correctCount = 0;
    let earnedPoints = 0;
    let totalPoints = 0;
    // Đối chiếu đầy đủ, cho giáo viên chấm và học sinh "Xem lại"
    const details = [];
    // Câu Tự luận / Upload không tự chấm được -> giáo viên chấm ở quan-ly-ket-qua
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

        const canonicalType = normalizeQuestionType(q.type);

        // 4 loại này không có correct_option dạng số nên PHẢI tách nhánh riêng, nếu không sẽ luôn bị chấm sai.
        // Cho điểm từng phần theo tỉ lệ đúng.
        if (canonicalType === 'fill_blank' || canonicalType === 'matching' || canonicalType === 'ordering' || canonicalType === 'drag_drop') {
            const grader = canonicalType === 'fill_blank' ? gradeFillBlank
                : canonicalType === 'matching' ? gradeMatching
                : canonicalType === 'drag_drop' ? gradeDragDrop
                : gradeOrdering;
            const { fraction, studentAnswerNormalized, correctAnswerForDetail, skipped } = grader(q, safeAnswers[q.id]);
            const earned = points * fraction;
            earnedPoints += earned;
            if (fraction === 1) correctCount += 1;

            details.push({
                questionId: q.id,
                studentAnswer: studentAnswerNormalized,
                correctAnswer: correctAnswerForDetail,
                isCorrect: fraction === 1,
                skipped: skipped === true,
                partialFraction: fraction,
                points,
                earnedPoints: earned,
                explanation: typeof q.explanation === 'string' ? q.explanation : '',
                // Sắp xếp / Kéo-thả: details chỉ lưu id nên lưu kèm ảnh chụp chữ lúc chấm, để màn Xem lại và
                // Quản lý kết quả hiện được nội dung, và giáo viên sửa câu về sau không làm lệch bài đã nộp.
                ...(canonicalType === 'ordering' ? { itemTexts: buildOrderingItemTexts(q) } : {}),
                ...(canonicalType === 'drag_drop' ? { dragTexts: buildDragDropTexts(q) } : {})
            });
            return; // đã xử lý xong câu này, bỏ qua toàn bộ nhánh trắc nghiệm bên dưới
        }

        // Trắc nghiệm đơn và multiple_answer chấm chung
        const correctIndices = getCorrectIndicesServer(q);
        const isMultipleAnswer = canonicalType === 'multiple_answer';
        const rawStudentAnswer = safeAnswers[q.id];

        let studentAnswerNormalized;
        let isCorrect;
        let correctAnswerForDetail;

        if (isMultipleAnswer) {
            const studentIndices = Array.isArray(rawStudentAnswer)
                ? rawStudentAnswer.filter((i) => typeof i === 'number')
                : (typeof rawStudentAnswer === 'number' ? [rawStudentAnswer] : []);
            // Rỗng -> bỏ qua (null), khớp cách tính skippedCount ở /api/get-result-detail
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
    // Đúng / Bỏ qua / Sai (câu chấm tay không nằm trong details nên không tính)
    const skippedCount = details.filter(
        (d) => d.skipped === true || d.studentAnswer === null || d.studentAnswer === undefined
    ).length;
    const incorrectCount = Math.max(0, details.length - correctCount - skippedCount);
    // Có câu chấm tay -> chưa có điểm chính thức (score = null, 'pending') tới khi giáo viên chấm qua
    // /api/grade-result; autoScore chỉ là điểm phần tự chấm, để tham khảo.
    const hasManualItems = manualItems.length > 0;
    const gradingStatus = hasManualItems ? 'pending' : 'graded';
    const autoScore = totalPoints > 0 ? Number(((earnedPoints / totalPoints) * 10).toFixed(1)) : null;
    const score = hasManualItems ? null : (autoScore !== null ? autoScore : 0);

    return {
        correctCount,
        skippedCount,
        incorrectCount,
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
    gradeSubmission,
    normalizeQuestionType,
    gradeFillBlank,
    gradeMatching,
    gradeOrdering,
    buildOrderingResultView,
    buildMatchingView,
    buildOrderingView,
    buildDragDropView,
    gradeDragDrop,
    buildDragDropResultView,
    buildDragDropTexts,
    translateMatchingAnswer
};
