'use strict';

/**
 * tests/ketqua-result.test.js — GĐ3.8A-4 (kiểm tra kết quả học sinh)
 *
 * Phần 1 — routes/result.js (/api/get-result-detail): dựng kết quả THẬT bằng gradeSubmission(), gọi handler của router
 *          với dbAdmin giả, kiểm tra payload cho đáp án đúng / sai / nhiều đáp án / object / array / bỏ qua.
 * Phần 2 — pages/hocsinh/ketqua.js (evaluateQuestion + render thẻ câu hỏi): nạp file thật vào vm với DOM giả
 *          (file gốc là ES module dùng Firebase qua URL nên không import thẳng được). Bỏ qua phần này nếu không có thư mục frontend.
 * Phần 3 — nối 2 phần: payload của server -> thẻ render của client.
 *
 * Chạy:  npm test   (hoặc: node --test tests)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { gradeSubmission } = require('../lib/grading');
const { createResultRouter } = require('../routes/result');

/* ==========================================================================
   DỮ LIỆU MẪU: 6 loại câu hỏi
   ========================================================================== */

function makeQuestions() {
    return [
        { id: 'q_mc', type: 'multiple_choice', question_text: '1 + 1 = ?', options: ['1', '2', '3'], correct_option: 1, score: 1, explanation: 'Cộng hai số.' },
        { id: 'q_multi', type: 'multiple_answer', question_text: 'Chọn số chẵn', options: ['2', '4', '5', '7'], correct_option: [0, 1], score: 1 },
        {
            id: 'q_fill', type: 'fill_blank', question_text: 'Thủ đô VN là ___, thủ đô Pháp là ___', score: 1,
            blanks: [{ acceptedAnswers: ['Hà Nội'] }, { acceptedAnswers: ['Paris', 'paris'] }]
        },
        {
            id: 'q_match', type: 'matching', question_text: 'Ghép đôi', score: 1,
            pairs: [{ id: 'p1', left: 'Việt Nam', right: 'Hà Nội' }, { id: 'p2', left: 'Pháp', right: 'Paris' }]
        },
        {
            id: 'q_order', type: 'ordering', question_text: 'Sắp xếp', score: 1,
            items: [{ id: 'a', text: 'Bước A' }, { id: 'b', text: 'Bước B' }, { id: 'c', text: 'Bước C' }],
            correctOrder: ['a', 'b', 'c']
        },
        {
            id: 'q_dd', type: 'drag_drop', question_text: 'Kéo thả', score: 1,
            dropZones: [{ id: 'z1', label: 'Việt Nam' }, { id: 'z2', label: 'Pháp' }, { id: 'z3', label: 'Nhật Bản' }],
            dragItems: [{ id: 'i1', text: 'Hà Nội' }, { id: 'i2', text: 'Paris' }, { id: 'i3', text: 'Tokyo' }, { id: 'i4', text: 'Bangkok' }],
            correctMap: { z1: 'i1', z2: 'i2', z3: 'i3' }
        }
    ];
}

const ANSWERS_RIGHT = {
    q_mc: 1,
    q_multi: [0, 1],
    q_fill: ['ha noi', 'PARIS'],
    q_match: { p1: 'p1', p2: 'p2' },
    q_order: ['a', 'b', 'c'],
    q_dd: { z1: 'i1', z2: 'i2', z3: 'i3' }
};

const ANSWERS_WRONG = {
    q_mc: 0,
    q_multi: [0, 2],
    q_fill: ['sai', 'paris'],
    q_match: { p1: 'p2', p2: 'p1' },
    q_order: ['b', 'a', 'c'],
    q_dd: { z1: 'i2', z2: 'i1' }
};

const ANSWERS_EMPTY = {
    q_mc: undefined,
    q_multi: [],
    q_fill: [],
    q_match: {},
    q_order: [],
    q_dd: {}
};

/* ==========================================================================
   GỌI HANDLER /get-result-detail VỚI DB GIẢ
   ========================================================================== */

const EXAM_OPEN = { showScoreImmediately: true, showCorrectAnswers: true, showExplanation: true };

