'use strict';

/**
 * tests/grading.test.js — GĐ3.6 (hồi quy chấm điểm + làm sạch câu hỏi)
 *
 * Phạm vi: lib/grading.js (logic thuần, không cần Firebase). KHÔNG bao phủ
 * phần route trong server.js (cần Firebase Admin) và phần UI trình duyệt.
 *
 * Chạy:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeQuestionForClient,
    gradeSubmission,
    gradeOrdering,
    gradeFillBlank,
    gradeMatching,
    translateMatchingAnswer,
    toReviewQuestionServer
} = require('../lib/grading');

const SEED = 'exam1_stu1_q1';

const orderingQ = (extra = {}) => ({
    id: 'qo', type: 'ordering', score: 3,
    items: [{ id: 'b', text: 'Bước B' }, { id: 'a', text: 'Bước A' }, { id: 'c', text: 'Bước C' }],
    correctOrder: ['a', 'b', 'c'],
    ...extra
});
const mcQ = (id = 'qm', correct = 1) => ({ id, type: 'multiple_choice', score: 1, options: ['x', 'y', 'z'], correct_option: correct });
const fillQ = () => ({
    id: 'qf', type: 'fill_blank', score: 2,
    question_text: 'Thủ đô VN là ___ và sông là ___',
    blanks: [{ acceptedAnswers: ['Hà Nội', 'Ha Noi'] }, { acceptedAnswers: ['Sông Hồng'] }]
});

test('KHÔNG lộ đáp án xuống học sinh', async (t) => {
    await t.test('ordering: không có "correctOrder" ở bất kỳ đâu trong JSON gửi xuống', () => {
        const clean = sanitizeQuestionForClient(orderingQ(), SEED);
        assert.equal(JSON.stringify(clean).includes('correctOrder'), false);
    });

    await t.test('fill_blank: không lộ "acceptedAnswers" và không lộ nội dung đáp án', () => {
        const clean = sanitizeQuestionForClient(fillQ(), SEED);
        const json = JSON.stringify(clean);
        assert.equal(json.includes('acceptedAnswers'), false);
        assert.equal(json.includes('Hà Nội'), false);
        assert.equal(json.includes('Ha Noi'), false);
        assert.equal(json.includes('Sông Hồng'), false);
    });

    await t.test('fill_blank: vẫn giữ đúng SỐ chỗ trống để UI biết', () => {
        const clean = sanitizeQuestionForClient(fillQ(), SEED);
        assert.equal(clean.blanks.length, 2);
    });

    await t.test('fill_blank: cũng không lộ khi gọi không có seed', () => {
        const clean = sanitizeQuestionForClient(fillQ());
        assert.equal(JSON.stringify(clean).includes('acceptedAnswers'), false);
    });

    await t.test('trắc nghiệm: không lộ correct_option / answers[].correct / correctAnswer / explanation', () => {
        const clean = sanitizeQuestionForClient({
            id: 'q', type: 'multiple_choice', options: ['a', 'b'], correct_option: 1,
            answers: [{ text: 'a', correct: false }, { text: 'b', correct: true }],
            correctAnswer: 1, explanation: 'vì b'
        }, SEED);
        const json = JSON.stringify(clean);
        ['correct_option', '"correct"', 'correctAnswer', 'explanation', 'vì b'].forEach((s) => {
            assert.equal(json.includes(s), false, `lộ: ${s}`);
        });
    });

    await t.test('matching: cột phải không còn id thật', () => {
        const q = { id: 'qg', type: 'matching', pairs: [{ id: 'p1', left: 'A', right: '1' }, { id: 'p2', left: 'B', right: '2' }] };
        const clean = sanitizeQuestionForClient(q, SEED);
        clean.pairs.right.forEach((r) => assert.deepEqual(Object.keys(r).sort(), ['text', 'token']));
    });

    await t.test('ordering: xáo trộn xác định, đủ mục, khác thứ tự đáp án', () => {
        const a = sanitizeQuestionForClient(orderingQ(), SEED).items.map((i) => i.id);
        const b = sanitizeQuestionForClient(orderingQ(), SEED).items.map((i) => i.id);
        assert.deepEqual(a, b);
        assert.deepEqual([...a].sort(), ['a', 'b', 'c']);
        assert.notDeepEqual(a, ['a', 'b', 'c']);
    });
});

test('Ordering: chưa thao tác => Bỏ qua (KHÔNG phải Sai)', async (t) => {
    await t.test('không gửi answer cho câu ordering -> skipped, studentAnswer null, 0 điểm', () => {
        const r = gradeSubmission([orderingQ()], {});
        const d = r.details[0];
        assert.equal(d.skipped, true);
        assert.equal(d.studentAnswer, null);
        assert.equal(d.isCorrect, false);
        assert.equal(d.earnedPoints, 0);
        assert.equal(r.skippedCount, 1);
        assert.equal(r.incorrectCount, 0);
        assert.equal(r.correctCount, 0);
    });

    await t.test('gửi mảng rỗng -> cũng là Bỏ qua', () => {
        const r = gradeSubmission([orderingQ()], { qo: [] });
        assert.equal(r.details[0].skipped, true);
        assert.equal(r.skippedCount, 1);
    });

    await t.test('gửi giá trị rác (không phải mảng) -> Bỏ qua, không crash', () => {
        [null, 'abc', 5, { a: 1 }].forEach((junk) => {
            const r = gradeSubmission([orderingQ()], { qo: junk });
            assert.equal(r.details[0].skipped, true);
        });
    });

    await t.test('gradeOrdering trực tiếp: chưa trả lời -> skipped true', () => {
        assert.equal(gradeOrdering(orderingQ(), undefined).skipped, true);
        assert.equal(gradeOrdering(orderingQ(), undefined).studentAnswerNormalized, null);
    });
});

test('Ordering: có thao tác => chấm đúng/sai/từng phần, KHÔNG bị coi là Bỏ qua', async (t) => {
    await t.test('sắp SAI -> Sai (skipped=false), studentAnswer được lưu', () => {
        const r = gradeSubmission([orderingQ()], { qo: ['c', 'b', 'a'] });
        const d = r.details[0];
        assert.equal(d.skipped, false);
        assert.deepEqual(d.studentAnswer, ['c', 'b', 'a']);
        assert.equal(d.isCorrect, false);
        assert.equal(r.skippedCount, 0);
        assert.equal(r.incorrectCount, 1);
    });

    await t.test('sắp ĐÚNG -> trọn điểm', () => {
        const r = gradeSubmission([orderingQ()], { qo: ['a', 'b', 'c'] });
        assert.equal(r.details[0].isCorrect, true);
        assert.equal(r.details[0].skipped, false);
        assert.equal(r.earnedPoints, 3);
        assert.equal(r.correctCount, 1);
        assert.equal(r.score, 10);
    });

    await t.test('đúng 1/3 vị trí -> điểm từng phần, vẫn tính là Sai', () => {
        const r = gradeSubmission([orderingQ()], { qo: ['a', 'c', 'b'] });
        assert.equal(r.details[0].partialFraction, 1 / 3);
        assert.equal(r.details[0].earnedPoints, 1);
        assert.equal(r.incorrectCount, 1);
    });

    await t.test('dữ liệu cũ (chưa có correctOrder): dự phòng theo thứ tự mảng items', () => {
        const q = { id: 'qo', type: 'ordering', score: 1, items: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] };
        assert.equal(gradeSubmission([q], { qo: ['x', 'y'] }).details[0].isCorrect, true);
        assert.equal(gradeSubmission([q], { qo: ['y', 'x'] }).details[0].isCorrect, false);
    });
});

test('Thống kê: Đúng / Bỏ qua / Sai tách bạch', async (t) => {
    await t.test('bài hỗn hợp: đếm đúng từng nhóm và cộng lại bằng tổng số câu', () => {
        const qs = [
            mcQ('m1', 1),      // đúng
            mcQ('m2', 1),      // bỏ qua (không gửi)
            mcQ('m3', 1),      // sai
            orderingQ({ id: 'o1' }), // bỏ qua
            orderingQ({ id: 'o2' }), // sai
            orderingQ({ id: 'o3' }), // đúng
            fillQ()            // bỏ qua (không gửi)
        ];
        const r = gradeSubmission(qs, {
            m1: 1, m3: 0,
            o2: ['c', 'b', 'a'], o3: ['a', 'b', 'c']
        });
        assert.equal(r.correctCount, 2);
        assert.equal(r.skippedCount, 3);
        assert.equal(r.incorrectCount, 2);
        assert.equal(r.correctCount + r.skippedCount + r.incorrectCount, r.details.length);
    });

    await t.test('câu tự luận không bị tính vào Đúng/Sai/Bỏ qua', () => {
        const r = gradeSubmission([mcQ('m1', 1), { id: 'e1', type: 'essay', score: 1 }], { m1: 1, e1: 'bài làm' });
        assert.equal(r.details.length, 1);
        assert.equal(r.manualItems.length, 1);
        assert.equal(r.correctCount + r.skippedCount + r.incorrectCount, 1);
    });

    await t.test('fill_blank: trống hết = Bỏ qua; điền sai = Sai; điền đúng = Đúng', () => {
        assert.equal(gradeFillBlank(fillQ(), undefined).skipped, true);
        assert.equal(gradeFillBlank(fillQ(), ['', '  ']).skipped, true);
        const wrong = gradeFillBlank(fillQ(), ['Huế', 'Sông Đà']);
        assert.equal(wrong.skipped, false);
        assert.equal(wrong.fraction, 0);
        assert.equal(gradeFillBlank(fillQ(), ['ha noi', 'song hong']).fraction, 1);
    });

    await t.test('matching: không ghép = Bỏ qua; ghép sai = Sai', () => {
        const q = { id: 'qg', type: 'matching', pairs: [{ id: 'p1', left: 'A', right: '1' }, { id: 'p2', left: 'B', right: '2' }] };
        assert.equal(gradeMatching(q, undefined).skipped, true);
        assert.equal(gradeMatching(q, {}).skipped, true);
        const wrong = gradeMatching(q, { p1: 'p2', p2: 'p1' });
        assert.equal(wrong.skipped, false);
        assert.equal(wrong.fraction, 0);
    });
});

test('Hồi quy chấm điểm các loại câu khác', async (t) => {
    await t.test('trắc nghiệm đơn đúng/sai/bỏ qua', () => {
        const r = gradeSubmission([mcQ('a', 1), mcQ('b', 1), mcQ('c', 1)], { a: 1, b: 2 });
        assert.equal(r.correctCount, 1);
        assert.equal(r.incorrectCount, 1);
        assert.equal(r.skippedCount, 1);
    });

    await t.test('chọn nhiều: chỉ đúng khi tập đáp án giống hệt', () => {
        const q = { id: 'q', type: 'multiple_answer', options: ['a', 'b', 'c'], correct_option: [0, 2] };
        assert.equal(gradeSubmission([q], { q: [0, 2] }).details[0].isCorrect, true);
        assert.equal(gradeSubmission([q], { q: [0] }).details[0].isCorrect, false);
        assert.equal(gradeSubmission([q], { q: [] }).skippedCount, 1);
    });

    await t.test('matching: luồng đầy đủ gửi đề -> học sinh chọn token -> dịch ngược -> chấm 100%', () => {
        const q = { id: 'qg', type: 'matching', score: 2, pairs: [{ id: 'p1', left: 'A', right: '1' }, { id: 'p2', left: 'B', right: '2' }, { id: 'p3', left: 'C', right: '3' }] };
        const view = sanitizeQuestionForClient(q, SEED).pairs;
        const tokenOf = (text) => view.right.find((r) => r.text === text).token;
        const studentAnswer = { p1: tokenOf('1'), p2: tokenOf('2'), p3: tokenOf('3') };
        const translated = { qg: translateMatchingAnswer(q, studentAnswer, SEED) };
        const r = gradeSubmission([q], translated);
        assert.equal(r.details[0].isCorrect, true);
        assert.equal(r.earnedPoints, 2);
    });

    await t.test('score = null khi có câu chấm tay (chờ giáo viên)', () => {
        const r = gradeSubmission([mcQ('a', 1), { id: 'e', type: 'essay' }], { a: 1, e: 'x' });
        assert.equal(r.score, null);
        assert.equal(r.gradingStatus, 'pending');
    });
});

test('File ôn tập PDF/Word (toReviewQuestionServer)', async (t) => {
    await t.test('ordering: có "orderedItems" đúng thứ tự đáp án (theo correctOrder), đủ text', () => {
        const rv = toReviewQuestionServer(orderingQ(), true);
        assert.deepEqual(rv.orderedItems, [
            { id: 'a', text: 'Bước A' }, { id: 'b', text: 'Bước B' }, { id: 'c', text: 'Bước C' }
        ]);
        assert.equal(rv.type, 'ordering');
    });

    await t.test('ordering dữ liệu cũ (không correctOrder): dùng thứ tự mảng items', () => {
        const q = { id: 'q', type: 'ordering', items: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] };
        assert.deepEqual(toReviewQuestionServer(q, false).orderedItems.map((i) => i.text), ['X', 'Y']);
    });

    await t.test('ordering: correctOrder trỏ tới id không tồn tại -> text rỗng, không crash', () => {
        const q = orderingQ({ correctOrder: ['a', 'zzz', 'c'] });
        assert.deepEqual(toReviewQuestionServer(q, false).orderedItems.map((i) => i.text), ['Bước A', '', 'Bước C']);
    });

    await t.test('loại câu khác KHÔNG có "orderedItems"', () => {
        assert.equal('orderedItems' in toReviewQuestionServer(mcQ(), false), false);
    });

    await t.test('alias: type "ordering" được nhận diện qua normalizeQuestionType', () => {
        assert.ok(Array.isArray(toReviewQuestionServer(orderingQ(), false).orderedItems));
    });
});
