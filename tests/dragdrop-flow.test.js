'use strict';

/**
 * tests/dragdrop-flow.test.js — GĐ3.7B (luồng đầy đủ câu "Kéo-thả" qua lib/grading.js)
 *
 * Bổ sung cho tests/dragdrop.test.js (test đơn vị lib/dragdrop.js): kiểm tra các điểm nối
 * trong lib/grading.js mà server.js đang dùng:
 *   - sanitizeQuestionForClient(): KHÔNG lộ correctMap / explanation, có xáo thẻ, có seed cố định.
 *   - gradeSubmission(): điểm từng phần, thống kê Đúng / Sai / Bỏ qua, details lưu được vào Firestore.
 *   - buildDragDropResultView(): dữ liệu "Xem lại" dựng từ CHÍNH details vừa chấm.
 *   - toReviewQuestionServer(): dữ liệu file ôn tập.
 *
 * Chạy:  npm test   (hoặc: node --test tests)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeQuestionForClient,
    gradeSubmission,
    toReviewQuestionServer,
    buildDragDropResultView
} = require('../lib/grading');

function makeQuestion(overrides) {
    return {
        id: 'q1',
        type: 'drag_drop',
        question_text: 'Ghép quốc gia với thủ đô',
        score: 2,
        explanation: 'Thủ đô là nơi đặt cơ quan hành chính cao nhất.',
        dropZones: [
            { id: 'z1', label: 'Việt Nam' },
            { id: 'z2', label: 'Pháp' },
            { id: 'z3', label: 'Nhật Bản' }
        ],
        dragItems: [
            { id: 'i1', text: 'Hà Nội' },
            { id: 'i2', text: 'Paris' },
            { id: 'i3', text: 'Tokyo' },
            { id: 'i4', text: 'Bangkok' }
        ],
        correctMap: { z1: 'i1', z2: 'i2', z3: 'i3' },
        ...overrides
    };
}

const MC_QUESTION = {
    id: 'q2',
    type: 'multiple_choice',
    question_text: '1 + 1 = ?',
    options: ['1', '2'],
    correct_option: 1,
    score: 1
};

test('sanitizeQuestionForClient — câu Kéo-thả không lộ đáp án', async (t) => {
    const q = makeQuestion();

    await t.test('KHÔNG gửi "correctMap" và "explanation" xuống client', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.equal('correctMap' in clean, false);
        assert.equal('explanation' in clean, false);
        assert.equal(JSON.stringify(clean).includes('correctMap'), false);
    });

    await t.test('thẻ chỉ còn { id, text }, ô thả chỉ còn { id, label }, đủ mục, ô giữ nguyên thứ tự', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.deepEqual(clean.dragItems.map((it) => it.id).sort(), ['i1', 'i2', 'i3', 'i4']);
        clean.dragItems.forEach((it) => assert.deepEqual(Object.keys(it).sort(), ['id', 'text']));
        assert.deepEqual(clean.dropZones, [
            { id: 'z1', label: 'Việt Nam' },
            { id: 'z2', label: 'Pháp' },
            { id: 'z3', label: 'Nhật Bản' }
        ]);
    });

    await t.test('cùng seed -> cùng thứ tự thẻ (F5 không đổi thứ tự)', () => {
        const a = sanitizeQuestionForClient(q, 'exam1_stu1_q1').dragItems.map((it) => it.id);
        const b = sanitizeQuestionForClient(q, 'exam1_stu1_q1').dragItems.map((it) => it.id);
        assert.deepEqual(a, b);
    });

    await t.test('thứ tự các thẻ ĐÚNG không bao giờ trùng thứ tự ô (với 200 seed khác nhau)', () => {
        for (let n = 0; n < 200; n++) {
            const clean = sanitizeQuestionForClient(q, `exam1_stu${n}_q1`);
            const mappedInViewOrder = clean.dragItems.map((it) => it.id).filter((id) => ['i1', 'i2', 'i3'].includes(id));
            assert.notDeepEqual(mappedInViewOrder, ['i1', 'i2', 'i3'], `seed ${n}`);
        }
    });

    await t.test('không có seed (gọi kiểu cũ) -> ẩn hẳn thẻ và ô, vẫn không lộ correctMap', () => {
        const clean = sanitizeQuestionForClient(q);
        assert.deepEqual(clean.dragItems, []);
        assert.deepEqual(clean.dropZones, []);
        assert.equal('correctMap' in clean, false);
    });
});

test('gradeSubmission — câu Kéo-thả', async (t) => {
    const q = makeQuestion();

    await t.test('đúng hết -> 10 điểm, details ghi đủ thông tin để Xem lại', () => {
        const r = gradeSubmission([q], { q1: { z1: 'i1', z2: 'i2', z3: 'i3' } });
        assert.equal(r.score, 10);
        assert.equal(r.correctCount, 1);
        assert.equal(r.incorrectCount, 0);
        assert.equal(r.skippedCount, 0);
        assert.equal(r.gradingStatus, 'graded');
        assert.equal(r.hasManualItems, false);

        const d = r.details[0];
        assert.equal(d.questionId, 'q1');
        assert.equal(d.isCorrect, true);
        assert.equal(d.skipped, false);
        assert.equal(d.partialFraction, 1);
        assert.equal(d.points, 2);
        assert.equal(d.earnedPoints, 2);
        assert.deepEqual(d.dragTexts, {
            zones: { z1: 'Việt Nam', z2: 'Pháp', z3: 'Nhật Bản' },
            items: { i1: 'Hà Nội', i2: 'Paris', i3: 'Tokyo', i4: 'Bangkok' }
        });
    });

    await t.test('đúng 1/3 ô -> điểm từng phần, tính là Sai (không phải Bỏ qua)', () => {
        const r = gradeSubmission([q], { q1: { z1: 'i1', z2: 'i3' } });
        const d = r.details[0];
        assert.equal(d.isCorrect, false);
        assert.equal(d.skipped, false);
        assert.ok(Math.abs(d.partialFraction - 1 / 3) < 1e-9);
        assert.ok(Math.abs(d.earnedPoints - 2 / 3) < 1e-9);
        assert.equal(r.score, 3.3);
        assert.equal(r.correctCount, 0);
        assert.equal(r.incorrectCount, 1);
        assert.equal(r.skippedCount, 0);
    });

    await t.test('không làm câu này -> Bỏ qua, 0 điểm, studentAnswer = null', () => {
        const r = gradeSubmission([q], {});
        const d = r.details[0];
        assert.equal(d.skipped, true);
        assert.equal(d.studentAnswer, null);
        assert.equal(r.skippedCount, 1);
        assert.equal(r.incorrectCount, 0);
        assert.equal(r.score, 0);
    });

    await t.test('trong bài hỗn hợp: điểm cộng đúng theo trọng số từng câu', () => {
        const allRight = gradeSubmission([q, MC_QUESTION], { q1: { z1: 'i1', z2: 'i2', z3: 'i3' }, q2: 1 });
        assert.equal(allRight.score, 10);
        assert.equal(allRight.correctCount, 2);

        // Kéo-thả đúng 1/3 (2/3 điểm) + trắc nghiệm đúng (1 điểm) = 1.6667 / 3 điểm * 10 = 5.6
        const partial = gradeSubmission([q, MC_QUESTION], { q1: { z1: 'i1', z2: 'i3' }, q2: 1 });
        assert.equal(partial.score, 5.6);
        assert.equal(partial.correctCount, 1);
        assert.equal(partial.incorrectCount, 1);
    });

    await t.test('details không chứa giá trị undefined (Firestore từ chối undefined)', () => {
        [{ q1: { z1: 'i1', z2: 'i2', z3: 'i3' } }, { q1: { z1: 'i1' } }, {}].forEach((answers) => {
            const d = gradeSubmission([q], answers).details[0];
            Object.entries(d).forEach(([key, value]) => assert.notEqual(value, undefined, `details.${key}`));
        });
    });
});

test('buildDragDropResultView — dựng từ chính details vừa chấm', () => {
    const q = makeQuestion();
    const { details } = gradeSubmission([q], { q1: { z1: 'i1', z2: 'i3' } });
    const view = buildDragDropResultView(q, details[0]);

    assert.deepEqual(view.zones, [
        { label: 'Việt Nam', correctText: 'Hà Nội', studentText: 'Hà Nội', placed: true, isCorrect: true },
        { label: 'Pháp', correctText: 'Paris', studentText: 'Tokyo', placed: true, isCorrect: false },
        { label: 'Nhật Bản', correctText: 'Tokyo', studentText: '', placed: false, isCorrect: false }
    ]);
    assert.deepEqual(view.distractors, ['Bangkok']);
});

test('toReviewQuestionServer — file ôn tập câu Kéo-thả', () => {
    const review = toReviewQuestionServer(makeQuestion(), true);
    assert.equal(review.type, 'drag_drop');
    assert.deepEqual(review.options, []);
    assert.deepEqual(review.correctIndexes, []);
    assert.deepEqual(review.dragDropPairs, [
        { label: 'Việt Nam', text: 'Hà Nội' },
        { label: 'Pháp', text: 'Paris' },
        { label: 'Nhật Bản', text: 'Tokyo' }
    ]);
    assert.deepEqual(review.dragDropDistractors, ['Bangkok']);
    assert.equal(review.explanation, 'Thủ đô là nơi đặt cơ quan hành chính cao nhất.');
    assert.equal(review.score, 2);
});