async function callGetResultDetail({ answers, questions = makeQuestions(), bankQuestions = questions, exam = EXAM_OPEN, mutateResult }) {
    const graded = gradeSubmission(questions, answers);
    const resultData = {
        student_id: 'stu1',
        exam_id: 'exam1',
        quizName: 'Bài thử',
        gradingStatus: graded.gradingStatus,
        score: graded.score,
        totalQuestions: graded.totalQuestions,
        correctCount: graded.correctCount,
        details: graded.details,
        manualItems: graded.manualItems
    };
    if (mutateResult) mutateResult(resultData);

    const store = {
        results: { r1: resultData },
        exams: { exam1: exam }
    };
    const dbAdmin = {
        collection: (name) => ({
            doc: (id) => ({
                get: async () => {
                    const data = store[name] && store[name][id];
                    return { exists: !!data, data: () => data };
                }
            })
        })
    };
    const examHelpers = {
        fetchQuestionsByIds: async (ids) => bankQuestions.filter((q) => ids.includes(q.id)),
        checkReviewDownloadAccess: async () => ({ ok: true })
    };

    const router = createResultRouter({ dbAdmin, verifyFirebaseToken: (req, res, next) => next(), examHelpers });
    const layer = router.stack.find((l) => l.route && l.route.path === '/get-result-detail');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        set() { return this; }
    };
    await handler({ uid: 'stu1', body: { result_id: 'r1' } }, res);
    return res;
}

function byId(payload) {
    const map = {};
    payload.questions.forEach((q) => { map[q.id] = q; });
    return map;
}

/* ==========================================================================
   PHẦN 1 — routes/result.js
   ========================================================================== */

test('get-result-detail — đáp án ĐÚNG ở cả 6 loại câu', async () => {
    const res = await callGetResultDetail({ answers: ANSWERS_RIGHT });
    assert.equal(res.statusCode, 200);
    const p = res.body;
    assert.equal(p.correctCount, 6);
    assert.equal(p.incorrectCount, 0);
    assert.equal(p.skippedCount, 0);

    const q = byId(p);
    Object.values(q).forEach((item) => assert.equal(item.isCorrect, true, `${item.id} phải đúng`));
    assert.deepEqual(q.q_multi.studentAnswer, [0, 1]);
    assert.deepEqual(q.q_multi.correctAnswer, [0, 1]);
    assert.equal(q.q_mc.studentAnswer, 1);
    assert.deepEqual(q.q_order.items, ['Bước A', 'Bước B', 'Bước C']);
    assert.deepEqual(q.q_order.studentPositions, [0, 1, 2]);
    assert.equal(q.q_match.pairs.every((pair) => pair.isCorrect), true);
    assert.equal(q.q_dd.zones.every((zone) => zone.isCorrect && zone.placed), true);
});

test('get-result-detail — đáp án SAI: không câu nào đúng hoàn toàn, không bị tính "bỏ qua"', async () => {
    const res = await callGetResultDetail({ answers: ANSWERS_WRONG });
    const p = res.body;
    assert.equal(p.correctCount, 0);
    assert.equal(p.skippedCount, 0);
    assert.equal(p.incorrectCount, 6);

    const q = byId(p);
    assert.equal(q.q_mc.studentAnswer, 0);              // chỉ số 0 KHÔNG bị coi là rỗng
    assert.deepEqual(q.q_multi.studentAnswer, [0, 2]);  // nhiều đáp án: giữ nguyên MẢNG
    assert.deepEqual(q.q_fill.studentAnswer, ['sai', 'paris']);
    assert.deepEqual(q.q_fill.blanks, [{ acceptedAnswers: ['Hà Nội'] }, { acceptedAnswers: ['Paris', 'paris'] }]);
    assert.deepEqual(q.q_order.studentPositions, [1, 0, 2]);
    assert.equal(q.q_match.pairs.every((pair) => pair.isCorrect === false), true);
    assert.equal(q.q_match.pairs[0].studentRight, 'Paris');
    assert.equal(q.q_dd.zones[0].studentText, 'Paris');
    assert.equal(q.q_dd.zones[2].placed, false);
});

test('get-result-detail — BỎ QUA hết: đếm đúng 6 câu bỏ qua, không tính vào sai', async () => {
    const res = await callGetResultDetail({ answers: ANSWERS_EMPTY });
    const p = res.body;
    assert.equal(p.skippedCount, 6);
    assert.equal(p.incorrectCount, 0);
    assert.equal(p.correctCount, 0);
    const q = byId(p);
    assert.equal(q.q_mc.studentAnswer, null);
    assert.equal(q.q_multi.studentAnswer, null);
    assert.deepEqual(q.q_order.studentPositions, []);
});

test('get-result-detail — dữ liệu cũ lưu studentAnswer = [] / "" / [""] vẫn đếm là bỏ qua', async () => {
    const res = await callGetResultDetail({
        answers: ANSWERS_RIGHT,
        mutateResult: (r) => {
            r.correctCount = 0;
            r.details = [
                { questionId: 'q_multi', studentAnswer: [], correctAnswer: [0, 1], isCorrect: false },
                { questionId: 'q_mc', studentAnswer: '', correctAnswer: 1, isCorrect: false },
                { questionId: 'q_fill', studentAnswer: ['', ' '], correctAnswer: [], isCorrect: false },
                { questionId: 'q_order', studentAnswer: 0, correctAnswer: 0, isCorrect: false }   // chỉ số 0: KHÔNG phải bỏ qua
            ];
            r.totalQuestions = 4;
        }
    });
    assert.equal(res.body.skippedCount, 3);
    assert.equal(res.body.incorrectCount, 1);
});

test('get-result-detail — ảnh chụp chữ lúc chấm: sửa/xoá câu Sắp xếp & Kéo-thả sau khi nộp không làm lệch bài', async () => {
    const original = makeQuestions();
    const edited = makeQuestions();
    edited[4].items = edited[4].items.map((it) => ({ ...it, text: `ĐÃ SỬA ${it.id}` }));
    edited[5].dropZones = edited[5].dropZones.map((z) => ({ ...z, label: `ĐÃ SỬA ${z.id}` }));

    const afterEdit = (await callGetResultDetail({ answers: ANSWERS_WRONG, questions: original, bankQuestions: edited })).body;
    const q = byId(afterEdit);
    assert.deepEqual(q.q_order.items, ['Bước A', 'Bước B', 'Bước C']);
    assert.equal(q.q_dd.zones[0].label, 'Việt Nam');

    // Câu hỏi bị xoá hẳn khỏi ngân hàng: vẫn dựng đúng thẻ Sắp xếp / Kéo-thả từ details.
    const deleted = (await callGetResultDetail({
        answers: ANSWERS_WRONG,
        questions: original,
        bankQuestions: original.filter((x) => x.id !== 'q_order' && x.id !== 'q_dd')
    })).body;
    const d = byId(deleted);
    assert.equal(d.q_order.type, 'ordering');
    assert.deepEqual(d.q_order.items, ['Bước A', 'Bước B', 'Bước C']);
    assert.equal(d.q_dd.type, 'drag_drop');
    assert.equal(d.q_dd.zones[0].label, 'Việt Nam');
    assert.equal(d.q_dd.zones[0].correctText, 'Hà Nội');
});

test('get-result-detail — alias multi_select được trả về là multiple_answer', async () => {
    const questions = makeQuestions();
    questions[1] = { ...questions[1], type: 'multi_select' };
    const res = await callGetResultDetail({ answers: ANSWERS_RIGHT, questions });
    assert.equal(byId(res.body).q_multi.type, 'multiple_answer');
});

test('get-result-detail — giáo viên tắt "hiện đáp án": KHÔNG có questions, không lộ đáp án', async () => {
    const res = await callGetResultDetail({
        answers: ANSWERS_WRONG,
        exam: { showScoreImmediately: true, showCorrectAnswers: false, showExplanation: false }
    });
    assert.equal(res.body.scoreVisible, true);
    assert.equal(res.body.questionsVisible, false);
    assert.equal('questions' in res.body, false);
    const text = JSON.stringify(res.body);
    assert.equal(text.includes('acceptedAnswers'), false);
    assert.equal(text.includes('correctAnswer'), false);
});

test('get-result-detail — tắt lời giải: không có explanation trong từng câu', async () => {
    const res = await callGetResultDetail({
        answers: ANSWERS_RIGHT,
        exam: { showScoreImmediately: true, showCorrectAnswers: true, showExplanation: false }
    });
    Object.values(byId(res.body)).forEach((item) => assert.equal('explanation' in item, false));
});

/* ==========================================================================
   PHẦN 2 — pages/hocsinh/ketqua.js (nạp vào vm)
   ========================================================================== */

const FRONTEND_ROOT = path.join(__dirname, '..', '..', 'vietlearn-frontend');
const KETQUA_PATH = path.join(FRONTEND_ROOT, 'pages', 'hocsinh', 'ketqua.js');
const ENGINE_PATH = path.join(FRONTEND_ROOT, 'core', 'gradebook-engine.js');
const FRONTEND_AVAILABLE = fs.existsSync(KETQUA_PATH) && fs.existsSync(ENGINE_PATH);
const SKIP_FRONTEND = FRONTEND_AVAILABLE ? false : 'không thấy thư mục vietlearn-frontend cạnh vietlearn-backend';

function loadKetqua() {
    const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8').replace(/^export\s+/gm, '');
    const pageSrc = fs.readFileSync(KETQUA_PATH, 'utf8').replace(/^import\s.*$/gm, '');
    const expose = `
;globalThis.__k = {
    evaluateQuestion, renderQuestionCard, optionMatches, isEmptyAnswer,
    evaluateFillBlankQuestion, toBlankAnswerList, normalizeOption
};`;

    const escapeText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const makeEl = () => {
        const el = { className: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } };
        Object.defineProperty(el, 'textContent', {
            set(v) { el.innerHTML = escapeText(v == null ? '' : v); },
            get() { return el.innerHTML; }
        });
        return el;
    };
    const context = vm.createContext({
        console,
        URLSearchParams,
        fetch: () => { throw new Error('không gọi mạng trong test'); },
        window: { location: { search: '' } },
        document: {
            createElement: makeEl,
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            head: { appendChild() {} }
        }
    });
    new vm.Script(`${engineSrc}\n${pageSrc}${expose}`, { filename: 'ketqua.js(vm)' }).runInContext(context);
    return context.__k;
}

let K = null;
function k() {
    if (!K) K = loadKetqua();
    return K;
}

function optClass(html, letter) {
    const m = html.match(new RegExp(`<div class="([^"]*)">\\s*<span class="xkq2-opt__label">${letter}</span>`));
    return m ? m[1] : null;
}

const OPTS4 = ['A', 'B', 'C', 'D'];
const status = (q) => k().evaluateQuestion(q).status;

test('ketqua.evaluateQuestion — đáp án đúng / sai', { skip: SKIP_FRONTEND }, () => {
    assert.equal(status({ options: OPTS4, studentAnswer: 1, correctAnswer: 1 }), 'correct');
    assert.equal(status({ options: OPTS4, studentAnswer: 0, correctAnswer: 1 }), 'wrong');
    assert.equal(status({ options: OPTS4, studentAnswer: 0, correctAnswer: 0 }), 'correct');        // chỉ số 0 hợp lệ
    assert.equal(status({ options: OPTS4, studentAnswer: 0, correctAnswer: 1, isCorrect: false }), 'wrong');
    assert.equal(status({ options: OPTS4, studentAnswer: 1, correctAnswer: 1, isCorrect: true }), 'correct');
    assert.equal(status({ options: OPTS4, studentAnswer: 1, correctAnswer: -1 }), 'wrong');          // server không gửi đáp án đúng
});

test('ketqua.evaluateQuestion — bỏ qua: null / undefined / "" / "  " / [] / {} / [null, ""]', { skip: SKIP_FRONTEND }, () => {
    [null, undefined, '', '  ', [], {}, [null, '']].forEach((empty) => {
        assert.equal(status({ options: OPTS4, studentAnswer: empty, correctAnswer: 1 }), 'skipped');
    });
    assert.equal(status({ options: OPTS4, studentAnswer: 1, correctAnswer: 1, skipped: true }), 'skipped');
});

test('ketqua.evaluateQuestion — nhiều đáp án: phải GIỐNG HỆT tập đúng (không thiếu, không thừa)', { skip: SKIP_FRONTEND }, () => {
    assert.equal(status({ options: OPTS4, studentAnswer: [0, 1], correctAnswer: [0, 1] }), 'correct');
    assert.equal(status({ options: OPTS4, studentAnswer: [1, 0], correctAnswer: [0, 1] }), 'correct');   // không phụ thuộc thứ tự
    assert.equal(status({ options: OPTS4, studentAnswer: [0], correctAnswer: [0, 1] }), 'wrong');        // thiếu
    assert.equal(status({ options: OPTS4, studentAnswer: [0, 1, 2], correctAnswer: [0, 1] }), 'wrong');  // thừa
    assert.equal(status({ options: OPTS4, studentAnswer: [0, 2], correctAnswer: [0, 1] }), 'wrong');
});

test('ketqua.evaluateQuestion — object answer', { skip: SKIP_FRONTEND }, () => {
    const withIds = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
    assert.equal(status({ options: withIds, studentAnswer: { id: 'b' }, correctAnswer: 'b' }), 'correct');
    assert.equal(status({ options: withIds, studentAnswer: { id: 'a' }, correctAnswer: { id: 'b' } }), 'wrong');
    assert.equal(status({ options: OPTS4, studentAnswer: { index: 2 }, correctAnswer: { index: 2 } }), 'correct');
    assert.equal(status({ options: OPTS4, studentAnswer: { value: [0, 1] }, correctAnswer: [0, 1] }), 'correct');
    assert.equal(status({ options: OPTS4, studentAnswer: { lạ: 1 }, correctAnswer: 1 }), 'wrong');       // object không nhận ra: không crash, không đúng nhầm
});

test('ketqua.renderQuestionCard — nhiều đáp án sai vì thiếu/thừa: chọn đúng = xanh, chọn thừa = đỏ, bỏ sót = viền đáp án đúng', { skip: SKIP_FRONTEND }, () => {
    const card = k().renderQuestionCard({
        type: 'multiple_answer', text: 'Chọn số chẵn', options: OPTS4,
        studentAnswer: [0, 2], correctAnswer: [0, 1], isCorrect: false
    }, 0, { explanationVisible: false });
    const html = card.innerHTML;
    assert.equal(optClass(html, 'A'), 'xkq2-opt is-selected-correct');
    assert.equal(optClass(html, 'B'), 'xkq2-opt is-actual-correct');
    assert.equal(optClass(html, 'C'), 'xkq2-opt is-selected-wrong');
    assert.equal(optClass(html, 'D'), 'xkq2-opt');
    assert.match(card.className, /xkq2-q--wrong/);
});

test('ketqua.renderQuestionCard — object answer không in ra "[object Object]"', { skip: SKIP_FRONTEND }, () => {
    const card = k().renderQuestionCard({
        type: 'multiple_choice', text: 'Câu hỏi', options: [{ id: 'a', text: 'Phương án A' }, { id: 'b', text: 'Phương án B' }],
        studentAnswer: { id: 'a', text: 'Phương án A' }, correctAnswer: { id: 'b' }, isCorrect: false
    }, 0, { explanationVisible: false });
    assert.equal(card.innerHTML.includes('[object Object]'), false);
    assert.equal(optClass(card.innerHTML, 'A'), 'xkq2-opt is-selected-wrong');
    assert.equal(optClass(card.innerHTML, 'B'), 'xkq2-opt is-actual-correct');
});

test('ketqua — điền chỗ trống: mảng / object / chuỗi đơn / rỗng', { skip: SKIP_FRONTEND }, () => {
    const blanks = [{ acceptedAnswers: ['Hà Nội'] }, { acceptedAnswers: ['Paris'] }];
    const fill = (studentAnswer, extra = {}) => k().evaluateFillBlankQuestion({ type: 'fill_blank', blanks, studentAnswer, ...extra }).status;

    assert.equal(fill(['ha noi', 'PARIS']), 'correct');          // không phân biệt hoa/thường, dấu
    assert.equal(fill(['sai', 'Paris']), 'wrong');
    assert.equal(fill({ 0: 'Hà Nội', 1: 'Paris' }), 'correct');  // object { chỉ số: giá trị }
    assert.equal(fill({ 1: 'Paris', 0: 'Hà Nội' }), 'correct');  // thứ tự key không quan trọng
    assert.equal(fill([{ value: 'Hà Nội' }, { text: 'Paris' }]), 'correct');
    assert.equal(fill({}), 'skipped');
    assert.equal(fill(['', '  ']), 'skipped');
    assert.equal(fill(null), 'skipped');
    assert.equal(k().evaluateFillBlankQuestion({ type: 'fill_blank', blanks: [blanks[0]], studentAnswer: 'ha noi' }).status, 'correct');   // 1 chỗ trống, trả lời dạng chuỗi
    assert.equal(fill(['sai', 'sai'], { isCorrect: true }), 'correct');   // server đã chấm sẵn thì tin server

    const card = k().renderQuestionCard({ type: 'fill_blank', text: 'Điền', blanks, studentAnswer: { 0: 'Hà Nội', 1: 'Lyon' } }, 0, {});
    assert.equal(card.innerHTML.includes('[object Object]'), false);
    assert.match(card.innerHTML, /Đáp án đúng/);
});

/* ==========================================================================
   PHẦN 3 — payload của server -> thẻ render của client
   ========================================================================== */

async function renderAll(answers) {
    const res = await callGetResultDetail({ answers });
    const data = res.body;
    const cards = {};
    data.questions.forEach((q, i) => { cards[q.id] = k().renderQuestionCard(q, i, data); });
    return { data, cards };
}

test('server -> ketqua: làm ĐÚNG hết -> 6 thẻ "Đúng"', { skip: SKIP_FRONTEND }, async () => {
    const { cards } = await renderAll(ANSWERS_RIGHT);
    Object.entries(cards).forEach(([id, card]) => assert.match(card.className, /xkq2-q--correct/, `${id} phải hiện Đúng`));
    assert.equal(optClass(cards.q_multi.innerHTML, 'A'), 'xkq2-opt is-selected-correct');
    assert.equal(optClass(cards.q_multi.innerHTML, 'B'), 'xkq2-opt is-selected-correct');
    assert.match(cards.q_match.innerHTML, /2\/2 cặp đúng/);
    assert.match(cards.q_order.innerHTML, /3\/3 vị trí đúng/);
    assert.match(cards.q_dd.innerHTML, /3\/3 ô đúng/);
});

test('server -> ketqua: làm SAI hết -> 6 thẻ "Sai", hiện đáp án đúng, không có "[object Object]"', { skip: SKIP_FRONTEND }, async () => {
    const { cards } = await renderAll(ANSWERS_WRONG);
    Object.entries(cards).forEach(([id, card]) => {
        assert.match(card.className, /xkq2-q--wrong/, `${id} phải hiện Sai`);
        assert.equal(card.innerHTML.includes('[object Object]'), false, `${id} lộ [object Object]`);
        assert.equal(card.innerHTML.includes('undefined'), false, `${id} lộ "undefined"`);
        assert.match(card.innerHTML, /Đáp án đúng/, `${id} phải chỉ ra đáp án đúng`);
    });
    // nhiều đáp án [0,2] vs [0,1]: A chọn đúng, B bỏ sót, C chọn thừa
    assert.equal(optClass(cards.q_multi.innerHTML, 'A'), 'xkq2-opt is-selected-correct');
    assert.equal(optClass(cards.q_multi.innerHTML, 'B'), 'xkq2-opt is-actual-correct');
    assert.equal(optClass(cards.q_multi.innerHTML, 'C'), 'xkq2-opt is-selected-wrong');
    assert.match(cards.q_match.innerHTML, /0\/2 cặp đúng/);
    assert.match(cards.q_order.innerHTML, /1\/3 vị trí đúng/);     // chỉ vị trí C đúng
    assert.match(cards.q_dd.innerHTML, /0\/3 ô đúng/);
});

test('server -> ketqua: BỎ QUA hết -> 6 thẻ "Bỏ qua" (không phải "Sai")', { skip: SKIP_FRONTEND }, async () => {
    const { cards } = await renderAll(ANSWERS_EMPTY);
    Object.entries(cards).forEach(([id, card]) => {
        assert.doesNotMatch(card.className, /xkq2-q--(correct|wrong)/, `${id} không được tô Đúng/Sai`);
        assert.match(card.innerHTML, /Bỏ qua/, `${id} phải hiện Bỏ qua`);
    });
    assert.match(cards.q_order.innerHTML, /Thứ tự đúng/);
});
